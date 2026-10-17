// Isolated extraction: adversarial model modules, the Node.js version policy, and failing closed. Mirrors
// python-schema-viewer's tests/test_isolation.py.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { baseArguments, checkImage, pullNotice } from '../src/isolation/container.js';
import { workerEnvironment } from '../src/isolation/env.js';
import { checkPolicy, extract, IsolationError, isolationConfig, type ExtractRequest, type ExtractResult, type IsolationConfig } from '../src/isolation/index.js';
import { readResult, runWorker } from '../src/isolation/runner.js';
import { VERSION } from '../src/version.js';
import { ROOT } from './helpers.js';

const MAJOR = Number(process.versions.node.split('.')[0]);
const PROCESS_SUPPORTED = MAJOR >= 26;
const POSIX = process.platform !== 'win32';
const EXTRACTOR = join(ROOT, 'tests', 'fixtures', 'adversarial', 'extractor.mjs');
const REAL_ROOT = realpathSync(ROOT);

function request(module: string | string[], options?: Record<string, unknown>): ExtractRequest {
    const modules = (Array.isArray(module) ? module : [module]).map((m) => `./tests/fixtures/adversarial/${m}`);
    return { projectRoot: ROOT, extractor: EXTRACTOR, modules, targets: [], ...(options === undefined ? {} : { options }) };
}

function isolated(module: string | string[], config: Partial<IsolationConfig> = {}, options?: Record<string, unknown>): Promise<ExtractResult> {
    return extract(request(module, options), config);
}

// The outcome a hostile module recorded, from the comment of its table.
function outcome(result: ExtractResult, table: string): Record<string, unknown> {
    for (const connection of result.document.connections) {
        for (const candidate of connection.tables) {
            if (candidate.name === table && candidate.comment !== null) {
                return JSON.parse(candidate.comment) as Record<string, unknown>;
            }
        }
    }
    throw new Error(`no table ${table}`);
}

// Outside every directory the worker may read or write.
function outside(t: TestContext): string {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'lsv-adversarial-')));
    t.after(() => {
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

// A directory inside the project, for allowWrites and symlinks.
function projectDirectory(t: TestContext, name: string): string {
    const directory = join(REAL_ROOT, 'tests', `.lsv-${name}-${process.pid}`);
    mkdirSync(directory, { recursive: true });
    t.after(() => {
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
    // A zombie still answers signal 0; ps reports its state.
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    return state !== '' && !state.startsWith('Z');
}

async function waitForDeath(pid: number): Promise<boolean> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && alive(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !alive(pid);
}

function blocked(value: unknown, code?: string): void {
    assert.equal(typeof value, 'string');
    assert.ok((value as string).startsWith('blocked'), `expected a blocked attempt, got ${String(value)}`);
    if (code !== undefined) {
        assert.equal(value, `blocked ${code}`);
    }
}

describe('the Node.js version policy', () => {
    test('process isolation needs Node.js 26; container isolation is allowed everywhere', () => {
        for (const version of ['22.13.0', '22.23.3', '24.22.0', '25.9.0']) {
            assert.throws(() => {
                checkPolicy('process', version);
            }, /needs Node\.js 26 or later/);
            checkPolicy('container', version);
        }
        checkPolicy('process', '26.0.0');
        checkPolicy('process', '27.1.0');
    });

    test('on this Node.js version, process isolation is refused before any worker runs', { skip: PROCESS_SUPPORTED }, async (t) => {
        const target = join(outside(t), 'written.txt');
        await assert.rejects(isolated('import-write.mjs', { env: { LSV_ADVERSARIAL_WRITE: target } }), (error: Error) => {
            assert.ok(error instanceof IsolationError);
            assert.match(error.message, new RegExp(`this is ${process.versions.node.replace(/\./g, '\\.')}`));
            assert.match(error.message, /container isolation/);
            return true;
        });
        assert.equal(existsSync(target), false);
    });
});

describe('the worker environment', () => {
    test('is an allowlist with a private HOME and TMPDIR, and reports only how much it withheld', () => {
        const source = {
            PATH: '/usr/bin', LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', TERM: 'xterm', NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://app:hunter2@db/app', MIKRO_ORM_PASSWORD: 'x', AWS_SECRET_ACCESS_KEY: 'x',
            NODE_OPTIONS: '--require ./evil.js', NODE_PATH: '/elsewhere', npm_config__authToken: 'x', HOME: '/Users/me', APP_MODE: 'x',
        };
        const { env, withheld } = workerEnvironment(source, { passthrough: ['APP_MODE'], fixed: { SECRET_KEY: 'placeholder' }, home: '/h', tmp: '/t' });
        assert.deepEqual(env, {
            PATH: '/usr/bin', LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', TERM: 'xterm', NODE_ENV: 'production', APP_MODE: 'x',
            SECRET_KEY: 'placeholder', HOME: '/h', USERPROFILE: '/h', TMPDIR: '/t', TEMP: '/t', TMP: '/t',
        });
        assert.equal(withheld, 6);
    });

    test('refuses credential, ORM connection and loader names in envPassthrough', () => {
        for (const name of ['DATABASE_URL', 'DB_PASSWORD', 'API_TOKEN', 'SENTRY_DSN', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'MIKRO_ORM_HOST',
            'TYPEORM_URL', 'PGPASSWORD', 'PGHOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'npm_config__authToken', 'NODE_OPTIONS', 'NODE_PATH', 'REDIS_URL']) {
            assert.throws(() => workerEnvironment({ [name]: 'x' }, { passthrough: [name], fixed: {}, home: '/h', tmp: '/t' }), IsolationError, name);
        }
    });

    test('passes NODE_ENV unchanged only when it is set, and refuses values that are not plain tokens', () => {
        const options = { passthrough: [], fixed: {}, home: '/h', tmp: '/t' };
        assert.equal(workerEnvironment({ NODE_ENV: 'production' }, options).env.NODE_ENV, 'production');
        assert.equal(workerEnvironment({ NODE_ENV: 'Test_1.x-y' }, options).env.NODE_ENV, 'Test_1.x-y');
        assert.equal('NODE_ENV' in workerEnvironment({}, options).env, false);
        for (const value of ['', 'production; rm -rf /', 'postgres://u:p@h/db', 'a b', 'x'.repeat(33), 'prod\n']) {
            assert.throws(() => workerEnvironment({ NODE_ENV: value }, options), /NODE_ENV/, JSON.stringify(value));
            assert.throws(() => workerEnvironment({}, { ...options, fixed: { NODE_ENV: value } }), /NODE_ENV/, JSON.stringify(value));
        }
    });

    test('refuses loader settings and URLs with passwords as fixed values', () => {
        assert.throws(() => workerEnvironment({}, { passthrough: [], fixed: { NODE_OPTIONS: '--allow-net' }, home: '/h', tmp: '/t' }), IsolationError);
        assert.throws(() => workerEnvironment({}, { passthrough: [], fixed: { DATABASE_URL: 'postgres://u:p@h/db' }, home: '/h', tmp: '/t' }), IsolationError);
        const { env } = workerEnvironment({}, { passthrough: [], fixed: { DATABASE_URL: 'postgres://placeholder/db' }, home: '/h', tmp: '/t' });
        assert.equal(env.DATABASE_URL, 'postgres://placeholder/db');
    });
});

describe('process-group cleanup', { skip: !POSIX && 'process groups are POSIX' }, () => {
    // The Permission Model stops application code from starting processes, so this drives the runner directly with
    // a worker that is allowed to: its child stays in the worker's process group and must die with it.
    test('a timed-out worker is killed together with the processes it started', async (t) => {
        const directory = outside(t);
        const pidFile = join(directory, 'grandchild.pid');
        const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
        const script = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
        const run = await runWorker(process.execPath, ['-e', script], {
            cwd: directory, env: { PATH: process.env.PATH ?? '' }, input: '', log: join(directory, 'log'), timeoutMs: 2000,
        });
        assert.equal(run.timedOut, true);
        const pid = Number(readFileSync(pidFile, 'utf8'));
        assert.ok(pid > 0);
        assert.equal(await waitForDeath(pid), true, 'the grandchild outlived the worker');
    });

    test('processes left behind by a worker that finished are killed too', async (t) => {
        const directory = outside(t);
        const pidFile = join(directory, 'grandchild.pid');
        const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
        const script = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); c.unref(); setTimeout(() => process.exit(0), 1000)`;
        const run = await runWorker(process.execPath, ['-e', script], {
            cwd: directory, env: { PATH: process.env.PATH ?? '' }, input: '', log: join(directory, 'log'), timeoutMs: 30_000,
        });
        assert.equal(run.timedOut, false);
        assert.equal(await waitForDeath(Number(readFileSync(pidFile, 'utf8'))), true);
    });
});

describe('result validation', () => {
    function write(t: TestContext, content: string | Buffer): string {
        const path = join(outside(t), 'result.json');
        writeFileSync(path, content);
        return path;
    }

    test('a missing, oversized, symlinked, non-JSON or failed result is refused', (t) => {
        const log = join(outside(t), 'log');
        assert.throws(() => readResult(join(outside(t), 'missing.json'), log), /without a result/);
        assert.throws(() => readResult(write(t, Buffer.alloc(32 * 1024 * 1024 + 1, 32)), log), /32 MiB/);
        assert.throws(() => readResult(write(t, 'not json'), log), /not JSON/);
        assert.throws(() => readResult(write(t, JSON.stringify({ ok: false, error: 'boom' })), log), /boom/);
        const target = write(t, JSON.stringify({ ok: true, document: {} }));
        const link = join(outside(t), 'link.json');
        symlinkSync(target, link);
        assert.throws(() => readResult(link, log), /not a regular file/);
    });

    test('an invalid document is refused', (t) => {
        const log = join(outside(t), 'log');
        assert.throws(() => readResult(write(t, JSON.stringify({ ok: true, document: { format: 'laranex-schema' } })), log), /invalid document/);
    });
});

describe('failing closed', () => {
    test('unknown levels, missing images and missing runtimes are refused', async () => {
        await assert.rejects(extract(request('codegen.mjs'), { level: 'none' as IsolationConfig['level'] }), /Unknown isolation level/);
        await assert.rejects(extract(request('codegen.mjs'), { level: 'container' }), /containerImage/);
        await assert.rejects(
            extract(request('codegen.mjs'), { level: 'container', containerImage: 'lsv-test', containerRuntime: 'lsv-no-such-runtime' }),
            /weaker isolation/,
        );
    });

    test('an image with another package or version, an old Node.js, or no working worker entry point is refused', () => {
        assert.throws(() => {
            checkImage('img', { name: 'laranex-schema-viewer', version: '0.0.1', node: '24.0.0' });
        }, /must have laranex-schema-viewer .* \(found: laranex-schema-viewer 0\.0\.1\)/);
        assert.throws(() => {
            checkImage('img', { name: 'something-else', version: VERSION, node: '24.0.0' });
        }, /must have laranex-schema-viewer/);
        assert.throws(() => {
            checkImage('img', { name: 'laranex-schema-viewer', version: VERSION, node: '22.12.0' });
        }, /22\.13 or later/);
        assert.throws(() => {
            checkImage('img', null, 'Cannot find module /opt/lsv/dist/isolation/worker.js');
        }, /entry point in image img is missing or does not run: Cannot find module/);
        checkImage('img', { name: 'laranex-schema-viewer', version: VERSION, node: '22.13.0' });
    });

    test('images are never pulled unless pullImage opts in, and a pull of an unpinned image comes with a notice', () => {
        const pull = (config: Partial<IsolationConfig>): string | undefined => {
            const args = baseArguments(isolationConfig(config));
            return args[args.indexOf('--pull') + 1];
        };
        assert.equal(pull({}), 'never');
        assert.equal(pull({ pullImage: true }), 'missing');
        assert.equal(pullNotice('app:latest', isolationConfig({})), null);
        assert.match(pullNotice('app:latest', isolationConfig({ pullImage: true })) ?? '', /not pinned by digest.*image@sha256/);
        assert.equal(pullNotice(`app@sha256:${'a'.repeat(64)}`, isolationConfig({ pullImage: true })), null);
    });

    describe('with a stand-in container runtime', { skip: !POSIX && 'uses a shell script' }, () => {
        // Records its arguments, reports a running daemon, knows no image, and fails every run.
        function fakeRuntime(t: TestContext): { runtime: string; calls: () => string[] } {
            const directory = outside(t);
            const log = join(directory, 'calls.log');
            const runtime = join(directory, 'fake-runtime');
            writeFileSync(log, '');
            writeFileSync(runtime, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$1" in info) exit 0;; image) exit 1;; *) echo 'no such image' >&2; exit 125;; esac\n`, { mode: 0o755 });
            return { runtime, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
        }

        test('a missing image fails without a pull', async (t) => {
            const { runtime, calls } = fakeRuntime(t);
            await assert.rejects(
                extract(request('codegen.mjs'), { level: 'container', containerImage: 'app:missing', containerRuntime: runtime }),
                /Image app:missing is not available locally, and pulling is disabled\. Build it .* or pull it yourself .*pullImage/,
            );
            assert.deepEqual(calls(), ['info', 'image inspect app:missing']);
        });

        test('with pullImage, every run lets the runtime pull a missing image', async (t) => {
            const { runtime, calls } = fakeRuntime(t);
            await assert.rejects(
                extract(request('codegen.mjs'), { level: 'container', containerImage: 'app:missing', containerRuntime: runtime, pullImage: true }),
                /Cannot find laranex-schema-viewer from the working directory of image app:missing/,
            );
            const runs = calls().filter((call) => call.startsWith('run '));
            assert.equal(runs.length, 1);
            assert.ok(runs.every((call) => call.startsWith('run --rm --pull missing --network none ')));
        });
    });
});

describe('process isolation', { skip: !PROCESS_SUPPORTED && `process isolation is refused on Node.js ${process.versions.node}` }, () => {
    test('import-time writes outside the allowed directories are blocked', async (t) => {
        const target = join(outside(t), 'written.txt');
        const result = await isolated('import-write.mjs', { env: { LSV_ADVERSARIAL_WRITE: target } });
        blocked(outcome(result, 'import_write').write, 'ERR_ACCESS_DENIED');
        assert.equal(existsSync(target), false);
    });

    test('project directories in allowWrites are writable; directories outside the project cannot be allowed', async (t) => {
        const directory = projectDirectory(t, 'allowed-writes');
        const target = join(directory, 'import.log');
        const relative = directory.slice(REAL_ROOT.length + 1);
        const result = await isolated('import-write.mjs', { env: { LSV_ADVERSARIAL_WRITE: target }, allowWrites: [relative] });
        assert.equal(outcome(result, 'import_write').write, 'written');
        assert.equal(readFileSync(target, 'utf8'), 'written');
        await assert.rejects(isolated('import-write.mjs', { allowWrites: ['../elsewhere'] }), /outside the project/);
    });

    test('network connections, fetch, DNS and UDP are blocked', async (t) => {
        const accepted: Socket[] = [];
        const server: Server = createServer((socket) => {
            accepted.push(socket);
            socket.destroy();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        t.after(() => server.close());
        const address = server.address();
        assert.ok(address !== null && typeof address === 'object');
        const result = await isolated('network.mjs', { env: { LSV_ADVERSARIAL_TCP: `127.0.0.1:${address.port}` } });
        const found = outcome(result, 'network');
        for (const key of ['tcp', 'fetch', 'dns', 'udp']) {
            blocked(found[key], 'ERR_ACCESS_DENIED');
        }
        assert.equal(accepted.length, 0);
    });

    test('child processes and worker threads are blocked', async (t) => {
        const target = join(outside(t), 'spawned.txt');
        const result = await isolated('spawn.mjs', { env: { LSV_ADVERSARIAL_WRITE: target } });
        const found = outcome(result, 'spawn');
        for (const key of ['spawn', 'exec', 'worker']) {
            blocked(found[key], 'ERR_ACCESS_DENIED');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(existsSync(target), false);
    });

    test('native addons cannot be loaded', async (t) => {
        const result = await isolated('addon.mjs', { env: { LSV_ADVERSARIAL_ADDON: join(outside(t), 'hostile.node') } });
        blocked(outcome(result, 'addon').dlopen, 'ERR_DLOPEN_DISABLED');
    });

    test('node:sqlite, which ignores the Permission Model, is not available', async (t) => {
        const database = join(outside(t), 'app.sqlite3');
        const result = await isolated('sqlite.mjs', { env: { LSV_ADVERSARIAL_SQLITE: database } });
        blocked(outcome(result, 'sqlite').sqlite, 'ERR_UNKNOWN_BUILTIN_MODULE');
        assert.equal(existsSync(database), false);
    });

    test('eval and new Function are blocked unless allowCodeGeneration opts out', async () => {
        const strict = outcome(await isolated('codegen.mjs'), 'codegen');
        blocked(strict.eval, 'EvalError');
        blocked(strict.function, 'EvalError');
        assert.deepEqual(outcome(await isolated('codegen.mjs', { allowCodeGeneration: true }), 'codegen'), { eval: '2', function: '2' });
    });

    test('credentials in the environment, under HOME and in files outside the project are not visible', async (t) => {
        const secretFile = join(outside(t), 'credentials');
        writeFileSync(secretFile, 'hunter2');
        const secrets = {
            DATABASE_URL: 'postgresql://app:hunter2@db/app', MIKRO_ORM_PASSWORD: 'hunter2', AWS_SECRET_ACCESS_KEY: 'hunter2',
            AWS_ACCESS_KEY_ID: 'AKIA-not-real', LSV_ADVERSARIAL_SECRET: 'hunter2', NODE_OPTIONS: '--max-old-space-size=4096',
        };
        const saved = { ...process.env };
        Object.assign(process.env, secrets);
        t.after(() => {
            for (const name of Object.keys(secrets)) {
                if (saved[name] === undefined) {
                    Reflect.deleteProperty(process.env, name);
                } else {
                    process.env[name] = saved[name];
                }
            }
        });
        const result = await isolated('secrets.mjs', { env: { LSV_ADVERSARIAL_READ: secretFile } });
        const found = outcome(result, 'secrets');
        assert.deepEqual(found.env, Object.fromEntries(Object.keys(secrets).map((name) => [name, null])));
        assert.notEqual(found.home, homedir());
        assert.match(String(found.home), /lsv-extract-/);
        assert.equal(found.pgpass, false);
        blocked(found.read, 'ERR_ACCESS_DENIED');
        assert.ok(result.withheld >= Object.keys(secrets).length);
        assert.equal(JSON.stringify(result.document).includes('hunter2'), false);
    });

    test('a worker that does not finish is stopped at the timeout', async (t) => {
        const directory = projectDirectory(t, 'slow');
        const pidFile = join(directory, 'worker.pid');
        const started = Date.now();
        await assert.rejects(
            isolated('slow.mjs', { timeout: 3, env: { LSV_ADVERSARIAL_PID: pidFile }, allowWrites: [directory.slice(REAL_ROOT.length + 1)] }),
            /within 3 seconds/,
        );
        assert.ok(Date.now() - started < 30_000);
        const pid = Number(readFileSync(pidFile, 'utf8'));
        assert.ok(pid > 0);
        assert.equal(await waitForDeath(pid), true);
    });

    test("the application's exit hooks do not run", async (t) => {
        const directory = projectDirectory(t, 'exit-hook');
        const target = join(directory, 'exit.txt');
        await isolated('exit-hook.mjs', { env: { LSV_ADVERSARIAL_WRITE: target }, allowWrites: [directory.slice(REAL_ROOT.length + 1)] });
        assert.equal(existsSync(target), false);
    });

    test('LIMITATION: a symlink inside a readable directory still reaches files outside it', async (t) => {
        // Documented in docs/security.md: the Permission Model checks the path given, not where a symlink leads.
        const secret = join(outside(t), 'secret.txt');
        writeFileSync(secret, 'outside the project');
        const link = join(projectDirectory(t, 'link'), 'link.txt');
        symlinkSync(secret, link);
        const result = await isolated('symlink.mjs', { env: { LSV_ADVERSARIAL_LINK: link } });
        assert.equal(outcome(result, 'symlink').read, 'outside the project');
    });

    test('TypeScript models with legacy decorators load through the transpiling hook', async () => {
        const result = await isolated('decorated.ts');
        assert.deepEqual(outcome(result, 'decorated'), { columns: ['id', 'name'], team: true });
    });

    test('several modules extract into one document', async () => {
        const result = await isolated(['codegen.mjs', 'exit-hook.mjs']);
        assert.deepEqual(result.document.connections[0]?.tables.map((t) => t.name), ['codegen', 'exit_hook']);
    });

    test('failures in application code surface', async () => {
        await assert.rejects(isolated('throws.mjs'), /model module failed on purpose/);
    });

    test('invalid, non-declared and oversized documents from the worker are refused', async () => {
        await assert.rejects(isolated('codegen.mjs', {}, { mode: 'invalid' }), /invalid document/);
        await assert.rejects(isolated('codegen.mjs', {}, { mode: 'database' }), /expected "declared"/);
        await assert.rejects(isolated('codegen.mjs', {}, { mode: 'huge' }), /32 MiB/);
    });

    test('unknown extractors and extractors outside the project are refused', async (t) => {
        await assert.rejects(extract({ ...request('codegen.mjs'), extractor: 'no-such-orm' }), /Unknown extractor/);
        const elsewhere = join(outside(t), 'extractor.mjs');
        writeFileSync(elsewhere, 'export function extract() { return {}; }');
        await assert.rejects(extract({ ...request('codegen.mjs'), extractor: elsewhere }), /inside the project/);
    });
});

const IMAGE = process.env.LSV_TEST_CONTAINER_IMAGE;
const RUNTIME = process.env.LSV_TEST_CONTAINER_RUNTIME ?? 'docker';

// What only the container level guarantees, tested past the Permission Model where it would otherwise answer first.
describe('container isolation', { skip: IMAGE === undefined && 'set LSV_TEST_CONTAINER_IMAGE (tests/containers/README.md)' }, () => {
    const image = IMAGE ?? '';
    const config = (overrides: Partial<IsolationConfig> = {}): Partial<IsolationConfig> => ({
        level: 'container', containerImage: image, containerRuntime: RUNTIME, timeout: 180, ...overrides,
    });
    const imageNode = (): number =>
        Number(spawnSync(RUNTIME, ['run', '--rm', image, 'node', '-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim().split('.')[0]);

    test('matches process isolation', { skip: !PROCESS_SUPPORTED && 'process isolation is refused on this Node.js' }, async () => {
        const modules = ['codegen.mjs', 'decorated.ts'];
        assert.deepEqual((await isolated(modules, config())).document, (await isolated(modules)).document);
    });

    test('has no network, even where the Permission Model allows it', async () => {
        const result = await isolated('network.mjs', config({ env: { LSV_ADVERSARIAL_TCP: '1.1.1.1:53' } }));
        const found = outcome(result, 'network');
        for (const key of ['tcp', 'fetch', 'dns', 'udp']) {
            blocked(found[key]);
            if (imageNode() < 26) {
                // Node.js 22 and 24 do not restrict the network: the refusal came from the container.
                assert.notEqual(found[key], 'blocked ERR_ACCESS_DENIED');
            }
        }
    });

    test('the project is read-only, even for directories in allowWrites', async (t) => {
        const directory = projectDirectory(t, 'container-write');
        const relative = directory.slice(REAL_ROOT.length + 1);
        const result = await isolated('import-write.mjs', config({ env: { LSV_ADVERSARIAL_WRITE: `/project/${relative}/x.txt` }, allowWrites: [relative] }));
        blocked(outcome(result, 'import_write').write, 'EROFS');
        assert.equal(existsSync(join(directory, 'x.txt')), false);
    });

    test('credentials are withheld', async (t) => {
        process.env.DATABASE_URL = 'postgresql://app:hunter2@db/app';
        process.env.MIKRO_ORM_PASSWORD = 'hunter2';
        t.after(() => {
            Reflect.deleteProperty(process.env, 'DATABASE_URL');
            Reflect.deleteProperty(process.env, 'MIKRO_ORM_PASSWORD');
        });
        const result = await isolated('secrets.mjs', config({ env: { LSV_ADVERSARIAL_READ: '/etc/hostname' } }));
        const found = outcome(result, 'secrets');
        assert.equal((found.env as Record<string, unknown>).DATABASE_URL, null);
        assert.equal((found.env as Record<string, unknown>).MIKRO_ORM_PASSWORD, null);
        assert.equal(found.home, '/tmp');
        blocked(found.read, 'ERR_ACCESS_DENIED');
        assert.equal(JSON.stringify(result.document).includes('hunter2'), false);
    });

    test('a timeout removes the container', async () => {
        await assert.rejects(isolated('slow.mjs', config({ timeout: 10, env: { LSV_ADVERSARIAL_PID: '/tmp/worker.pid' } })), /within 10 seconds/);
        const names = spawnSync(RUNTIME, ['ps', '-a', '--filter', 'name=lsv-extract-', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim();
        assert.equal(names, '');
    });

    test('the package is found from the working directory or containerPackagePath, and its worker entry point is checked', async () => {
        const found = await isolated('codegen.mjs', config({ containerPackagePath: '/opt/lsv/node_modules/laranex-schema-viewer' }));
        assert.deepEqual(found.notices, []);
        await assert.rejects(isolated('codegen.mjs', config({ containerPackagePath: '/opt/elsewhere' })), /entry point in image .* is missing or does not run/);
        await assert.rejects(isolated('codegen.mjs', config({ containerImage: 'node:24-slim' })), /Cannot find laranex-schema-viewer from the working directory/);
    });

    test('an image with another version of the package is refused', async (t) => {
        const derived = `${image.split(':')[0] ?? image}-mismatch:${process.pid}`;
        const dockerfile = `FROM ${image}\nUSER root\nRUN sed -i 's/"version": "${VERSION}"/"version": "0.0.0-mismatch"/' node_modules/laranex-schema-viewer/package.json\n`;
        const built = spawnSync(RUNTIME, ['build', '--pull=false', '-q', '-t', derived, '-'], { input: dockerfile, encoding: 'utf8' });
        assert.equal(built.status, 0, built.stderr);
        t.after(() => spawnSync(RUNTIME, ['rmi', '-f', derived], { stdio: 'ignore' }));
        await assert.rejects(isolated('codegen.mjs', config({ containerImage: derived })), /must have laranex-schema-viewer .* \(found: laranex-schema-viewer 0\.0\.0-mismatch\)/);
    });

    test('a missing image is refused without being pulled', async () => {
        const missing = `lsv-no-such-image:missing-${process.pid}`;
        await assert.rejects(isolated('codegen.mjs', config({ containerImage: missing })), /is not available locally, and pulling is disabled/);
        assert.notEqual(spawnSync(RUNTIME, ['image', 'inspect', missing], { stdio: 'ignore' }).status, 0);
    });
});
