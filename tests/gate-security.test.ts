// compare and check read the saved document and package.json only: no network, no DNS, no child process, no
// database driver, no MCP SDK and no application code. Each command runs under the Node.js Permission Model
// (`--permission`, without --allow-net, --allow-child-process, --allow-worker or --allow-addons) with file reads limited
// to this package's dist/ and package.json, the laranex-schema-viewer-ui package, and the project's package.json and
// snapshot; writes, where a command writes, only to the project directory. Loading anything else (pg, mysql2, the MCP
// SDK, a project file) is refused with ERR_ACCESS_DENIED. The Permission Model blocks child processes everywhere but the
// network only from Node.js 25 on, so tests/fixtures/sentinel/deny.mjs is preloaded to make every network, DNS and
// child-process call fail loudly on 22 and 24 as well. The Permission Model disables fsync, which atomic writes need,
// so compare --write and check --output run with the sentinel alone.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLI, ROOT, runCli, VALID, type Run } from './helpers.js';

const SENTINEL = join(ROOT, 'tests', 'fixtures', 'sentinel', 'deny.mjs');
const UI = dirname(fileURLToPath(import.meta.resolve('laranex-schema-viewer-ui/package.json')));
const TENANTS = join(VALID, 'comparison-tenant-schemas.json');

function project(t: TestContext): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lsv-test-')));
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    copyFileSync(TENANTS, join(dir, 'schema-viewer.json'));
    writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'app', 'node-schema-viewer': { comparisons: [{ baseline: { connection: 'app', schema: 'tenant_a' }, target: { connection: 'app', schema: '*' } }] } }),
    );
    // Application code that would announce itself if anything imported it (it cannot even be read).
    writeFileSync(join(dir, 'index.js'), "process.stderr.write('APPLICATION CODE IMPORTED\\n');\n");
    return dir;
}

// Under the Permission Model with the sentinel; a writing command with the sentinel only.
function sandboxed(args: string[], cwd: string, options: { write?: boolean; reads?: string[] } = {}): Promise<Run> {
    const reads = options.reads ?? [join(cwd, 'package.json'), join(cwd, 'schema-viewer.json')];
    const permission = ['--permission', ...[join(ROOT, 'dist'), join(ROOT, 'package.json'), UI, SENTINEL, ...reads].map((path) => `--allow-fs-read=${path}`)];
    const flags = [...(options.write ? [] : permission), '--import', SENTINEL];
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...flags, CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

function assertClean(run: Run, label: string): void {
    assert.doesNotMatch(run.stderr, /SENTINEL|ERR_ACCESS_DENIED|APPLICATION CODE/, `${label}: ${run.stderr}`);
}

describe('compare and check stay inside the document', () => {
    for (const args of [
        ['compare'],
        ['compare', '--json', 'app:tenant_b=app:*', '--limit', '2'],
        ['check'],
        ['check', '--json', '--severity', 'info', '--certainty', 'likely'],
        ['check', '--json', 'app:tenant_b=app:tenant_a', '--limit', '0'],
        ['check', 'nope=app:*'],
    ]) {
        test(`${args.join(' ')}: same result without network, child processes, drivers or application code`, async (t) => {
            const dir = project(t);
            const expected = await runCli(args, { cwd: dir });
            const run = await sandboxed(args, dir);
            assertClean(run, args.join(' '));
            assert.equal(run.stdout, expected.stdout);
            assert.equal(run.code, expected.code);
            assert.ok(run.stdout.length > 0);
        });
    }

    test('compare --write and check --output make no network or child-process call and import no project code', async (t) => {
        const dir = project(t);
        const write = await sandboxed(['compare', '--write'], dir, { write: true });
        assertClean(write, 'compare --write');
        assert.equal(write.code, 0, write.stderr);
        assert.match(write.stdout, /Stored 1 comparisons in /);
        const output = await sandboxed(['check', '--output', 'gate.json'], dir, { write: true });
        assertClean(output, 'check --output');
        assert.equal(output.code, 1, output.stderr);
        assert.equal(readFileSync(join(dir, 'gate.json'), 'utf8'), (await runCli(['check', '--json'], { cwd: dir })).stdout);
    });

    test('the sandbox is effective: a file outside the granted reads cannot be read, and the sentinel fires', async (t) => {
        const dir = project(t);
        const denied = await sandboxed(['check', '--json'], dir, { reads: [join(dir, 'package.json')] });
        assert.equal(denied.code, 2);
        assert.deepEqual((JSON.parse(denied.stdout) as { errors: unknown[] }).errors, [{ kind: 'invalid_document', message: 'The input could not be parsed as JSON.' }]);
        assert.match(denied.stderr, /^Cannot read schema-viewer\.json: /);
        const probe = await new Promise<Run>((resolve) => {
            const child = spawn(
                process.execPath,
                ['--permission', `--allow-fs-read=${SENTINEL}`, '--import', SENTINEL, '-e', "require('node:net').connect(5432, '127.0.0.1')"],
                { stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let stderr = '';
            child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
            child.on('close', (code) => {
                resolve({ code, stdout: '', stderr });
            });
        });
        assert.notEqual(probe.code, 0);
        assert.match(probe.stderr, /SENTINEL net\.connect/);
    });
});
