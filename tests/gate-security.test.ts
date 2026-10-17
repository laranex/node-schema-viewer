// compare and check read the saved document and package.json only: no network, no DNS, no child process, no
// database driver, no MCP SDK and no application code. Each command runs under the Node.js Permission Model
// (`--permission`, without --allow-net, --allow-child-process, --allow-worker or --allow-addons) with file reads limited
// to this package's dist/ and package.json, the laranex-schema-viewer-ui package, and the project's package.json and
// snapshot; writes, where a command writes, only to the output's directory (--allow-fs-write). Loading anything else
// (pg, mysql2, the MCP SDK, a project file) is refused with ERR_ACCESS_DENIED. The Permission Model blocks child
// processes everywhere but the network only from Node.js 25 on, so tests/fixtures/sentinel/deny.mjs is preloaded to make
// every network, DNS and child-process call fail loudly on 22 and 24 as well. Node.js 22.23+, 24 and 26 refuse fsync
// under the Permission Model; atomic writes still rename a complete temporary file there (src/snapshot.ts).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

// A copy of a project, for the expected output of a command that writes.
function copy(t: TestContext, dir: string): string {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'lsv-test-')));
    t.after(() => {
        rmSync(other, { recursive: true, force: true });
    });
    for (const name of ['package.json', 'schema-viewer.json']) {
        copyFileSync(join(dir, name), join(other, name));
    }
    return other;
}

// Under the Permission Model with the sentinel: reads as listed, writes only where listed.
function sandboxed(args: string[], cwd: string, options: { writes?: string[]; reads?: string[] } = {}): Promise<Run> {
    const reads = options.reads ?? [join(cwd, 'package.json'), join(cwd, 'schema-viewer.json')];
    const flags = [
        '--permission',
        ...[join(ROOT, 'dist'), join(ROOT, 'package.json'), UI, SENTINEL, ...reads].map((path) => `--allow-fs-read=${path}`),
        ...(options.writes ?? []).map((path) => `--allow-fs-write=${path}`),
        '--import',
        SENTINEL,
    ];
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

    // The snapshot compare --write rewrites, alone in out/; renaming the temporary file over it needs read access there.
    function output(dir: string): string {
        const out = join(dir, 'out');
        mkdirSync(out);
        copyFileSync(TENANTS, join(out, 'schema-viewer.json'));
        mkdirSync(join(dir, 'reports'));
        return out;
    }
    const COMPARE_WRITE = ['compare', '--write', '--snapshot', 'out/schema-viewer.json'];

    test('compare --write and check --output write atomically under the Permission Model, only to the output directory', async (t) => {
        const dir = project(t);
        const out = output(dir);
        const reports = join(dir, 'reports');
        const expected = copy(t, dir);
        assert.equal((await runCli(['compare', '--write'], { cwd: expected })).code, 0);
        const write = await sandboxed(COMPARE_WRITE, dir, { reads: [join(dir, 'package.json'), out], writes: [out] });
        assertClean(write, 'compare --write');
        assert.equal(write.code, 0, write.stderr);
        assert.equal(write.stdout.split('\n').at(-2), 'Stored 1 comparisons in out/schema-viewer.json');
        assert.equal(readFileSync(join(out, 'schema-viewer.json'), 'utf8'), readFileSync(join(expected, 'schema-viewer.json'), 'utf8'));
        const check = await sandboxed(['check', '--output', 'reports/gate.json'], dir, { reads: [join(dir, 'package.json'), join(dir, 'schema-viewer.json'), reports], writes: [reports] });
        assertClean(check, 'check --output');
        assert.equal(check.code, 1, check.stderr);
        assert.equal(readFileSync(join(reports, 'gate.json'), 'utf8'), (await runCli(['check', '--json'], { cwd: dir })).stdout);
        // No temporary file is left beside either output.
        assert.deepEqual(readdirSync(out), ['schema-viewer.json']);
        assert.deepEqual(readdirSync(reports), ['gate.json']);
    });

    test('a write outside the granted directory is refused under the Permission Model and leaves nothing behind', async (t) => {
        const dir = project(t);
        const out = output(dir);
        const reports = join(dir, 'reports');
        const before = readFileSync(join(out, 'schema-viewer.json'));
        const write = await sandboxed(COMPARE_WRITE, dir, { reads: [join(dir, 'package.json'), out], writes: [reports] });
        assert.equal(write.code, 1);
        assert.match(write.stderr, /^Error: Access to this API has been restricted/m);
        assert.deepEqual(readFileSync(join(out, 'schema-viewer.json')), before);
        assert.deepEqual(readdirSync(out), ['schema-viewer.json']);
        const check = await sandboxed(['check', '--output', 'gate.json'], dir, { reads: [join(dir, 'package.json'), join(dir, 'schema-viewer.json'), dir], writes: [reports] });
        assert.equal(check.code, 2);
        assert.equal(check.stdout, '');
        assert.match(check.stderr, /^Error: Access to this API has been restricted/);
        assert.deepEqual(readdirSync(dir).sort(), ['index.js', 'out', 'package.json', 'reports', 'schema-viewer.json']);
        assert.deepEqual(readdirSync(reports), []);
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
