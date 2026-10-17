// Disposable databases for the introspection tests: a database with a random name, loaded from tests/databases/*.sql,
// and roles with random passwords, dropped afterwards. Server tests need admin URLs of disposable servers
// (tests/databases/compose.yaml) in LSV_TEST_POSTGRES_URL, LSV_TEST_MYSQL_URL and LSV_TEST_MARIADB_URL.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { ROOT } from './helpers.js';

export const SQL = join(ROOT, 'tests', 'databases');
export type Server = 'postgres' | 'mysql' | 'mariadb';
export const VARIABLES: Readonly<Record<Server, string>> = {
    postgres: 'LSV_TEST_POSTGRES_URL',
    mysql: 'LSV_TEST_MYSQL_URL',
    mariadb: 'LSV_TEST_MARIADB_URL',
};

export function adminUrl(server: Server): string | undefined {
    const value = process.env[VARIABLES[server]];
    return value === undefined || value === '' ? undefined : value;
}

// Statements of a MySQL fixture, separated by ";\n", without comment lines.
export function statements(file: string): string[] {
    return readFileSync(join(SQL, file), 'utf8')
        .split(';\n')
        .map((s) =>
            s
                .split('\n')
                .filter((line) => !line.startsWith('--'))
                .join('\n')
                .trim(),
        )
        .filter((s) => s !== '');
}

function token(bytes: number): string {
    return randomBytes(bytes).toString('hex');
}

export interface Disposable {
    // The database (MySQL: also the default schema) name.
    name: string;
    // URLs of the admin and of each role.
    url(role?: 'reader' | 'writer'): string;
    passwords: Record<'reader' | 'writer', string>;
    roles: Record<'reader' | 'writer', string>;
    // Runs SQL as the admin on the disposable database.
    admin(sql: string): Promise<unknown[][]>;
    drop(): Promise<void>;
}

function withDatabase(url: string, database: string, user?: string, password?: string): string {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    if (user !== undefined && password !== undefined) {
        parsed.username = encodeURIComponent(user);
        parsed.password = encodeURIComponent(password);
    }
    return parsed.href;
}

// A disposable server database loaded from `files`, with a reader (PostgreSQL: CONNECT and USAGE only; MySQL:
// SELECT on the database) and a writer (one INSERT grant).
export async function serverDatabase(server: Server, files: string[]): Promise<Disposable> {
    const admin = adminUrl(server);
    if (admin === undefined) {
        throw new Error(`set ${VARIABLES[server]}`);
    }
    const suffix = token(4);
    const name = `lsv_node_${suffix}`;
    const roles = { reader: `lsv_reader_${suffix}`, writer: `lsv_writer_${suffix}` };
    const passwords = { reader: token(12), writer: token(12) };
    const url = (role?: 'reader' | 'writer'): string =>
        role === undefined ? withDatabase(admin, name) : withDatabase(admin, name, roles[role], passwords[role]);
    if (server === 'postgres') {
        const root = new pg.Client({ connectionString: admin });
        await root.connect();
        try {
            await root.query(`CREATE DATABASE "${name}"`);
            for (const role of ['reader', 'writer'] as const) {
                await root.query(`CREATE ROLE "${roles[role]}" LOGIN PASSWORD '${passwords[role]}'`);
                await root.query(`GRANT CONNECT ON DATABASE "${name}" TO "${roles[role]}"`);
            }
        } finally {
            await root.end();
        }
        const run = async (sql: string): Promise<unknown[][]> => {
            const client = new pg.Client({ connectionString: url() });
            await client.connect();
            try {
                // A script of several statements returns one result per statement.
                const result: unknown = await client.query<unknown[]>({ text: sql, rowMode: 'array' });
                return Array.isArray(result) ? [] : (result as { rows: unknown[][] }).rows;
            } finally {
                await client.end();
            }
        };
        for (const file of files) {
            await run(readFileSync(join(SQL, file), 'utf8'));
        }
        const schemas = (await run("SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'billing')")).map((r) => `"${String(r[0])}"`);
        for (const role of ['reader', 'writer'] as const) {
            await run(`GRANT USAGE ON SCHEMA ${schemas.join(', ')} TO "${roles[role]}"`);
        }
        if (schemas.includes('"billing"')) {
            await run(`GRANT INSERT ON billing.invoices TO "${roles.writer}"`);
        } else {
            await run(`GRANT INSERT ON ALL TABLES IN SCHEMA public TO "${roles.writer}"`);
        }
        return {
            name,
            url,
            passwords,
            roles,
            admin: run,
            async drop() {
                const client = new pg.Client({ connectionString: admin });
                await client.connect();
                try {
                    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
                    for (const role of Object.values(roles)) {
                        await client.query(`DROP ROLE IF EXISTS "${role}"`);
                    }
                } finally {
                    await client.end();
                }
            },
        };
    }
    const connect = (database?: string): Promise<mysql.Connection> => mysql.createConnection(database === undefined ? admin : withDatabase(admin, database));
    const root = await connect();
    try {
        await root.query(`CREATE DATABASE \`${name}\``);
        for (const role of ['reader', 'writer'] as const) {
            await root.query(`CREATE USER '${roles[role]}'@'%' IDENTIFIED BY '${passwords[role]}'`);
        }
        await root.query(`GRANT SELECT ON \`${name}\`.* TO '${roles.reader}'@'%'`);
        await root.query(`GRANT SELECT, INSERT ON \`${name}\`.* TO '${roles.writer}'@'%'`);
    } finally {
        await root.end();
    }
    const run = async (sql: string): Promise<unknown[][]> => {
        const connection = await connect(name);
        try {
            const [rows] = await connection.query({ sql, rowsAsArray: true });
            return Array.isArray(rows) ? (rows as unknown[][]) : [];
        } finally {
            await connection.end();
        }
    };
    for (const file of files) {
        for (const statement of statements(file)) {
            await run(statement);
        }
    }
    return {
        name,
        url,
        passwords,
        roles,
        admin: run,
        async drop() {
            const connection = await connect();
            try {
                await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
                for (const role of Object.values(roles)) {
                    await connection.query(`DROP USER IF EXISTS '${role}'@'%'`);
                }
            } finally {
                await connection.end();
            }
        },
    };
}

export interface SqliteFile {
    directory: string;
    path: string;
    url: string;
    drop(): void;
}

export function sqliteDatabase(files: string[]): SqliteFile {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'lsv-sqlite-')));
    const path = join(directory, 'schema.db');
    const database = new DatabaseSync(path);
    for (const file of files) {
        database.exec(readFileSync(join(SQL, file), 'utf8'));
    }
    database.close();
    return {
        directory,
        path,
        url: `sqlite:${path}`,
        drop() {
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
