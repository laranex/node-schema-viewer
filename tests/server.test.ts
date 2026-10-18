import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { canonicalJson } from 'laranex-schema-viewer-ui/contract';
import { createViewerServer, defaultViewerDirectory, hostname, POLICY, ViewerError } from '../src/server.js';
import { loadDocument } from '../src/snapshot.js';
import { COMBINED, DECLARED, tempDir } from './helpers.js';

const EXACT_POLICY =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

interface Response {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

function request(port: number, path: string, options: { method?: string; host?: string } = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: options.host ?? `127.0.0.1:${port}` } },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

// A raw request, for targets and headers node:http's client would normalize.
function raw(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.end(text));
        let data = '';
        socket.setEncoding('latin1').on('data', (chunk: string) => (data += chunk));
        socket.on('end', () => {
            resolve(data);
        });
        socket.on('error', reject);
    });
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
}

function assertSecurityHeaders(response: Response, label: string): void {
    assert.equal(response.headers['content-security-policy'], EXACT_POLICY, label);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', label);
    assert.equal(response.headers['cache-control'], 'no-store', label);
}

const manifest = JSON.parse(readFileSync(join(defaultViewerDirectory(), 'manifest.json'), 'utf8')) as {
    files: { path: string; sha256: string; size: number }[];
};

describe('viewer server', () => {
    let server: Server;
    let port: number;
    let snapshot: string;
    let dir: string;

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), 'lsv-server-'));
        snapshot = join(dir, 'schema.json');
        copyFileSync(COMBINED, snapshot);
        server = createViewerServer({ snapshot });
        port = await listen(server);
    });
    after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        rmSync(dir, { recursive: true, force: true });
    });

    test('the policy is exactly python-schema-viewer\'s', () => {
        assert.equal(POLICY, EXACT_POLICY);
    });

    test('serves every manifest file, loaded concurrently, with verified bytes and headers', async () => {
        const files = manifest.files.filter((f) => !f.path.endsWith('.json'));
        assert.ok(files.length > 5);
        const responses = await Promise.all(files.map((f) => request(port, `/${f.path}`)));
        responses.forEach((response, i) => {
            const file = files[i];
            assert.ok(file);
            assert.equal(response.status, 200, file.path);
            assert.equal(createHash('sha256').update(response.body).digest('hex'), file.sha256, file.path);
            assert.equal(response.headers['content-length'], String(file.size), file.path);
            assertSecurityHeaders(response, file.path);
        });
        const types = Object.fromEntries(files.map((f, i) => [f.path, responses[i]?.headers['content-type']]));
        assert.equal(types['index.html'], 'text/html; charset=utf-8');
        assert.equal(types['app.js'], 'text/javascript; charset=utf-8');
        assert.equal(types['app.css'], 'text/css; charset=utf-8');
        assert.ok(Object.entries(types).some(([path, type]) => path.endsWith('.woff2') && type === 'font/woff2'));
    });

    test('/ is index.html', async () => {
        const root = await request(port, '/');
        const index = await request(port, '/index.html');
        assert.equal(root.status, 200);
        assert.deepEqual(root.body, index.body);
        assertSecurityHeaders(root, '/');
    });

    test('/snapshot.json is the canonical document', async () => {
        const response = await request(port, '/snapshot.json?x=1');
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
        assert.equal(response.body.toString('utf8'), canonicalJson(loadDocument(COMBINED)));
        assertSecurityHeaders(response, 'snapshot');
    });

    test('HEAD sends headers without a body', async () => {
        for (const path of ['/', '/app.js', '/snapshot.json']) {
            const get = await request(port, path);
            const head = await request(port, path, { method: 'HEAD' });
            assert.equal(head.status, 200, path);
            assert.equal(head.body.length, 0, path);
            assert.equal(head.headers['content-length'], String(get.body.length), path);
            assertSecurityHeaders(head, path);
        }
    });

    test('only GET and HEAD', async () => {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
            const response = await request(port, '/snapshot.json', { method });
            assert.equal(response.status, 405, method);
            assert.equal(response.headers.allow, 'GET, HEAD', method);
            assertSecurityHeaders(response, method);
        }
    });

    test('unknown paths and traversal attempts are 404', async () => {
        for (const path of [
            '/manifest.json',
            '/package.json',
            '/../package.json',
            '/%2e%2e/package.json',
            '/assets/../index.html',
            '/assets/',
            '/app.js/',
            '/APP.JS',
            '/index.html%00',
            '/..%2fpackage.json',
            '/node_modules/laranex-schema-viewer-ui/package.json',
            '/snapshot.json/..',
        ]) {
            const response = await request(port, path);
            assert.equal(response.status, 404, path);
            assertSecurityHeaders(response, path);
        }
        const absolute = await raw(port, `GET http://127.0.0.1:${port}/../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        assert.match(absolute, /^HTTP\/1\.1 404/);
    });

    test('the Host header must name this server or loopback', async () => {
        for (const host of ['localhost', `localhost:${port}`, '127.0.0.1', `[::1]:${port}`, 'LOCALHOST']) {
            assert.equal((await request(port, '/', { host })).status, 200, host);
        }
        for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1.nip.io', '0.0.0.0', '[::2]', 'localhost.evil.example']) {
            const response = await request(port, '/', { host });
            assert.equal(response.status, 403, host);
            assertSecurityHeaders(response, host);
        }
        const missing = await raw(port, 'GET / HTTP/1.0\r\n\r\n');
        assert.match(missing, /^HTTP\/1\.1 403/);
    });

    test('serves the viewer build\'s favicon from its manifest', async () => {
        for (const [path, type] of [['favicon.ico', 'image/x-icon'], ['favicon.svg', 'image/svg+xml']] as const) {
            const entry = manifest.files.find((f) => f.path === path);
            assert.ok(entry, `${path} is listed in the viewer manifest`);
            const response = await request(port, `/${path}`);
            assert.equal(response.status, 200);
            assert.equal(response.headers['content-type'], type);
            assert.equal(createHash('sha256').update(response.body).digest('hex'), entry.sha256);
            assertSecurityHeaders(response, path);
        }
    });

    test('the snapshot is re-read on each request: 503 while invalid', async () => {
        writeFileSync(snapshot, JSON.stringify({ ...(JSON.parse(readFileSync(DECLARED, 'utf8')) as object), version: '1.0' }));
        const invalid = await request(port, '/snapshot.json');
        assert.equal(invalid.status, 503);
        assertSecurityHeaders(invalid, '503');
        writeFileSync(snapshot, readFileSync(DECLARED));
        const valid = await request(port, '/snapshot.json');
        assert.equal(valid.status, 200);
        assert.equal(valid.body.toString('utf8'), canonicalJson(loadDocument(DECLARED)));
    });
});

describe('viewer server startup', () => {
    function viewerCopy(dir: string): string {
        const copy = join(dir, 'viewer');
        cpSync(defaultViewerDirectory(), copy, { recursive: true });
        return copy;
    }

    test('fails on a missing or invalid snapshot before binding', (t) => {
        const dir = tempDir(t);
        assert.throws(() => createViewerServer({ snapshot: join(dir, 'missing.json') }), /Snapshot not found/);
        writeFileSync(join(dir, 'bad.json'), '{}');
        assert.throws(() => createViewerServer({ snapshot: join(dir, 'bad.json') }), /Not a laranex-schema document/);
    });

    test('fails when a viewer file does not match its manifest checksum', (t) => {
        const viewer = viewerCopy(tempDir(t));
        writeFileSync(join(viewer, 'app.js'), `${readFileSync(join(viewer, 'app.js'), 'utf8')}\n// tampered`);
        assert.throws(() => createViewerServer({ snapshot: COMBINED, viewerDirectory: viewer }), (error: Error) => error instanceof ViewerError && /app\.js does not match/.test(error.message));
    });

    test('refuses a viewer build for another contract major', (t) => {
        for (const contract of [{ format: 'laranex-schema', major: 1 }, { format: 'other', major: 2 }, undefined]) {
            const viewer = viewerCopy(tempDir(t));
            const data = JSON.parse(readFileSync(join(viewer, 'manifest.json'), 'utf8')) as Record<string, unknown>;
            data.contract = contract;
            writeFileSync(join(viewer, 'manifest.json'), JSON.stringify(data));
            assert.throws(() => createViewerServer({ snapshot: COMBINED, viewerDirectory: viewer }), /does not read laranex-schema 2\.x/, JSON.stringify(contract));
        }
    });

    test('serves the viewer of the installed contract package', () => {
        const installed = JSON.parse(readFileSync(join(defaultViewerDirectory(), 'manifest.json'), 'utf8')) as { version: string; contract: unknown };
        assert.equal(installed.version, '0.3.0');
        assert.deepEqual(installed.contract, { format: 'laranex-schema', major: 2 });
    });

    test('rejects manifest paths outside the viewer directory', (t) => {
        for (const path of ['../package.json', '/etc/passwd', 'assets/../../x.js', 'a\\b.js', './app.js']) {
            const viewer = viewerCopy(tempDir(t));
            const data = JSON.parse(readFileSync(join(viewer, 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
            data.files.push({ path, sha256: '0'.repeat(64) });
            writeFileSync(join(viewer, 'manifest.json'), JSON.stringify(data));
            assert.throws(() => createViewerServer({ snapshot: COMBINED, viewerDirectory: viewer }), /invalid entry/, path);
        }
    });

    test('favicon.ico is 404 when a viewer build has none, as in python-schema-viewer', async (t) => {
        const viewer = viewerCopy(tempDir(t));
        const data = JSON.parse(readFileSync(join(viewer, 'manifest.json'), 'utf8')) as { files: { path: string }[] };
        data.files = data.files.filter((f) => !f.path.startsWith('favicon.'));
        writeFileSync(join(viewer, 'manifest.json'), JSON.stringify(data));
        const server = createViewerServer({ snapshot: COMBINED, viewerDirectory: viewer });
        const port = await listen(server);
        try {
            const response = await request(port, '/favicon.ico');
            assert.equal(response.status, 404);
            assertSecurityHeaders(response, 'favicon 404');
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('hostname parses Host headers as Python urlsplit does', () => {
        assert.equal(hostname('LocalHost:8765'), 'localhost');
        assert.equal(hostname('[::1]:80'), '::1');
        assert.equal(hostname('user@127.0.0.1:1'), '127.0.0.1');
        assert.equal(hostname(''), null);
        assert.equal(hostname(undefined), null);
        assert.equal(hostname(':80'), null);
    });
});
