import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { CLI, COMBINED, DECLARED, ROOT, runCli, tempDir } from './helpers.js';

const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

// Starts serve, waits for its URL line, and returns it with a stop function that resolves to the exit code.
async function startServe(args: string[], cwd: string): Promise<{ url: string; stop: () => Promise<number | null>; stderr: () => string }> {
    const child = spawn(process.execPath, [CLI, 'serve', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    const url = await new Promise<string>((resolve, reject) => {
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
            const match = /Laranex Schema Viewer: (http:\/\/\S+)\n/.exec(stdout);
            if (match?.[1]) {
                resolve(match[1]);
            }
        });
        void closed.then((code) => {
            reject(new Error(`serve exited with ${String(code)}: ${stderr}`));
        });
    });
    return {
        url,
        stderr: () => stderr,
        stop: () => {
            child.kill('SIGTERM');
            return closed;
        },
    };
}

// An address of this machine that is not loopback, to show what serve does and does not listen on.
function externalAddress(): string | undefined {
    return Object.values(networkInterfaces())
        .flat()
        .find((address) => address !== undefined && !address.internal && address.family === 'IPv4')?.address;
}

function connects(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect(port, host, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => {
            resolve(false);
        });
    });
}

describe('cli', () => {
    test('--version and --help', async () => {
        for (const flag of ['--version', '-v']) {
            const run = await runCli([flag]);
            assert.equal(run.code, 0);
            assert.equal(run.stdout, `${VERSION}\n`);
        }
        const help = await runCli(['--help']);
        assert.equal(help.code, 0);
        assert.match(help.stdout, /Usage: node-schema-viewer <command>/);
        assert.match(help.stdout, /serve \[--snapshot PATH\] \[--host HOST\] \[--port PORT\] \[--unsafe-allow-remote\]/);
        for (const command of ['init', 'serve', 'mcp', 'compare', 'check', 'build']) {
            assert.match(help.stdout, new RegExp(`\\n  ${command}`));
        }
    });

    test('usage errors exit 2', async () => {
        for (const args of [[], ['frobnicate'], ['serve', '--nope'], ['serve', 'extra'], ['serve', '--port', 'abc'], ['serve', '--port', '70000'], ['mcp', '--host', 'x']]) {
            const run = await runCli(args);
            assert.equal(run.code, 2, args.join(' '));
            assert.equal(run.stdout, '', args.join(' '));
            assert.match(run.stderr, /Usage:/, args.join(' '));
        }
    });

    test('commands import their modules lazily', () => {
        const source = readFileSync(CLI, 'utf8');
        const staticImports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
        assert.deepEqual(staticImports.sort(), ['./version.js', 'node:util']);
        assert.match(source, /await import\('\.\/server\.js'\)/);
        assert.match(source, /await import\('\.\/mcp\.js'\)/);
    });

    test('init writes the package.json key once', async (t) => {
        const dir = tempDir(t);
        writeFileSync(join(dir, 'package.json'), '{\n  "name": "app"\n}\n');
        const first = await runCli(['init', '--output', 'docs/schema.json'], { cwd: dir });
        assert.equal(first.code, 0, first.stderr);
        assert.match(first.stdout, /Added "node-schema-viewer"/);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), {
            name: 'app',
            'node-schema-viewer': { output: 'docs/schema.json' },
        });
        const second = await runCli(['init', '--project-root', dir]);
        assert.equal(second.code, 1);
        assert.match(second.stderr, /already contains/);
        const empty = tempDir(t);
        const missing = await runCli(['init'], { cwd: empty });
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /No package.json/);
    });

    test('serve uses the configured output and stops cleanly', async (t) => {
        const dir = tempDir(t);
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', 'node-schema-viewer': { output: 'docs/schema.json' } }));
        mkdirSync(join(dir, 'docs'));
        copyFileSync(COMBINED, join(dir, 'docs', 'schema.json'));
        const server = await startServe(['--port', '0'], dir);
        try {
            assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
            const index = await fetch(`${server.url}/`);
            assert.equal(index.status, 200);
            assert.match(await index.text(), /<div id="schema-viewer" data-snapshot-url="snapshot.json">/);
            const snapshot = await fetch(`${server.url}/snapshot.json`);
            assert.equal(snapshot.status, 200);
            assert.equal(((await snapshot.json()) as { source: string }).source, 'combined');
        } finally {
            assert.equal(await server.stop(), 0);
        }
    });

    test('serve --snapshot overrides the default and fails clearly on an invalid one', async (t) => {
        const dir = tempDir(t);
        const server = await startServe(['--snapshot', DECLARED, '--port', '0', '--host', '127.0.0.1'], dir);
        try {
            const snapshot = (await (await fetch(`${server.url}/snapshot.json`)).json()) as { source: string };
            assert.equal(snapshot.source, 'declared');
        } finally {
            await server.stop();
        }
        const missing = await runCli(['serve', '--port', '0'], { cwd: dir });
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /Error: Snapshot not found: .*schema-viewer\.json/);
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ 'node-schema-viewer': { output: 'x.json', databaseUrl: 'x' } }));
        const config = await runCli(['serve', '--port', '0'], { cwd: dir });
        assert.equal(config.code, 1);
        assert.match(config.stderr, /must not contain a database URL/);
    });

    test('serve listens on loopback only by default', async (t) => {
        const server = await startServe(['--snapshot', COMBINED, '--port', '0'], tempDir(t));
        try {
            const port = Number(new URL(server.url).port);
            assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
            assert.equal(await connects('127.0.0.1', port), true);
            const external = externalAddress();
            if (external === undefined) {
                t.diagnostic('no non-loopback IPv4 address on this machine; only the loopback side was checked');
            } else {
                assert.equal(await connects(external, port), false, `${external}:${String(port)} must not accept connections`);
            }
            assert.doesNotMatch(server.stderr(), /Warning/);
        } finally {
            assert.equal(await server.stop(), 0);
        }
    });

    test('serve refuses a host that is not loopback without --unsafe-allow-remote', async (t) => {
        const dir = tempDir(t);
        for (const host of ['0.0.0.0', '::', '10.0.0.1', '128.0.0.1', '::2', '::ffff:10.0.0.1', 'example.com', 'localhost.example', '']) {
            const run = await runCli(['serve', '--snapshot', COMBINED, '--port', '0', '--host', host], { cwd: dir });
            assert.equal(run.code, 2, host);
            assert.equal(run.stdout, '', host);
            assert.match(run.stderr, /^Error: --host .* is not a loopback address \(127\.0\.0\.0\/8, ::1, localhost\)\. The viewer has no authentication and no TLS/, host);
            assert.match(run.stderr, /--unsafe-allow-remote/, host);
            assert.match(run.stderr, /Usage:/, host);
        }
        for (const host of ['localhost', '127.0.0.1']) {
            const server = await startServe(['--snapshot', COMBINED, '--port', '0', '--host', host], dir);
            try {
                assert.equal((await fetch(`${server.url}/`)).status, 200, host);
                assert.doesNotMatch(server.stderr(), /Warning/, host);
            } finally {
                assert.equal(await server.stop(), 0, host);
            }
        }
    });

    test('serve --unsafe-allow-remote binds another address and warns on every start', async (t) => {
        const external = externalAddress();
        if (external === undefined) {
            t.skip('no non-loopback IPv4 address on this machine');
            return;
        }
        for (let start = 0; start < 2; start++) {
            const server = await startServe(['--snapshot', COMBINED, '--port', '0', '--host', external, '--unsafe-allow-remote'], tempDir(t));
            try {
                assert.equal(server.url, `http://${external}:${new URL(server.url).port}`);
                const response = await fetch(`${server.url}/snapshot.json`);
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.equal(
                    server.stderr(),
                    `Warning: --unsafe-allow-remote: serving on ${external}, which is not loopback, with no authentication and no TLS. ` +
                        'Anyone who can reach this address can read the schema; Host checking is not access control. ' +
                        'Use an authenticated HTTPS reverse proxy with the server on loopback instead.\n',
                );
            } finally {
                assert.equal(await server.stop(), 0);
            }
        }
    });
});
