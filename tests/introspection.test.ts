// Live database introspection: accuracy, read-only enforcement, role checks, and separation from application code.
// Mirrors python-schema-viewer's tests/test_introspection.py.
//
// SQLite tests always run. Server tests need disposable servers (tests/databases/compose.yaml) and admin URLs:
//
//     docker compose -f tests/databases/compose.yaml up -d
//     export LSV_TEST_POSTGRES_URL=postgresql://postgres:lsv-admin@127.0.0.1:55432/lsv
//     export LSV_TEST_MYSQL_URL=mysql://root:lsv-admin@127.0.0.1:53306/lsv
//     export LSV_TEST_MARIADB_URL=mysql://root:lsv-admin@127.0.0.1:53307/lsv
//
// Each suite creates its own database and roles with random names and passwords, and drops them afterwards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test, type TestContext } from 'node:test';
import type { SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { diagnosticId, validateDocument } from 'laranex-schema-viewer-ui/contract';
import { scratchDirectory } from '../src/isolation/runner.js';
import { introspect, introspectAll, IntrospectionError, type DatabaseRequest } from '../src/introspection/index.js';
import { openSession, serverVersion, type Session } from '../src/introspection/readonly.js';
import { parseUrl, scrub } from '../src/introspection/request.js';
import { buildInvocation, type Invocation } from '../src/introspection/runner.js';
import { mysqlGrantProblems, STATEMENT } from '../src/introspection/statements.js';
import { adminUrl, serverDatabase, sqliteDatabase, type Disposable, type Server, type SqliteFile } from './databases.js';
import { assertProducerDocument, ROOT, tempDir } from './helpers.js';

type Table = SchemaDocument['connections'][number]['tables'][number];

function tables(document: SchemaDocument): Record<string, Table> {
    return Object.fromEntries(document.connections.flatMap((c) => c.tables.map((t) => [t.name, t])));
}

function byName<T extends { name: string | null }>(items: T[]): Record<string, T> {
    return Object.fromEntries(items.map((i) => [i.name ?? '', i]));
}

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function rejects(promise: Promise<unknown>, pattern: RegExp, secret?: string): Promise<IntrospectionError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof IntrospectionError, String(error));
        assert.match(error.message, pattern);
        if (secret !== undefined) {
            assert.ok(!error.message.includes(secret), error.message);
        }
        return error;
    }
    assert.fail(`expected ${String(pattern)}`);
}

describe('statement allowlist', () => {
    test('only catalog statements pass', () => {
        for (const allowed of [
            'SELECT 1',
            '  select c.relname from pg_class c',
            'SHOW transaction_read_only',
            'SET SESSION max_execution_time = 30000',
            'PRAGMA index_list("notes")',
            'PRAGMA query_only = 1',
            'WITH x AS (SELECT 1) SELECT * FROM x',
            'BEGIN',
            'START TRANSACTION READ ONLY',
            'ROLLBACK',
        ]) {
            assert.ok(STATEMENT.test(allowed), allowed);
        }
        for (const refused of [
            'INSERT INTO t VALUES (1)',
            'CREATE TABLE t (x int)',
            'DROP TABLE t',
            'UPDATE t SET x = 1',
            'DELETE FROM t',
            'PRAGMA user_version = 5',
            'PRAGMA query_only = 0',
            'VACUUM',
            'ALTER TABLE t ADD y int',
            'GRANT ALL ON t TO u',
            "COPY t FROM '/tmp/x'",
            'CALL p()',
            'SET GLOBAL read_only = 0',
            'TRUNCATE t',
            'PRAGMA journal_mode = WAL',
            'COMMIT',
        ]) {
            assert.ok(!STATEMENT.test(refused), refused);
        }
    });

    test('MySQL grants: only read privileges pass', () => {
        assert.deepEqual(mysqlGrantProblems(['GRANT USAGE ON *.* TO `r`@`%`', 'GRANT SELECT, SHOW VIEW ON `app`.* TO `r`@`%`']), []);
        assert.deepEqual(mysqlGrantProblems(['GRANT SELECT, INSERT ON `app`.* TO `w`@`%`']), ['has INSERT on `app`.*']);
        assert.deepEqual(mysqlGrantProblems(['GRANT SELECT ON `app`.`t` TO `r`@`%` WITH GRANT OPTION']), ['has GRANT OPTION on `app`.`t`']);
        // As in python-schema-viewer, column lists split the privilege list, so column grants are refused, not missed.
        assert.deepEqual(mysqlGrantProblems(['GRANT SELECT (`a`, `b`) ON `app`.`t` TO `r`@`%`']), ['has SELECT (`A`, `B`) on `app`.`t`']);
        assert.deepEqual(mysqlGrantProblems(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`']), ['has ALL PRIVILEGES on *.*']);
        assert.match(mysqlGrantProblems(['GRANT `app_role`@`%` TO `r`@`%`'])[0] ?? '', /role whose privileges cannot be verified/);
    });

    test('server versions parse as SQLAlchemy parses them', () => {
        assert.deepEqual(serverVersion('8.4.6'), { version: [8, 4, 6], mariadb: false });
        assert.deepEqual(serverVersion('11.4.8-MariaDB-ubu2404'), { version: [11, 4, 8], mariadb: true });
        assert.deepEqual(serverVersion('5.5.5-10.11.6-MariaDB-log'), { version: [10, 11, 6], mariadb: true });
    });
});

describe('URLs', () => {
    test('passwords are scrubbed from messages', () => {
        const url = 'postgresql://reader:s3cr3t-pw@db.internal/app';
        const message = scrub(`failed for ${url}: password s3cr3t-pw rejected`, url);
        assert.ok(!message.includes('s3cr3t-pw'));
        assert.match(message, /<database url>/);
        assert.ok(!scrub('p%40ss-word and p@ss-word', 'mysql://u:p%40ss-word@h/db').includes('ss-word'));
        // Very short passwords are not masked; they would hide fragments of ordinary words.
        assert.equal(scrub('abc', 'mysql://u:abc@h/db'), 'abc');
    });

    test('unsupported URLs fail clearly without echoing them', async () => {
        await rejects(introspect({ url: 'oracle://u:secret-pw@h/db' }), /not supported/, 'secret-pw');
        await rejects(introspect({ url: 'postgresql+psycopg://u:secret-pw@h/db' }), /plain scheme/, 'secret-pw');
        await rejects(introspect({ url: 'not a url' }), /not a valid URL/);
        await rejects(introspect({ url: 'postgresql://u:secret-pw@h/db?options=-c%20default_transaction_read_only%3Doff' }), /"options" is not supported/, 'secret-pw');
        await rejects(introspect({ url: 'postgresql://u:secret-pw@h/db?sslrootcert=/etc/ca.pem' }), /"sslrootcert" is not supported/, 'secret-pw');
        await rejects(introspect({ url: 'mysql://u:secret-pw@h' }), /needs a database name/, 'secret-pw');
        await rejects(introspect({ url: 'sqlite::memory:' }), /existing database file/);
        await rejects(introspect({ url: 'sqlite://host/x.db' }), /without a host/);
        await rejects(introspect({ url: 'sqlite:/x.db', timeout: 0 }), /positive number/);
        await rejects(introspectAll([{ url: 'sqlite:/a.db' }, { url: 'sqlite:/b.db' }]), /distinct name/);
        assert.deepEqual(parseUrl('mariadb://u:p%40w@h:1/db'), { dialect: 'mysql', password: 'p@w', path: null });
        assert.equal(parseUrl('sqlite:///tmp/a%20b.db').path, '/tmp/a b.db');
    });
});

describe('SQLite introspection', () => {
    let database: SqliteFile;
    let before_: string;
    let document: SchemaDocument;

    before(async () => {
        database = sqliteDatabase(['sqlite.sql']);
        before_ = sha256(database.path);
        document = await introspect({ url: database.url });
    });
    after(() => {
        database.drop();
    });

    test('is a strictly valid database document', () => {
        assertProducerDocument(document);
        assert.equal(document.source, 'database');
        const connection = document.connections[0];
        assert.equal(connection?.driver, 'sqlite');
        assert.equal(connection.coverage.declared, null);
        const features = connection.coverage.database?.features;
        assert.equal(features?.comments, 'not_applicable');
        assert.equal(features.checkConstraints, 'partial');
    });

    test('the database file is unchanged and nothing is created beside it', () => {
        assert.equal(sha256(database.path), before_);
        assert.deepEqual(readdirSync(database.directory), ['schema.db']);
    });

    test('composite keys and foreign keys', () => {
        const found = tables(document);
        assert.deepEqual(found.tags?.primaryKey, ['note_id', 'name']);
        const fk = found.tag_links?.foreignKeys[0];
        assert.deepEqual([fk?.columns, fk?.foreignColumns], [['note_id', 'tag'], ['note_id', 'name']]);
        assert.deepEqual([fk?.deferrable, fk?.initially], [true, 'DEFERRED']);
        assert.equal(found.tags.foreignKeys[0]?.onDelete, 'CASCADE');
        assert.equal(document.links.length, 2);
    });

    test('indexes', () => {
        const indexes = byName(tables(document).notes?.indexes ?? []);
        assert.equal(indexes.notes_active_title?.predicate, 'archived = 0');
        assert.equal(indexes.notes_lower_title?.parts[0]?.expression, 'lower(title)');
        const nocase = indexes.notes_title_nocase?.parts[0];
        assert.deepEqual([nocase?.collation, nocase?.order], ['NOCASE', 'desc']);
        assert.equal(indexes.notes_active_title.parts[0]?.collation, null);
        assert.equal(indexes.sqlite_autoindex_notes_1?.backs?.kind, 'unique_constraint');
        const primary = byName(tables(document).tags?.indexes ?? []).sqlite_autoindex_tags_1;
        assert.deepEqual([primary?.backs?.kind, primary?.parts.map((p) => p.column)], ['primary_key', ['note_id', 'name']]);
        assert.ok(!('primary' in (primary ?? {})) && !('columns' in (primary ?? {})));
    });

    test('columns and constraints', () => {
        const notes = tables(document).notes;
        const archived = byName(notes?.columns ?? []).archived;
        assert.deepEqual([archived?.default, archived?.nullable], [{ kind: 'literal', value: '0' }, false]);
        assert.equal(byName(notes?.columns ?? []).id?.autoIncrement, true);
        const check = byName(notes?.constraints ?? []).notes_archived_flag;
        assert.deepEqual([check?.columns, check?.expression], [['archived'], 'archived IN (0, 1)']);
    });

    test('missing files are not created', async (t) => {
        const directory = tempDir(t);
        const missing = join(directory, 'missing.db');
        await rejects(introspect({ url: `sqlite:${missing}` }), /does not exist; nothing was created/);
        // The worker's own open is read-only too: it never creates the file.
        await assert.rejects(openSession(`sqlite:${missing}`, 5), /Could not connect/);
        assert.equal(existsSync(missing), false);
        await rejects(introspect({ url: `sqlite:${directory}` }), /not a regular file/);
    });

    test('the connection cannot write', async () => {
        const session = await openSession(database.url, 5);
        try {
            await assert.rejects(session.rows('DELETE FROM notes'), /not a catalog read/);
            await assert.rejects(session.rows('PRAGMA query_only = 0'), /not a catalog read/);
            // Past the statement allowlist, SQLite itself refuses: the file was opened read-only.
            const driver = session.driver as { exec(sql: string): void };
            assert.throws(() => {
                driver.exec('CREATE TABLE pwned (x)');
            }, /readonly|read-only/);
        } finally {
            await session.close();
        }
        assert.equal(sha256(database.path), before_);
    });
});

describe('separation from the project', () => {
    // A project with hostile shadows of what the worker loads, a .env and a database file.
    function project(t: TestContext): string {
        const directory = tempDir(t);
        const hostile = readFileSync(join(ROOT, 'tests', 'fixtures', 'introspection', 'hostile.cjs'), 'utf8');
        for (const name of ['pg', 'mysql2', 'laranex-schema-viewer-ui', 'node-schema-viewer']) {
            const module = join(directory, 'node_modules', name);
            mkdirSync(module, { recursive: true });
            writeFileSync(join(module, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js', exports: { '.': './index.js', './*': './index.js' } }));
            writeFileSync(join(module, 'index.js'), hostile);
        }
        writeFileSync(join(directory, 'hostile.cjs'), hostile);
        writeFileSync(join(directory, '.env'), 'DATABASE_URL=postgresql://app:project-secret@db/app\n');
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'project', type: 'module' }));
        return realpathSync(directory);
    }

    test('the worker never loads project modules, from any working directory or NODE_PATH', async (t) => {
        const directory = project(t);
        const database = join(directory, 'app.db');
        const source = sqliteDatabase(['drift-sqlite.sql']);
        copyFileSync(source.path, database);
        source.drop();
        const cwd = process.cwd();
        const saved = process.env.NODE_PATH;
        process.chdir(directory);
        process.env.NODE_PATH = join(directory, 'node_modules');
        let seen: Invocation | undefined;
        try {
            const document = await introspect({ url: 'sqlite:app.db' }, { observe: (i) => (seen = i) });
            assert.ok(Object.keys(tables(document)).includes('users'));
        } finally {
            process.chdir(cwd);
            if (saved === undefined) {
                delete process.env.NODE_PATH;
            } else {
                process.env.NODE_PATH = saved;
            }
        }
        assert.equal(existsSync(join(directory, 'loaded-marker')), false);
        assert.ok(seen !== undefined);
        assert.ok(!('NODE_PATH' in seen.env));
        assert.ok(seen.args.every((arg) => !arg.startsWith('--allow-fs') || !arg.endsWith(directory)), 'the project is never granted');
        assert.notEqual(seen.cwd, directory);
    });

    test('under the runner\'s flags, project files and modules are ERR_ACCESS_DENIED', async (t) => {
        const directory = project(t);
        const scratch = scratchDirectory('lsv-introspect-test-');
        t.after(() => {
            rmSync(scratch, { recursive: true, force: true });
        });
        for (const name of ['home', 'tmp', 'out', 'work']) {
            mkdirSync(join(scratch, name));
        }
        const probe = join(ROOT, 'build', 'tests', 'fixtures', 'introspection', 'probe.mjs');
        mkdirSync(join(ROOT, 'build', 'tests', 'fixtures', 'introspection'), { recursive: true });
        copyFileSync(join(ROOT, 'tests', 'fixtures', 'introspection', 'probe.mjs'), probe);
        const invocation = buildInvocation(scratch, { url: '', schemas: [], connection: 'default', allowWritePrivileges: false, statementTimeout: 5 }, probe);
        const { runWorker } = await import('../src/isolation/runner.js');
        const run = await runWorker(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            env: invocation.env,
            input: JSON.stringify({ file: join(directory, '.env'), module: join(directory, 'hostile.cjs') }),
            log: join(scratch, 'log'),
            timeoutMs: 30_000,
        });
        assert.equal(run.code, 0, readFileSync(join(scratch, 'log'), 'utf8'));
        const outcome = JSON.parse(readFileSync(join(scratch, 'out', 'result.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(outcome.read, 'ERR_ACCESS_DENIED');
        assert.equal(outcome.import, 'ERR_ACCESS_DENIED');
        // The package's own drivers do load.
        assert.equal(outcome.pg, 'ok');
        assert.equal(existsSync(join(directory, 'loaded-marker')), false);
    });

    test('the URL travels on stdin only; credentials in the environment are withheld', async (t) => {
        const database = sqliteDatabase(['sqlite.sql']);
        t.after(() => {
            database.drop();
        });
        const secret = 'env-secret-value';
        const saved = { ...process.env };
        Object.assign(process.env, { DATABASE_URL: `postgresql://u:${secret}@h/db`, PGPASSWORD: secret, AWS_SECRET_ACCESS_KEY: secret, NODE_OPTIONS: '--allow-addons' });
        let seen: Invocation | undefined;
        let workingDirectory: string[] = ['not observed'];
        try {
            await introspect(
                { url: database.url },
                {
                    observe: (i) => {
                        seen = i;
                        workingDirectory = readdirSync(i.cwd);
                    },
                },
            );
        } finally {
            for (const name of ['DATABASE_URL', 'PGPASSWORD', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS']) {
                if (saved[name] === undefined) {
                    Reflect.deleteProperty(process.env, name);
                } else {
                    process.env[name] = saved[name];
                }
            }
        }
        assert.ok(seen !== undefined);
        const visible = JSON.stringify([seen.args, seen.env]);
        for (const value of [secret, database.path, 'schema.db']) {
            assert.ok(!visible.includes(value), value);
        }
        assert.ok(seen.input.includes('schema.db'));
        assert.ok(Object.keys(seen.env).every((name) => /^(PATH|LANG|LANGUAGE|TZ|LC_\w+|HOME|USERPROFILE|TMPDIR|TEMP|TMP|SSL_CERT_\w+|NODE_EXTRA_CA_CERTS|PGSSL\w+|PGGSSENCMODE|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT)$/i.test(name)), Object.keys(seen.env).join());
        assert.ok(seen.args.includes('--permission'));
        assert.ok(seen.args.includes('--no-addons'));
        assert.ok(seen.args.includes('--disallow-code-generation-from-strings'));
        assert.equal(seen.args.includes('--allow-net'), process.allowedNodeEnvironmentFlags.has('--allow-net'));
        for (const flag of ['--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi']) {
            assert.ok(!seen.args.includes(flag), flag);
        }
        assert.deepEqual(workingDirectory, []);
        const writes = seen.args.filter((a) => a.startsWith('--allow-fs-write=')).map((a) => a.slice('--allow-fs-write='.length));
        assert.equal(writes.length, 3);
    });

    test('a PostgreSQL URL is never in the arguments or environment', async () => {
        let seen: Invocation | undefined;
        const url = 'postgresql://reader:url-secret-pw@127.0.0.1:1/app';
        await rejects(introspect({ url, timeout: 30 }, { observe: (i) => (seen = i) }), /Could not connect/, 'url-secret-pw');
        assert.ok(seen !== undefined);
        assert.ok(!JSON.stringify([seen.args, seen.env]).includes('url-secret-pw'));
        assert.ok(!JSON.stringify([seen.args, seen.env]).includes('127.0.0.1:1'));
        assert.equal((JSON.parse(seen.input) as { url: string }).url, url);
    });
});

describe('timeouts', () => {
    let server: NetServer;
    let port = 0;
    const sockets: Socket[] = [];
    before(async () => {
        // Accepts connections and never answers.
        server = createServer((socket) => sockets.push(socket));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as { port: number }).port;
    });
    after(() => {
        for (const socket of sockets) {
            socket.destroy();
        }
        server.close();
    });

    test('a worker that does not finish is stopped', async () => {
        const started = Date.now();
        await rejects(introspect({ url: `postgresql://u:timeout-pw@127.0.0.1:${String(port)}/db`, timeout: 2 }), /did not finish within 2 seconds/, 'timeout-pw');
        assert.ok(Date.now() - started < 10_000);
    });
});

function serverSuite(server: Server, title: string, files: string[], scope: Partial<DatabaseRequest>, checks: (document: () => SchemaDocument, database: () => Disposable) => void): void {
    const skip = adminUrl(server) === undefined ? `set the ${server} test URL (see this module's header)` : false;
    describe(title, { skip }, () => {
        let database: Disposable;
        let document: SchemaDocument;
        before(async () => {
            database = await serverDatabase(server, files);
            document = await introspect({ url: database.url('reader'), ...scope });
        });
        after(async () => {
            await database.drop();
        });

        test('the read-only role needs no consent', () => {
            assertProducerDocument(document);
            assert.ok(!document.diagnostics.some((d) => d.kind === 'write_privileges'));
        });

        test('admin roles are refused without consent', async () => {
            const admin = new URL(database.url()).password;
            await rejects(introspect({ url: database.url(), ...scope }), /can change the schema or data/, decodeURIComponent(admin));
        });

        test('write privileges are refused, then reported when accepted', async () => {
            await rejects(introspect({ url: database.url('writer'), ...scope }), /can change the schema or data/, database.passwords.writer);
            const accepted = await introspect({ url: database.url('writer'), allowWritePrivileges: true, ...scope });
            const diagnostic = accepted.diagnostics.find((d) => d.kind === 'write_privileges');
            assert.equal(diagnostic?.category, 'inspection');
            assert.match(diagnostic.message, /the session was read-only/);
            assert.equal(diagnostic.id, diagnosticId(diagnostic));
            assertProducerDocument(accepted);
        });

        test('sessions are read-only even for an admin', async () => {
            const session: Session = await openSession(database.url(), 5);
            try {
                await assert.rejects(session.rows('CREATE TABLE pwned (x int)'), /not a catalog read/);
                // Straight to the driver, past the statement allowlist: the database refuses.
                const driver = session.driver as { query(sql: string): Promise<unknown> };
                await assert.rejects(driver.query('CREATE TABLE pwned (x int)'), /read.only/i);
            } finally {
                await session.close();
            }
            assert.ok(!('pwned' in tables(await introspect({ url: database.url('reader'), ...scope }))));
        });

        test('wrong passwords fail without leaking', async () => {
            const url = new URL(database.url('reader'));
            url.password = 'wrong-pw-123';
            await rejects(introspect({ url: url.href, ...scope }), /Could not connect/, 'wrong-pw-123');
        });

        checks(
            () => document,
            () => database,
        );
    });
}

serverSuite('postgres', 'PostgreSQL introspection', ['postgresql.sql'], { schemas: ['public', 'billing'] }, (document, database) => {
    test('schemas are namespaced', async () => {
        const found = tables(document());
        assert.equal(found.accounts?.id, '["default",null,"accounts"]');
        assert.equal(found.invoices?.id, '["default","billing","invoices"]');
        assert.deepEqual([found.accounts.schema, found.invoices.schema], ['public', 'billing']);
        const coverage = document().connections[0]?.coverage.database;
        assert.deepEqual([coverage?.schemas, coverage?.complete], [['public', 'billing'], true]);
        assert.deepEqual(Object.keys(tables(await introspect({ url: database().url('reader') }))), ['accounts']);
        await rejects(introspect({ url: database().url('reader'), schemas: ['missing'] }), /'missing' does not exist/);
    });

    test('composite and cross-schema foreign keys', () => {
        const found = tables(document());
        assert.deepEqual(found.invoice_lines?.primaryKey, ['invoice_id', 'line_no']);
        const line = found.line_notes?.foreignKeys[0];
        assert.deepEqual([line?.columns, line?.foreignTable, line?.foreignColumns], [['invoice_id', 'line_no'], '["default","billing","invoice_lines"]', ['invoice_id', 'line_no']]);
        assert.deepEqual([line?.onUpdate, line?.deferrable, line?.initially], ['CASCADE', true, 'DEFERRED']);
        const invoice = found.invoices?.foreignKeys[0];
        assert.deepEqual([invoice?.foreignTable, invoice?.onDelete], ['["default",null,"accounts"]', 'CASCADE']);
    });

    test('index features', () => {
        const indexes = byName(tables(document()).accounts?.indexes ?? []);
        assert.deepEqual(indexes.accounts_pkey?.backs, { kind: 'primary_key', constraint: null });
        assert.equal(indexes.accounts_email_key?.backs?.kind, 'unique_constraint');
        const created = indexes.accounts_created_at_idx;
        assert.deepEqual([created?.parts[0]?.order, created?.parts[0]?.nulls, created?.included], ['desc', 'last', ['status']]);
        assert.equal(indexes.accounts_live_email_idx?.predicate, '(deleted_at IS NULL)');
        assert.equal(indexes.accounts_lower_email_idx?.parts[0]?.expression, 'lower(email)');
        const mixed = indexes.accounts_status_created_idx?.parts;
        assert.deepEqual([mixed?.[0]?.column, mixed?.[1]?.column], ['status', null]);
        const pattern = indexes.accounts_email_pattern_idx?.parts[0];
        assert.deepEqual([pattern?.collation, pattern?.opclass], ['C', 'text_pattern_ops']);
        assert.deepEqual([indexes.accounts_data_idx?.method, indexes.accounts_data_idx?.parts[0]?.opclass], ['gin', 'jsonb_path_ops']);
        assert.deepEqual(indexes.accounts_external_ref_key?.dialectOptions, { postgresql: { options: { nullsNotDistinct: true } } });
    });

    test('columns', () => {
        const columns = byName(tables(document()).accounts?.columns ?? []);
        assert.equal(columns.id?.default?.kind, 'identity');
        assert.deepEqual(columns.status?.enum, { name: 'account_status', values: ['trial', 'active', 'closed'] });
        assert.equal(columns.search?.generated?.kind, 'stored');
        assert.deepEqual([columns.created_at?.type, columns.created_at?.typeName], ['timestamp with time zone', 'timestamptz']);
        assert.equal(columns.email?.comment, 'Login address');
        assert.equal(tables(document()).accounts?.comment, 'Customer accounts');
        const serial = byName(tables(document()).invoices?.columns ?? []).id;
        assert.deepEqual([serial?.default?.kind, serial?.autoIncrement], ['sequence', true]);
    });

    test('statements are bounded by the statement timeout', async () => {
        const session = await openSession(database().url('reader'), 1);
        try {
            assert.equal((await session.rows('SHOW statement_timeout'))[0]?.[0], '1s');
            await assert.rejects(session.rows('SELECT pg_sleep(3)'), /statement timeout/);
        } finally {
            await session.close();
        }
    });
});

function mysqlChecks(functional: boolean) {
    return (document: () => SchemaDocument, database: () => Disposable): void => {
        test('keys, indexes and columns', () => {
            const found = tables(document());
            assert.deepEqual(found.order_lines?.primaryKey, ['account_id', 'order_number', 'line_no']);
            const fk = byName(found.order_lines.foreignKeys).order_lines_order_fk;
            assert.deepEqual([fk?.columns, fk?.foreignColumns, fk?.onUpdate], [['account_id', 'order_number'], ['account_id', 'number'], 'CASCADE']);
            const indexes = byName(found.products?.indexes ?? []);
            assert.equal(indexes.PRIMARY?.backs?.kind, 'primary_key');
            assert.equal(indexes.products_name_prefix?.parts[0]?.length, 10);
            assert.equal(indexes.products_status_created?.parts[1]?.order, 'desc');
            assert.equal(indexes.products_description_fulltext?.method, 'fulltext');
            assert.equal(indexes.products_location_spatial?.parts[0]?.length, null);
            const columns = byName(found.products?.columns ?? []);
            assert.deepEqual(columns.status?.enum, { name: null, values: ['draft', 'live'] });
            assert.equal(columns.name?.collation, 'utf8mb4_bin');
            assert.equal(found.accounts?.comment, 'Customer accounts');
            assert.deepEqual(byName(found.products?.constraints ?? []).products_price_positive?.columns, ['price']);
            const features = document().connections[0]?.coverage.database?.features;
            assert.equal(features?.indexExpressions, functional ? 'complete' : 'not_applicable');
            assert.equal(document().connections[0]?.driver, functional ? 'mysql' : 'mariadb');
            assert.equal(document().connections[0]?.defaultSchema, database().name);
            if (functional) {
                assert.match(indexes.products_color?.parts[0]?.expression ?? '', /'\$\.color'/);
                assert.deepEqual(indexes.products_price?.dialectOptions, { mysql: { options: { visible: false } } });
            }
        });

        test('the session is read-only with a statement time limit', async () => {
            const session = await openSession(database().url('reader'), 2);
            try {
                const variable = functional ? '@@session.max_execution_time' : '@@session.max_statement_time';
                assert.equal(Number((await session.rows(`SELECT ${variable}`))[0]?.[0]), functional ? 2000 : 2);
            } finally {
                await session.close();
            }
        });
    };
}

serverSuite('mysql', 'MySQL introspection', ['mysql.sql', 'mysql-functional.sql'], {}, mysqlChecks(true));
serverSuite('mariadb', 'MariaDB introspection', ['mysql.sql'], {}, mysqlChecks(false));

describe('several connections', { skip: adminUrl('postgres') === undefined || adminUrl('mysql') === undefined ? 'set the PostgreSQL and MySQL test URLs' : false }, () => {
    test('mixed drivers and duplicate table names, each worker with only its own URL', async () => {
        const postgres = await serverDatabase('postgres', ['drift-postgresql.sql']);
        const mysql = await serverDatabase('mysql', ['drift-mysql.sql']);
        const sqlite = sqliteDatabase(['drift-sqlite.sql']);
        try {
            const urls = { default: postgres.url('reader'), analytics: mysql.url('reader'), local: sqlite.url };
            const seen: Invocation[] = [];
            const document = await introspectAll(
                Object.entries(urls).map(([connection, url]) => ({ url, connection })),
                { observe: (i) => seen.push(i) },
            );
            assert.deepEqual(document.connections.map((c) => [c.name, c.driver]), [['analytics', 'mysql'], ['default', 'postgresql'], ['local', 'sqlite']]);
            const users = document.connections.flatMap((c) => c.tables.filter((t) => t.name === 'users').map((t) => t.id));
            assert.deepEqual(users, ['["analytics",null,"users"]', '["default",null,"users"]', '["local",null,"users"]']);
            assert.equal(seen.length, 3);
            for (const [n, url] of Object.values(urls).entries()) {
                const invocation = seen[n];
                assert.ok(invocation !== undefined);
                const others = Object.values(urls).filter((u) => u !== url);
                const received = (JSON.parse(invocation.input) as { url: string }).url;
                assert.ok(others.every((other) => !invocation.input.includes(other) && !received.includes(new URL(other).password || '\u0000')));
                assert.ok(!JSON.stringify([invocation.args, invocation.env]).includes(new URL(url).password || '\u0000'));
            }
            assert.deepEqual(validateDocument(document, { strict: true }).errors, []);
            // One failure fails the whole inspection.
            await rejects(introspectAll([{ url: postgres.url('reader') }, { url: `sqlite:${join(sqlite.directory, 'missing.db')}`, connection: 'x' }]), /does not exist/);
        } finally {
            await postgres.drop();
            await mysql.drop();
            sqlite.drop();
        }
    });
});
