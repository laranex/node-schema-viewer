// Read-only database sessions for the introspection worker. A port of python-schema-viewer's introspection/readonly.py.
//
// Guaranteed by the database: PostgreSQL and MySQL/MariaDB sessions run every transaction READ ONLY (set when the
// connection opens and verified before any catalog is read), and SQLite files are opened read-only (never created)
// with PRAGMA query_only. The transaction is rolled back, never committed.
//
// Checked before inspecting: the role's privileges (privilegeProblems). Defense in depth: every statement passes the
// catalog allowlist (statements.ts) before it reaches the driver.
import { str, type Row } from './common.js';
import { IntrospectionError, parseUrl, type Dialect } from './request.js';
import { assertCatalogStatement, mysqlGrantProblems } from './statements.js';

export interface Session {
    dialect: Dialect;
    mariadb: boolean;
    // The server version as numbers, such as [8, 4, 6].
    version: number[];
    // Runs one catalog statement and returns its rows as arrays. Placeholders: $1 (PostgreSQL) or ? (MySQL, SQLite).
    rows(sql: string, params?: readonly unknown[]): Promise<Row[]>;
    // Rolls back and disconnects.
    close(): Promise<void>;
    // The driver's own connection, past the statement allowlist. Never used by the worker; the tests use it to show
    // that the database itself refuses writes in these sessions.
    readonly driver: unknown;
}

export async function openSession(url: string, statementTimeout: number): Promise<Session> {
    const { dialect, path } = parseUrl(url);
    let session: Session;
    if (dialect === 'postgresql') {
        session = await postgresql(url, statementTimeout);
    } else if (dialect === 'mysql') {
        session = await mysql(url, statementTimeout);
    } else {
        session = await sqlite(path ?? '');
    }
    let verified: boolean;
    try {
        verified = await readOnly(session, statementTimeout);
    } catch (error) {
        await session.close();
        throw error;
    }
    if (!verified) {
        await session.close();
        throw new IntrospectionError('The database did not confirm a read-only transaction; nothing was inspected');
    }
    return session;
}

function connectError(error: unknown): IntrospectionError {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    return new IntrospectionError(`Could not connect to the database: ${name}: ${message}`);
}

async function readOnly(session: Session, statementTimeout: number): Promise<boolean> {
    if (session.dialect === 'postgresql') {
        await session.rows('BEGIN');
        await session.rows('SET TRANSACTION READ ONLY');
        return (await session.rows('SHOW transaction_read_only'))[0]?.[0] === 'on';
    }
    if (session.dialect === 'mysql') {
        if (session.mariadb) {
            await session.rows(`SET SESSION max_statement_time = ${String(statementTimeout)}`);
        } else {
            await session.rows(`SET SESSION max_execution_time = ${String(Math.trunc(statementTimeout * 1000))}`);
        }
        await session.rows('START TRANSACTION READ ONLY');
        for (const statement of ['SELECT @@session.transaction_read_only', 'SELECT @@session.tx_read_only']) {
            try {
                return Number((await session.rows(statement))[0]?.[0] ?? 0) === 1;
            } catch {
                // Variable names differ across versions.
            }
        }
        return false;
    }
    await session.rows('PRAGMA query_only = 1');
    return Number((await session.rows('PRAGMA query_only'))[0]?.[0]) === 1;
}

async function postgresql(url: string, statementTimeout: number): Promise<Session> {
    const { default: pg } = await import('pg');
    const milliseconds = Math.trunc(statementTimeout * 1000);
    const client = new pg.Client({
        connectionString: url,
        options:
            `-c default_transaction_read_only=on -c statement_timeout=${String(milliseconds)} ` +
            `-c lock_timeout=${String(Math.min(milliseconds, 5000))} -c idle_in_transaction_session_timeout=60000`,
        application_name: 'node-schema-viewer',
        connectionTimeoutMillis: 10000,
        query_timeout: milliseconds + 5000,
    });
    client.on('error', () => {
        // A dropped connection fails the pending query, which reports it.
    });
    try {
        await client.connect();
    } catch (error) {
        throw connectError(error);
    }
    const rows = async (sql: string, params: readonly unknown[] = []): Promise<Row[]> => {
        assertCatalogStatement(sql);
        const result = await client.query<Row>({ text: sql, values: [...params], rowMode: 'array' });
        return result.rows;
    };
    const version = Number((await rows('SHOW server_version_num'))[0]?.[0] ?? 0);
    return {
        dialect: 'postgresql',
        mariadb: false,
        version: [Math.trunc(version / 10000), version % 10000],
        rows,
        driver: client,
        async close() {
            try {
                await rows('ROLLBACK');
            } catch {
                // The connection is going away anyway.
            } finally {
                await client.end().catch(() => undefined);
            }
        },
    };
}

async function mysql(url: string, statementTimeout: number): Promise<Session> {
    const { default: driver } = await import('mysql2/promise');
    const parsed = new URL(url);
    const ssl = parsed.searchParams.get('ssl');
    if (ssl !== null && !['true', '1', 'required'].includes(ssl)) {
        throw new IntrospectionError('The ssl parameter of a MySQL URL may only be true (verified TLS)');
    }
    const decode = (value: string): string => decodeURIComponent(value);
    let connection: Awaited<ReturnType<typeof driver.createConnection>>;
    try {
        connection = await driver.createConnection({
            host: parsed.hostname.replace(/^\[|\]$/g, '') || 'localhost',
            port: parsed.port === '' ? 3306 : Number(parsed.port),
            user: decode(parsed.username),
            password: decode(parsed.password),
            database: decode(parsed.pathname.replace(/^\//, '')),
            connectTimeout: 10000,
            // No generated row parsers: the worker refuses code generation from strings.
            disableEval: true,
            multipleStatements: false,
            rowsAsArray: true,
            supportBigNumbers: true,
            bigNumberStrings: true,
            dateStrings: true,
            charset: 'utf8mb4',
            ...(ssl === null ? {} : { ssl: { rejectUnauthorized: true } }),
        });
    } catch (error) {
        throw connectError(error);
    }
    connection.on('error', () => {
        // Reported by the pending query.
    });
    const timeout = Math.trunc(statementTimeout * 1000) + 5000;
    const rows = async (sql: string, params: readonly unknown[] = []): Promise<Row[]> => {
        assertCatalogStatement(sql);
        const [result] = await connection.query({ sql, values: [...params], timeout, rowsAsArray: true });
        return Array.isArray(result) ? (result as Row[]) : [];
    };
    await rows('SET SESSION TRANSACTION READ ONLY');
    const raw = str((await rows('SELECT VERSION()'))[0]?.[0]);
    const { version, mariadb } = serverVersion(raw);
    return {
        dialect: 'mysql',
        mariadb,
        version,
        rows,
        driver: connection,
        async close() {
            try {
                await rows('ROLLBACK');
            } catch {
                // The connection is going away anyway.
            } finally {
                await connection.end().catch(() => undefined);
            }
        },
    };
}

// SQLAlchemy's MySQL version parsing: MariaDB's own numbers come before its "MariaDB" token.
export function serverVersion(value: string): { version: number[]; mariadb: boolean } {
    const version: number[] = [];
    let mariadbVersion: number[] | null = null;
    for (const token of value.split(/[.\-+]/)) {
        const match = /^(?:(\d+)[abc]?|(MariaDB\w*))$/.exec(token);
        if (match === null) {
            continue;
        }
        if (match[2] !== undefined) {
            mariadbVersion = version.slice(-3);
        } else {
            version.push(Number(match[1]));
        }
    }
    return { version: mariadbVersion ?? version, mariadb: mariadbVersion !== null };
}

async function sqlite(path: string): Promise<Session> {
    const { DatabaseSync } = await import('node:sqlite');
    let database: InstanceType<typeof DatabaseSync>;
    try {
        // readOnly: SQLite refuses every write and never creates the file.
        database = new DatabaseSync(path, { readOnly: true });
    } catch (error) {
        throw connectError(error);
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- the same asynchronous contract as the server drivers
    const rows = async (sql: string, params: readonly unknown[] = []): Promise<Row[]> => {
        assertCatalogStatement(sql);
        const statement = database.prepare(sql);
        return statement.all(...(params as (string | number | null)[])).map((row) => Object.values(row));
    };
    const version = str((await rows('SELECT sqlite_version()'))[0]?.[0]);
    return {
        dialect: 'sqlite',
        mariadb: false,
        version: version.split('.').map(Number),
        rows,
        driver: database,
        close() {
            database.close();
            return Promise.resolve();
        },
    };
}

// What the role could do beyond reading the catalogs. An empty list means a read-only role.
export async function privilegeProblems(session: Session, schemas: readonly string[]): Promise<string[]> {
    if (session.dialect === 'postgresql') {
        return postgresqlProblems(session, schemas);
    }
    if (session.dialect === 'mysql') {
        const grants = await session.rows('SHOW GRANTS');
        return mysqlGrantProblems(grants.map((row) => String(row[0])));
    }
    // SQLite has no roles; the file is opened read-only.
    return [];
}

async function postgresqlProblems(session: Session, schemas: readonly string[]): Promise<string[]> {
    const problems: string[] = [];
    const role =
        (
            await session.rows(
                'SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication, ' +
                    "has_database_privilege(current_database(), 'CREATE') FROM pg_roles r WHERE r.rolname = current_user",
            )
        )[0] ?? [];
    const labels = ['is a superuser', 'can create roles', 'can create databases', 'bypasses row security', 'can replicate', 'can create schemas'];
    labels.forEach((label, n) => {
        if (role[n + 1] === true) {
            problems.push(`role ${String(role[0])} ${label}`);
        }
    });
    const owned = await session.rows(
        'SELECT n.nspname FROM pg_namespace n WHERE n.nspname = ANY($1::text[]) ' +
            "AND (has_schema_privilege(n.oid, 'CREATE') OR pg_has_role(n.nspowner, 'USAGE')) ORDER BY 1",
        [schemas],
    );
    problems.push(...owned.map((row) => `can create objects in or owns schema ${String(row[0])}`));
    const tables = (
        await session.rows(
            "SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (pg_has_role(c.relowner, 'USAGE') " +
                "OR has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) ORDER BY 1 LIMIT 6",
            [schemas],
        )
    ).map((row) => String(row[0]));
    if (tables.length > 0) {
        problems.push(`can change or owns tables (${tables.slice(0, 5).join(', ')}${tables.length > 5 ? ', ...' : ''})`);
    }
    return problems;
}

