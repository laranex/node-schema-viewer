// Starts every example on loopback and checks, with real HTTP requests:
//   - without valid credentials, the page, every viewer file and snapshot.json get 401 with WWW-Authenticate and no
//     schema content;
//   - with them, every file matches the viewer manifest and snapshot.json is the synthetic document;
//   - with NODE_ENV=production (even with SCHEMA_VIEWER_ENABLED=1), or without the opt-in, nothing is served;
//   - for Next.js, `next build` output contains no viewer route, viewer code or snapshot.
// Credentials are random per run and never printed. The snapshot is a synthetic fixture of laranex-schema-viewer-ui.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const snapshot = join(root, 'node_modules/laranex-schema-viewer-ui/contract/fixtures/valid/declared-sqlalchemy.json');
const viewerDirectory = join(root, 'node_modules/laranex-schema-viewer-ui/dist/viewer');
const manifest = JSON.parse(readFileSync(join(viewerDirectory, 'manifest.json'), 'utf8'));
const PREFIX = '/dev/schema-viewer';
// Strings that only a response carrying the schema or the viewer would contain.
const SCHEMA_MARKERS = ['customer_tags', 'laranex-schema', 'order_lines'];
const VIEWER_MARKERS = ['laranex-schema-viewer', 'LaranexSchemaViewer', 'schema-viewer-data', 'lsv-'];

const user = `dev-${randomBytes(4).toString('hex')}`;
const password = randomBytes(18).toString('base64url');
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const AUTH = basic(user, password);
const BAD_HEADERS = [undefined, basic(user, `${password}x`), basic(`${user}x`, password), basic(user, ''), 'Basic', 'Basic !!!', `Bearer ${password}`, basic('', '')];

const freePort = () =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });

async function start(command, args, env, ready = /Listening on|Ready in|started server|Local:/) {
    const port = await freePort();
    const child = spawn(command, args, {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: '1', PORT: String(port), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out starting ${args.join(' ')}:\n${output}`)), 240_000);
        const onData = (chunk) => {
            output += chunk;
            if (ready.test(output)) {
                clearTimeout(timer);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`${args.join(' ')} exited with ${code}:\n${output}`));
        });
    });
    child.removeAllListeners('exit');
    return {
        url: `http://127.0.0.1:${port}`,
        output: () => output,
        stop: () =>
            new Promise((resolve) => {
                if (child.exitCode !== null) {
                    resolve();
                    return;
                }
                child.on('exit', resolve);
                child.kill('SIGTERM');
            }),
    };
}

async function get(base, path, authorization, method = 'GET') {
    const response = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: authorization ? { Authorization: authorization } : {} });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body };
}

const viewerPaths = ['/index.html', ...manifest.files.map((file) => `/${file.path}`).filter((path) => !path.endsWith('.json') && path !== '/index.html')];
const protectedPaths = (indexPath) => ['', '/', indexPath, ...viewerPaths, '/snapshot.json', '/react', '/missing.js', '/manifest.json'];

function assertNoLeak(response, label) {
    const text = response.body.toString('latin1');
    for (const marker of [...SCHEMA_MARKERS, ...VIEWER_MARKERS]) {
        assert.ok(!text.includes(marker), `${label}: the response contains ${marker}`);
    }
    assert.ok(!text.includes(password) && !text.includes(user), `${label}: the response echoes the credentials`);
}

// The shared checks for one running example. indexPath is where the standalone page lives below the prefix.
// trailingSlash: Next.js answers /dev/schema-viewer/ itself with a redirect to /dev/schema-viewer (no content) before
// the proxy runs.
async function checkEnabled(server, { indexPath = '/', reactPage = false, trailingSlashRedirect = false } = {}) {
    const base = server.url;
    const paths = protectedPaths(indexPath).filter((path) => !(trailingSlashRedirect && path === '/'));
    if (trailingSlashRedirect) {
        const slash = await get(base, `${PREFIX}/`);
        assert.equal(slash.status, 308);
        assert.equal(slash.headers.get('location'), PREFIX);
        assertNoLeak(slash, `${PREFIX}/`);
    }
    assert.equal((await get(base, '/')).status, 200, 'the application itself needs no viewer credentials');

    for (const path of paths) {
        for (const header of BAD_HEADERS) {
            for (const method of ['GET', 'HEAD']) {
                const response = await get(base, `${PREFIX}${path}`, header, method);
                const label = `${method} ${PREFIX}${path} with ${header === undefined ? 'no credentials' : 'bad credentials'}`;
                assert.equal(response.status, 401, label);
                assert.match(response.headers.get('www-authenticate') ?? '', /^Basic realm="/, label);
                assert.equal(response.headers.get('cache-control'), 'no-store', label);
                assertNoLeak(response, label);
            }
        }
    }

    const bare = await get(base, PREFIX, AUTH);
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.get('location'), `${PREFIX}${indexPath}`);
    assert.equal(bare.headers.get('cache-control'), 'no-store');

    const page = await get(base, `${PREFIX}${indexPath}`, AUTH);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(page.body.toString(), /<script type="module" src="app\.js"><\/script>/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);

    for (const file of manifest.files.filter((entry) => !entry.path.endsWith('.json'))) {
        const response = await get(base, `${PREFIX}/${file.path}`, AUTH);
        assert.equal(response.status, 200, file.path);
        assert.equal(createHash('sha256').update(response.body).digest('hex'), file.sha256, `${file.path} matches the manifest`);
        assert.equal(response.headers.get('cache-control'), 'no-store', file.path);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', file.path);
    }

    const json = await get(base, `${PREFIX}/snapshot.json`, AUTH);
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(JSON.parse(json.body.toString()), JSON.parse(readFileSync(snapshot, 'utf8')));

    for (const path of ['/manifest.json', '/missing.js']) {
        const missing = await get(base, `${PREFIX}${path}`, AUTH);
        assert.equal(missing.status, 404, `${path} is not served`);
        assert.equal(missing.headers.get('cache-control'), 'no-store', `${path}: errors are not cached either`);
    }
    assert.equal((await get(base, `${PREFIX}/..%2fpackage.json`, AUTH)).status, 404);

    if (reactPage) {
        const react = await get(base, `${PREFIX}/react`, AUTH);
        assert.equal(react.status, 200, 'the React page renders with credentials');
        assert.ok(!SCHEMA_MARKERS.slice(0, 1).some((marker) => react.body.toString().includes(marker)), 'the React page HTML holds no schema');
    }
    assert.ok(!server.output().includes(password), 'the server never logs the password');
}

// noStore: the 404 comes from the example's own code (the Next.js proxy), not from a route that does not exist.
async function checkClosed(server, { trailingSlashRedirect = false, noStore = false } = {}) {
    assert.equal((await get(server.url, '/')).status, 200);
    for (const path of protectedPaths('/index.html').filter((path) => !(trailingSlashRedirect && path === '/'))) {
        for (const header of [undefined, AUTH]) {
            const response = await get(server.url, `${PREFIX}${path}`, header);
            assert.equal(response.status, 404, `${PREFIX}${path} ${header ? 'with' : 'without'} credentials`);
            if (noStore) {
                assert.equal(response.headers.get('cache-control'), 'no-store', `${PREFIX}${path}`);
            }
            assertNoLeak(response, `${PREFIX}${path}`);
        }
    }
}

const enabledEnv = { SCHEMA_VIEWER_ENABLED: '1', SCHEMA_VIEWER_USER: user, SCHEMA_VIEWER_PASSWORD: password, SCHEMA_VIEWER_SNAPSHOT: snapshot };

const servers = [
    ['Express', [process.execPath, ['express/server.mjs']]],
    ['Fastify', [process.execPath, ['fastify/server.mjs']]],
    ['NestJS', [process.execPath, ['nestjs/dist/main.js']]],
];

before(() => {
    const build = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'nestjs/tsconfig.json'], { cwd: root, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stdout + build.stderr);
});

for (const [name, [command, args]] of servers) {
    describe(name, () => {
        test('serves the viewer only to authenticated developers', async () => {
            const server = await start(command, args, { ...enabledEnv, NODE_ENV: 'development' });
            try {
                await checkEnabled(server);
            } finally {
                await server.stop();
            }
        });

        test('has no viewer routes with NODE_ENV=production, even when enabled', async () => {
            const server = await start(command, args, { ...enabledEnv, NODE_ENV: 'production' });
            try {
                await checkClosed(server);
            } finally {
                await server.stop();
            }
        });

        test('has no viewer routes without SCHEMA_VIEWER_ENABLED=1', async () => {
            const server = await start(command, args, { NODE_ENV: 'development', SCHEMA_VIEWER_USER: user, SCHEMA_VIEWER_PASSWORD: password, SCHEMA_VIEWER_SNAPSHOT: snapshot });
            try {
                await checkClosed(server);
            } finally {
                await server.stop();
            }
        });

        test('refuses to start when enabled without credentials, without echoing values', async () => {
            const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, SCHEMA_VIEWER_ENABLED: '1', SCHEMA_VIEWER_USER: user, SCHEMA_VIEWER_SNAPSHOT: snapshot, PORT: '0' } });
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /SCHEMA_VIEWER_PASSWORD is not set/);
            assert.ok(!result.stderr.includes(user) && !result.stdout.includes(user));
            const short = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...enabledEnv, SCHEMA_VIEWER_PASSWORD: 'short', PORT: '0' } });
            assert.notEqual(short.status, 0);
            assert.match(short.stderr, /at least 16 characters/);
        });
    });
}

describe('Next.js', () => {
    const next = join(root, 'node_modules/next/dist/bin/next');
    const distDir = join(root, 'nextjs/.next');
    after(() => rmSync(distDir, { recursive: true, force: true }));

    test('next dev serves the viewer and the React page only to authenticated developers', async () => {
        rmSync(distDir, { recursive: true, force: true });
        const server = await start(process.execPath, [next, 'dev', 'nextjs', '--hostname', '127.0.0.1'], enabledEnv, /Ready in/);
        try {
            await checkEnabled(server, { indexPath: '/index.html', reactPage: true, trailingSlashRedirect: true });
        } finally {
            await server.stop();
        }
    });

    test('next dev without the opt-in has no viewer routes', async () => {
        rmSync(distDir, { recursive: true, force: true });
        const server = await start(process.execPath, [next, 'dev', 'nextjs', '--hostname', '127.0.0.1'], { SCHEMA_VIEWER_USER: user, SCHEMA_VIEWER_PASSWORD: password, SCHEMA_VIEWER_SNAPSHOT: snapshot }, /Ready in/);
        try {
            await checkClosed(server, { trailingSlashRedirect: true, noStore: true });
        } finally {
            await server.stop();
        }
    });

    test('next build excludes the viewer and the snapshot, even with the opt-in set', async () => {
        rmSync(distDir, { recursive: true, force: true });
        const build = spawnSync(process.execPath, [next, 'build', 'nextjs'], {
            cwd: root,
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: '1', ...enabledEnv },
            timeout: 600_000,
        });
        assert.equal(build.status, 0, build.stdout + build.stderr);
        assert.ok(!build.stdout.includes('/dev/schema-viewer/'), `no viewer route is built:\n${build.stdout}`);

        const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? (name === 'cache' ? [] : files(join(dir, name))) : [join(dir, name)]));
        const viewerHashes = new Set(manifest.files.map((file) => file.sha256));
        for (const path of files(distDir)) {
            const bytes = readFileSync(path);
            assert.ok(!viewerHashes.has(createHash('sha256').update(bytes).digest('hex')), `${path} is a viewer file`);
            const text = bytes.toString('latin1');
            for (const marker of [...SCHEMA_MARKERS, 'LaranexSchemaViewer', 'schema-viewer-data', 'data-snapshot-url', 'lsv-', password, user]) {
                assert.ok(!text.includes(marker), `${path} contains ${marker === password || marker === user ? 'a credential' : marker}`);
            }
        }

        const server = await start(process.execPath, [next, 'start', 'nextjs', '--hostname', '127.0.0.1'], { ...enabledEnv, NODE_ENV: 'production' }, /Ready in|Local:/);
        try {
            await checkClosed(server, { trailingSlashRedirect: true, noStore: true });
        } finally {
            await server.stop();
        }
    });
});
