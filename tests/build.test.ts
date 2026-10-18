// The build command: configuration, the Node.js version policy, declared builds in the isolated worker (process on
// Node.js 26, container with LSV_TEST_CONTAINER_IMAGE), database builds against the disposable servers
// (LSV_TEST_POSTGRES_URL, LSV_TEST_MYSQL_URL, LSV_TEST_MARIADB_URL), exit codes, atomic output, credentials, a hostile
// schema module, and the parity of declared and database documents of one schema.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, type TestContext } from 'node:test';
import { canonicalJson, normalizeType, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { ConfigError, loadConfig } from '../src/config.js';
import { extract as adapter } from '../src/isolation/extractors/drizzle.js';
import { extract, isolationConfig } from '../src/isolation/index.js';
import { contractRoot, readRoots } from '../src/isolation/runner.js';
import { adminUrl, serverDatabase, sqliteDatabase, type Server as DatabaseServer } from './databases.js';
import { assertProducerDocument, CLI, ROOT, tempDir } from './helpers.js';

const MAJOR = Number(process.versions.node.split('.')[0]);
const PROCESS_SUPPORTED = MAJOR >= 26;
const IMAGE = process.env.LSV_TEST_CONTAINER_IMAGE;
const REAL_ROOT = realpathSync(ROOT);
const FIXTURES = join(REAL_ROOT, 'tests', 'fixtures', 'drizzle');
const SECRET = 'postgresql://app:hunter2-build-secret@db.internal/app';
let counter = 0;

interface Run {
    code: number | null;
    stdout: string;
    stderr: string;
}

function cli(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<Run> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            resolvePromise({ code, stdout, stderr });
        });
    });
}

// A project inside the repository, so that drizzle-orm resolves from its node_modules as an application's would.
function project(t: TestContext, section: unknown, files: Record<string, string> = {}): string {
    counter += 1;
    const directory = join(REAL_ROOT, 'tests', `.lsv-build-${String(process.pid)}-${String(counter)}`);
    mkdirSync(directory, { recursive: true });
    t.after(() => {
        rmSync(directory, { recursive: true, force: true });
    });
    const manifest = { name: 'app', private: true, type: 'module', dependencies: { 'drizzle-orm': '0.45.4' }, ...(section === undefined ? {} : { 'node-schema-viewer': section }) };
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [path, source] of Object.entries(files)) {
        mkdirSync(join(directory, path, '..'), { recursive: true });
        copyFileSync(join(FIXTURES, source), join(directory, path));
    }
    return directory;
}

function load(path: string): SchemaDocument {
    return JSON.parse(readFileSync(path, 'utf8')) as SchemaDocument;
}

function leftovers(directory: string): string[] {
    return readdirSync(directory).filter((name) => name.startsWith('.schema-'));
}

// The declared document of fixture modules, from the adapter itself (every Node.js version).
async function declared(modules: string[]): Promise<SchemaDocument> {
    const require = createRequire(join(ROOT, 'package.json'));
    return (await adapter({
        projectRoot: ROOT,
        modules,
        targets: [],
        options: { connections: [{ name: 'default', driver: null, modules }], casing: null },
        async importModule(specifier) {
            const path = specifier.startsWith('./') ? resolve(ROOT, specifier) : require.resolve(specifier);
            return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
        },
    })) as SchemaDocument;
}

describe('build configuration', () => {
    test('reads the build keys of package.json', (t) => {
        const dir = tempDir(t);
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
            'node-schema-viewer': {
                source: 'database', orm: 'drizzle', output: 'schema.json', isolation: 'container', timeout: 30, containerImage: 'app-schema:1',
                containerRuntime: 'podman', containerMemory: '2g', containerPackagePath: '/opt/lsv/node_modules/node-schema-viewer', pullImage: true,
                allowCodeGeneration: true, envPassthrough: ['APP_MODE'], env: { SECRET_KEY: 'placeholder' }, allowWrites: ['var'], allowReads: ['../shared'],
                drizzle: { casing: 'snake_case' },
                databases: {
                    reporting: { urlEnv: 'REPORTING_DATABASE_URL', driver: 'mysql', modules: ['src/reporting/*.ts'] },
                    app: { urlEnv: 'APP_DATABASE_URL', schemas: ['public', 'billing'], modules: ['src/db/schema.ts'] },
                    local: { driver: 'sqlite', modules: ['src/local.ts'] },
                },
            },
        }));
        const { build } = loadConfig(dir);
        assert.deepEqual(build.databases, [
            { name: 'app', urlEnv: 'APP_DATABASE_URL', schemas: ['public', 'billing'], driver: null, modules: ['src/db/schema.ts'] },
            { name: 'local', urlEnv: null, schemas: [], driver: 'sqlite', modules: ['src/local.ts'] },
            { name: 'reporting', urlEnv: 'REPORTING_DATABASE_URL', schemas: [], driver: 'mysql', modules: ['src/reporting/*.ts'] },
        ]);
        assert.deepEqual([build.source, build.orm, build.isolation, build.timeout, build.containerImage, build.containerRuntime, build.containerMemory, build.pullImage, build.allowCodeGeneration, build.casing],
            ['database', 'drizzle', 'container', 30, 'app-schema:1', 'podman', '2g', true, true, 'snake_case']);
        assert.deepEqual([build.envPassthrough, build.env, build.allowWrites, build.allowReads], [['APP_MODE'], { SECRET_KEY: 'placeholder' }, ['var'], ['../shared']]);
    });

    test('rejects invalid build keys without echoing values', (t) => {
        const dir = tempDir(t);
        for (const [section, message] of [
            [{ source: 'both' }, /source must be one of declared, database, combined/],
            [{ orm: 'prisma' }, /orm must be one of drizzle/],
            [{ isolation: 'vm' }, /isolation must be one of process, container/],
            [{ timeout: 0 }, /timeout must be a positive number of seconds/],
            [{ timeout: '10' }, /timeout must be a positive number of seconds/],
            [{ modules: 'src/schema.ts' }, /modules must be a list of non-empty strings/],
            [{ modules: ['/abs/schema.ts'] }, /modules\[0\] must be a path or glob pattern relative to the project root/],
            [{ modules: ['../outside.ts'] }, /modules\[0\] must be a path or glob pattern relative to the project root/],
            [{ databaseUrlEnv: 'DATABASE URL' }, /databaseUrlEnv must be the name of the environment variable holding the URL/],
            [{ databases: { app: { urlEnv: 'A', url: 'x' } } }, /must not contain a database URL \(url\)/],
            [{ databases: { app: { urlEnv: 'A', port: 1 } } }, /Unknown .*databases\.app keys: port/],
            [{ databases: { app: { driver: 'oracle' } } }, /databases\.app driver must be one of postgresql, mysql, mariadb, sqlite/],
            [{ databases: { 'a b': {} } }, /connection names use letters, digits/],
            [{ databases: [] }, /databases must be an object with one object per connection/],
            [{ databases: { app: { urlEnv: 'A' } }, databaseUrlEnv: 'B' }, /sets both databases and databaseUrlEnv/],
            [{ modules: ['a.ts'], databases: { app: { modules: ['b.ts'] } } }, /sets modules both at the top level and per databases entry/],
            [{ databases: { a: { modules: ['x.ts'] }, b: { modules: ['x.ts'] } } }, /list a module under more than one connection/],
            [{ env: { A: 1 } }, /env must be an object of string values/],
            [{ pullImage: 'yes' }, /pullImage must be true or false/],
            [{ drizzle: { casing: 'kebab' } }, /drizzle casing must be one of snake_case, camelCase/],
            [{ drizzle: { schema: 'x' } }, /Unknown .*drizzle keys: schema/],
        ] as const) {
            writeFileSync(join(dir, 'package.json'), JSON.stringify({ 'node-schema-viewer': section }));
            assert.throws(() => loadConfig(dir), (error: Error) => error instanceof ConfigError && message.test(error.message), JSON.stringify(section));
        }
        for (const section of [{ databases: { app: { urlEnv: SECRET } } }, { databaseUrlEnv: SECRET }, { env: { DATABASE_URL: SECRET } }, { containerImage: SECRET }]) {
            writeFileSync(join(dir, 'package.json'), JSON.stringify({ 'node-schema-viewer': section }));
            assert.throws(() => loadConfig(dir), (error: Error) => error instanceof ConfigError && !error.message.includes('hunter2'), JSON.stringify(section));
        }
    });
});

describe('build: the extraction worker', () => {
    test('may read the contract package the adapters serialize with, wherever it is installed', (t) => {
        const dir = project(t, undefined);
        assert.ok(readRoots(dir, isolationConfig()).includes(contractRoot()));
        assert.ok(existsSync(join(contractRoot(), 'contract', 'schema.json')));
    });
});

describe('build: usage and early errors', () => {
    test('combined is not available yet (exit 2); invalid options are usage errors (exit 2)', async (t) => {
        const dir = project(t, { modules: ['schema.mjs'] }, { 'schema.mjs': 'pg.mjs' });
        for (const [args, message] of [
            [['--source', 'combined'], /--source combined is not available yet/],
            [['--source', 'both'], /--source must be one of declared, database, combined/],
            [['--isolation', 'vm'], /--isolation must be one of process, container/],
            [['--timeout=-1'], /--timeout must be a positive number of seconds/],
            [['--timeout', '0'], /--timeout must be a positive number of seconds/],
            [['--compare-limit', 'x'], /--compare-limit must be an integer/],
            [['extra'], /Unexpected argument: extra/],
        ] as const) {
            const run = await cli(['build', ...args], { cwd: dir });
            assert.equal(run.code, 2, args.join(' '));
            assert.match(run.stderr, message, args.join(' '));
            assert.equal(existsSync(join(dir, 'schema-viewer.json')), false);
        }
        const configured = project(t, { source: 'combined' });
        const run = await cli(['build'], { cwd: configured });
        assert.equal(run.code, 2);
        assert.match(run.stderr, /--source combined is not available yet/);
    });

    test('configuration and selection errors exit 1 without echoing a URL', async (t) => {
        const dir = project(t, { modules: ['schema.mjs'], envPassthrough: ['APP_URL_VAR'] }, { 'schema.mjs': 'pg.mjs' });
        for (const [args, env, message] of [
            [['--database', `app=${SECRET}`, '--source', 'database'], {}, /--database takes NAME=ENV_VAR/],
            [['--compare', 'a=b'], {}, /--compare compares inspected databases/],
            [['--source', 'database', '--database-url-env', 'APP_URL_VAR'], { APP_URL_VAR: SECRET }, /APP_URL_VAR holds a database URL and must not be passed to the extraction worker/],
            [['--source', 'database'], { LARANEX_SCHEMA_DATABASE_URL: '' }, /Set LARANEX_SCHEMA_DATABASE_URL to a read-only database URL/],
            [['--source', 'database', '--database', 'app=NSV_UNSET_URL'], {}, /Set NSV_UNSET_URL to a read-only database URL for connection app/],
            [['--module', 'missing/*.ts'], {}, /--module: the glob pattern missing\/\*\.ts matches no file in the project/],
            [['--module', 'nope.mjs'], {}, /--module: nope\.mjs is neither a file in the project nor a package the project resolves/],
            [['--module', '../x.mjs'], {}, /--module\[0\] must be a path or glob pattern relative to the project root/],
            [['--orm', 'prisma'], {}, /Unsupported ORM "prisma"; choose one of drizzle/],
        ] as const) {
            const run = await cli(['build', ...args], { cwd: dir, env });
            assert.equal(run.code, 1, args.join(' '));
            assert.match(run.stderr, message, args.join(' '));
            assert.ok(!run.stderr.includes('hunter2') && !run.stdout.includes('hunter2'), args.join(' '));
        }
        const empty = project(t, { output: 'x.json' });
        assert.match((await cli(['build', '--orm', 'drizzle'], { cwd: empty })).stderr, /Supply at least one --module, or set modules/);
        const none = project(t, { modules: ['schema.mjs'] }, { 'schema.mjs': 'pg.mjs' });
        writeFileSync(join(none, 'package.json'), JSON.stringify({ name: 'app', 'node-schema-viewer': { modules: ['schema.mjs'] } }));
        assert.match((await cli(['build'], { cwd: none })).stderr, /No supported ORM \(drizzle\) is a dependency in package\.json; choose one with --orm/);
    });

    test('on this Node.js version, process isolation is refused and nothing is written', { skip: PROCESS_SUPPORTED }, async (t) => {
        const dir = project(t, { modules: ['schema.mjs'] }, { 'schema.mjs': 'pg.mjs' });
        const run = await cli(['build'], { cwd: dir });
        assert.equal(run.code, 1);
        assert.match(run.stderr, /Process isolation needs Node\.js 26 or later/);
        assert.match(run.stderr, /container isolation/);
        assert.equal(existsSync(join(dir, 'schema-viewer.json')), false);
    });
});

describe('build --source declared, process isolation', { skip: !PROCESS_SUPPORTED && 'process isolation needs Node.js 26' }, () => {
    test('extracts each configured connection in the worker and writes the canonical document atomically', async (t) => {
        const dir = project(t, {
            output: 'out/schema.json',
            databases: { app: { modules: ['db/*.mjs'], driver: 'postgresql' }, local: { modules: ['local/schema.mjs'] } },
        }, { 'db/pg.mjs': 'pg.mjs', 'local/schema.mjs': 'sqlite.mjs' });
        const run = await cli(['build'], { cwd: dir, env: { DATABASE_URL: SECRET } });
        assert.equal(run.code, 0, run.stderr);
        const output = join(dir, 'out', 'schema.json');
        const lines = run.stdout.trim().split('\n');
        assert.equal(lines[0], 'Detected ORM drizzle (drizzle-orm in package.json)');
        assert.match(lines[1] ?? '', /^Extracted with process isolation; \d+ environment variables withheld$/);
        assert.equal(lines[2], `Saved laranex-schema 2.0 (declared): 8 tables, 8 models, 10 ORM relationships, 1 extraction diagnostics, to ${output}`);
        const document = load(output);
        assertProducerDocument(document);
        assert.equal(readFileSync(output, 'utf8'), canonicalJson(document));
        assert.deepEqual(document.connections.map((c) => [c.name, c.driver]), [['app', 'postgresql'], ['local', 'sqlite']]);
        assert.ok(!readFileSync(output, 'utf8').includes('hunter2') && !run.stdout.includes('hunter2') && !run.stderr.includes('hunter2'));
        assert.deepEqual(leftovers(join(dir, 'out')), []);
    });

    test('a failed build leaves the previous document as it was', async (t) => {
        const dir = project(t, { modules: ['schema.mjs', 'throws.mjs'] }, { 'schema.mjs': 'pg.mjs' });
        writeFileSync(join(dir, 'throws.mjs'), "throw new Error('model import failed');\n");
        const output = join(dir, 'schema-viewer.json');
        writeFileSync(output, 'previous');
        const run = await cli(['build', '--output', output], { cwd: dir });
        assert.equal(run.code, 1);
        assert.match(run.stderr, /Extraction failed in the isolated worker: Error: model import failed/);
        assert.equal(readFileSync(output, 'utf8'), 'previous');
        assert.deepEqual(leftovers(dir), []);
    });

    test('--module replaces the configured modules; TypeScript and CommonJS schema modules load; casing applies', async (t) => {
        const dir = project(t, { modules: ['casing.mjs'], drizzle: { casing: 'snake_case' } }, { 'schema.ts': 'schema.ts', 'schema.cjs': 'schema.cjs', 'casing.mjs': 'casing.mjs' });
        const run = await cli(['build', '--module', 'schema.ts', '--module', 'schema.cjs', '--output', 'out.json'], { cwd: dir });
        assert.equal(run.code, 0, run.stderr);
        const document = load(join(dir, 'out.json'));
        assert.deepEqual(document.connections.map((c) => [c.name, c.driver, c.tables.map((x) => x.name)]), [['default', 'sqlite', ['documents', 'notes']]]);
        assert.deepEqual(document.connections[0]?.tables[0]?.columns.map((c) => [c.name, c.default?.value ?? null]), [['id', null], ['title', "'ts'"]]);
        assert.equal((await cli(['build', '--output', 'cased.json'], { cwd: dir })).code, 0);
        const cased = load(join(dir, 'cased.json'));
        assert.deepEqual(cased.connections[0]?.tables.find((x) => x.name === 'authors')?.columns.map((c) => c.name), ['id', 'display_name']);
    });

    test('a schema module that tries the network, writes, processes and credentials is contained', async (t) => {
        const target = join(tempDir(t), 'written.txt');
        const sockets: Socket[] = [];
        const server: Server = createServer((socket) => sockets.push(socket));
        await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
        t.after(() => {
            server.close();
        });
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        const dir = project(t, { modules: ['hostile.mjs'], env: { LSV_ADVERSARIAL_TCP: `127.0.0.1:${String(port)}`, LSV_ADVERSARIAL_WRITE: target } }, { 'hostile.mjs': 'hostile.mjs' });
        const run = await cli(['build'], { cwd: dir, env: { LSV_HOSTILE_DATABASE_URL: SECRET } });
        assert.equal(run.code, 0, run.stderr);
        const document = load(join(dir, 'schema-viewer.json'));
        const outcomes = Object.fromEntries((document.connections[0]?.tables[0]?.columns ?? []).map((c) => c.name.split('=') as [string, string]));
        assert.deepEqual(Object.keys(outcomes), ['tcp', 'fetch', 'write', 'spawn', 'env']);
        for (const [probe, result] of Object.entries(outcomes)) {
            assert.match(result, /^blocked /, `${probe}: ${result}`);
        }
        assert.equal(outcomes.tcp, 'blocked ERR_ACCESS_DENIED');
        assert.equal(sockets.length, 0);
        assert.equal(existsSync(target), false);
        const text = readFileSync(join(dir, 'schema-viewer.json'), 'utf8') + run.stdout + run.stderr;
        assert.ok(!text.includes('hunter2'));
    });
});

describe('build --source declared, container isolation', { skip: IMAGE === undefined && 'set LSV_TEST_CONTAINER_IMAGE' }, () => {
    test('extracts in the container with the same result as the adapter, from every host version', async (t) => {
        const output = join(tempDir(t), 'schema.json');
        const run = await cli(['build', '--project-root', ROOT, '--module', 'tests/fixtures/drizzle/pg.mjs', '--isolation', 'container', '--container-image', IMAGE ?? '', '--output', output], { cwd: ROOT });
        assert.equal(run.code, 0, run.stderr);
        assert.match(run.stdout, /Extracted with container isolation; \d+ environment variables withheld/);
        assert.equal(canonicalJson(load(output)), canonicalJson(await declared(['./tests/fixtures/drizzle/pg.mjs'])));
    });

    test('a hostile schema module is contained: no network, a read-only project, no processes, no credentials', async (t) => {
        process.env.LSV_HOSTILE_DATABASE_URL = SECRET;
        t.after(() => {
            delete process.env.LSV_HOSTILE_DATABASE_URL;
        });
        const target = join(REAL_ROOT, 'tests', `.lsv-hostile-${String(process.pid)}.txt`);
        const modules = ['./tests/fixtures/drizzle/hostile.mjs'];
        const result = await extract(
            { projectRoot: ROOT, extractor: 'drizzle', modules, targets: [], options: { connections: [{ name: 'default', driver: null, modules }], casing: null } },
            { level: 'container', containerImage: IMAGE ?? null, env: { LSV_ADVERSARIAL_TCP: 'host.docker.internal:80', LSV_ADVERSARIAL_WRITE: `/project/tests/.lsv-hostile-${String(process.pid)}.txt` } },
        );
        const outcomes = Object.fromEntries((result.document.connections[0]?.tables[0]?.columns ?? []).map((c) => c.name.split('=') as [string, string]));
        for (const [probe, value] of Object.entries(outcomes)) {
            assert.match(value, /^blocked /, `${probe}: ${value}`);
        }
        assert.equal(existsSync(target), false);
        assert.ok(!JSON.stringify(result.document).includes('hunter2'));
    });
});

// Facts both documents state the same way: tables by schema and name, columns with nullability and normalized types,
// primary keys, foreign keys (an undeclared action is NO ACTION), unique column sets and the declared indexes.
function facts(document: SchemaDocument, indexes?: Set<string>) {
    const [connection] = document.connections;
    assert.ok(connection);
    const name = (id: string): string => {
        const t = connection.tables.find((x) => x.id === id);
        return t === undefined ? id : `${t.schema === connection.defaultSchema ? '' : `${String(t.schema)}.`}${t.name}`;
    };
    return connection.tables
        .map((t) => ({
            table: name(t.id),
            columns: t.columns.map((c) => [c.name, c.nullable, normalizeType(c.type)]),
            primaryKey: t.primaryKey,
            foreignKeys: t.foreignKeys.map((f) => [f.columns, name(f.foreignTable), f.foreignColumns, f.onDelete ?? 'NO ACTION', f.onUpdate ?? 'NO ACTION']).sort(),
            unique: [
                ...t.constraints.filter((c) => c.kind === 'unique').map((c) => c.columns.join(',')),
                ...t.indexes.filter((i) => i.unique && i.backs?.kind !== 'primary_key' && i.backs?.kind !== 'unique_constraint').map((i) => i.parts.map((p) => p.column).join(',')),
            ].sort(),
            indexes: t.indexes.filter((i) => !i.unique && (indexes === undefined || indexes.has(i.name ?? ''))).map((i) => [i.name, i.parts.map((p) => p.column)]),
        }))
        .sort((a, b) => (a.table < b.table ? -1 : 1));
}

function declaredIndexes(document: SchemaDocument): Set<string> {
    return new Set(document.connections.flatMap((c) => c.tables.flatMap((t) => t.indexes.map((i) => i.name ?? ''))));
}

describe('build --source database', () => {
    test('SQLite: one connection by --database, and parity with the declared document of the same schema', async (t) => {
        const database = sqliteDatabase(['drizzle-sqlite.sql']);
        t.after(() => {
            database.drop();
        });
        const dir = project(t, { databases: { local: { urlEnv: 'NSV_LOCAL_URL' } } });
        const run = await cli(['build', '--source', 'database', '--output', 'db.json'], { cwd: dir, env: { NSV_LOCAL_URL: database.url } });
        assert.equal(run.code, 0, run.stderr);
        assert.deepEqual(run.stdout.trim().split('\n'), ['Inspected connection local read-only (sqlite)', 'Saved laranex-schema 2.0 (database): 3 tables, 0 models, 0 ORM relationships, no diagnostics, to db.json']);
        const document = load(join(dir, 'db.json'));
        assertProducerDocument(document);
        const fromModels = await declared(['./tests/fixtures/drizzle/parity-sqlite.mjs']);
        assert.deepEqual(facts(document, declaredIndexes(fromModels)), facts(fromModels));
    });

    for (const server of ['postgres', 'mysql', 'mariadb'] as DatabaseServer[]) {
        const skip = adminUrl(server) === undefined && `set the ${server} admin URL`;
        test(`${server}: read-only, credentials only from the environment, parity with the declared document`, { skip }, async (t) => {
            const database = await serverDatabase(server, [server === 'postgres' ? 'drizzle-postgresql.sql' : 'drizzle-mysql.sql']);
            t.after(() => database.drop());
            const schemas = server === 'postgres' ? { schemas: ['public', 'billing'] } : {};
            const dir = project(t, { output: 'db.json', databases: { app: { urlEnv: 'NSV_APP_URL', ...schemas } } });
            const run = await cli(['build', '--source', 'database'], { cwd: dir, env: { NSV_APP_URL: database.url('reader') } });
            assert.equal(run.code, 0, run.stderr);
            const driver = server === 'postgres' ? 'postgresql' : server;
            assert.match(run.stdout, new RegExp(`^Inspected connection app read-only \\(${driver}\\)\\n`));
            const text = readFileSync(join(dir, 'db.json'), 'utf8');
            for (const output of [text, run.stdout, run.stderr]) {
                assert.ok(!output.includes(database.passwords.reader) && !output.includes(database.url('reader')));
            }
            const document = load(join(dir, 'db.json'));
            assertProducerDocument(document);
            const fromModels = await declared([`./tests/fixtures/drizzle/parity-${server === 'postgres' ? 'pg' : 'mysql'}.mjs`]);
            assert.deepEqual(facts(document, declaredIndexes(fromModels)), facts(fromModels));

            // The single-database options, and a role that could write, refused with the URL scrubbed.
            const single = await cli(['build', '--source', 'database', '--output', 'single.json', ...(server === 'postgres' ? ['--schema', 'public', '--schema', 'billing'] : [])], {
                cwd: project(t, undefined),
                env: { LARANEX_SCHEMA_DATABASE_URL: database.url('reader') },
            });
            assert.equal(single.code, 0, single.stderr);
            assert.match(single.stdout, new RegExp(`^Inspected the database read-only \\(${driver}\\)\\n`));
            const writer = await cli(['build', '--source', 'database', '--database', 'app=NSV_APP_URL'], { cwd: dir, env: { NSV_APP_URL: database.url('writer') } });
            assert.equal(writer.code, 1);
            assert.match(writer.stderr, /can change the schema or data/);
            assert.ok(!writer.stderr.includes(database.passwords.writer) && !writer.stdout.includes(database.passwords.writer));
        });
    }
});
