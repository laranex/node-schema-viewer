// The check command (drift gate): request derivation, thresholds, exit codes, the summary, --output and failures.
// Byte equality with the shared gate conformance cases and with python-schema-viewer is in parity.test.ts.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalJson, gateDocument, validateGateReport, type GateReport } from 'laranex-schema-viewer-ui/contract';
import { runCli, tempDir, VALID } from './helpers.js';

const TENANTS = join(VALID, 'comparison-tenant-schemas.json');
const MULTI = join(VALID, 'comparison-multi-connection.json');

function project(dir: string, section: unknown, snapshot = TENANTS): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', 'node-schema-viewer': section }));
    copyFileSync(snapshot, join(dir, 'schema-viewer.json'));
}

async function report(args: string[], cwd: string): Promise<{ code: number | null; report: GateReport; stderr: string }> {
    const run = await runCli(['check', '--json', ...args], { cwd });
    const parsed = JSON.parse(run.stdout) as GateReport;
    assert.deepEqual(validateGateReport(parsed, { strict: true }).errors, []);
    assert.equal(run.stdout, canonicalJson(parsed));
    assert.equal(run.code, parsed.exitCode);
    return { code: run.code, report: parsed, stderr: run.stderr };
}

describe('check command', () => {
    test('without configured comparisons checks every stored one, with the default thresholds', async (t) => {
        const dir = tempDir(t);
        project(dir, {});
        const { code, report: r } = await report([], dir);
        assert.equal(code, 1);
        assert.deepEqual(r, gateDocument(JSON.parse(readFileSync(TENANTS, 'utf8'))));
        assert.deepEqual(r.thresholds, { severity: 'warning', certainty: 'certain' });
        assert.deepEqual(r.requested, []);
    });

    test('requests the configured comparisons as configured, * targets unexpanded', async (t) => {
        const dir = tempDir(t);
        const request = { baseline: { connection: 'app', schema: 'tenant_a' }, target: { connection: 'app', schema: '*' } };
        project(dir, { comparisons: [{ ...request, limit: 3 }] });
        const { report: r } = await report([], dir);
        assert.deepEqual(r.requested, [request]);
        assert.deepEqual(r.comparisons, ['c69f5b58e94575f1b']);
        project(dir, { comparisons: [{ baseline: { connection: 'app', schema: 'tenant_b' }, target: { connection: 'app', schema: 'tenant_a' } }] });
        const missing = await report([], dir);
        assert.equal(missing.code, 2);
        assert.deepEqual(missing.report.errors.map((e) => e.kind), ['comparison_not_found']);
    });

    test('named comparisons are computed in memory, then requested; the document is not written', async (t) => {
        const dir = tempDir(t);
        project(dir, { comparisons: [{ baseline: { connection: 'nope' }, target: { connection: 'app' } }] });
        const before = readFileSync(join(dir, 'schema-viewer.json'));
        const { code, report: r } = await report(['app:tenant_b=app:tenant_a', '--limit', '0'], dir);
        assert.equal(code, 2);
        assert.deepEqual(r.requested, [{ baseline: { connection: 'app', schema: 'tenant_b' }, target: { connection: 'app', schema: 'tenant_a' } }]);
        assert.equal(r.comparisons.length, 1);
        assert.match(r.errors[0]?.message ?? '', /^Comparison app:tenant_b → app:tenant_a is incomplete: \d+ of \d+ differences omitted\.$/);
        assert.deepEqual(readFileSync(join(dir, 'schema-viewer.json')), before);
        // An unknown connection is not computed; the gate reports it as not found.
        const unknown = await report(['nope=app:*'], dir);
        assert.equal(unknown.code, 2);
        assert.deepEqual(unknown.report.errors, [{ kind: 'comparison_not_found', message: 'Requested comparison nope → app:* names connection nope, which the document does not have.' }]);
    });

    test('thresholds: flags over configuration over the shared defaults', async (t) => {
        const dir = tempDir(t);
        project(dir, { check: { severity: 'error' } });
        assert.deepEqual((await report([], dir)).report.thresholds, { severity: 'error', certainty: 'certain' });
        project(dir, { check: { severity: 'error', certainty: 'likely' } });
        assert.deepEqual((await report(['--severity', 'info'], dir)).report.thresholds, { severity: 'info', certainty: 'likely' });
        assert.deepEqual((await report(['--certainty', 'certain'], dir)).report.thresholds, { severity: 'error', certainty: 'certain' });
    });

    test('prints a deterministic summary of the verdict, the errors and the qualifying findings', async (t) => {
        const dir = tempDir(t);
        project(dir, {});
        const first = await runCli(['check'], { cwd: dir });
        const second = await runCli(['check'], { cwd: dir });
        assert.equal(first.code, 1);
        assert.equal(first.stdout, second.stdout);
        const lines = first.stdout.split('\n');
        assert.match(lines[0] ?? '', /^Schema check FAILED \(exit code 1\): \d+ of \d+ findings meet the thresholds \(severity warning or above, certain only\)$/);
        assert.equal(lines[1], 'Checked 1 comparisons (every stored one)');
        assert.equal(lines[2], 'Findings that meet the thresholds, most severe first:');
        assert.match(lines[3] ?? '', /^ {2}error {3}certain comparison \w+ {2}app:tenant_a → app:tenant_b · .+: .+ \[x[0-9a-f]{16}\]$/);
        assert.match(first.stdout, /\n\d+ findings below the thresholds are listed in the JSON report \(--json or --output\)\n$/);
        assert.ok(!first.stdout.includes('/') && !first.stdout.includes(String.fromCharCode(27)), 'no paths or colors');
        const passed = await runCli(['check', '--snapshot', join(VALID, 'declared-sqlalchemy.json')], { cwd: dir });
        assert.equal(passed.code, 0);
        assert.equal(passed.stdout, 'Schema check PASSED (exit code 0): 0 of 0 findings meet the thresholds (severity warning or above, certain only)\nChecked 0 comparisons (every stored one)\n');
    });

    test('an invalid, unreadable or non-JSON snapshot is an invalid_document report; details go to stderr only', async (t) => {
        const dir = tempDir(t);
        project(dir, {});
        writeFileSync(join(dir, 'schema-viewer.json'), JSON.stringify({ ...(JSON.parse(readFileSync(MULTI, 'utf8')) as object), connections: 'x' }));
        const invalid = await report([], dir);
        assert.equal(invalid.code, 2);
        assert.deepEqual(invalid.report.errors, [{ kind: 'invalid_document', message: 'The document fails laranex-schema 2.0 validation.' }]);
        assert.match(invalid.stderr, /^schema-viewer\.json: /);
        writeFileSync(join(dir, 'schema-viewer.json'), '{ not json');
        const text = await report([], dir);
        assert.deepEqual(text.report.errors, [{ kind: 'invalid_document', message: 'The input could not be parsed as JSON.' }]);
        assert.match(text.stderr, /^schema-viewer\.json is not JSON: /);
        const missing = await report(['--snapshot', 'missing.json'], dir);
        assert.equal(missing.code, 2);
        assert.deepEqual(missing.report.errors, [{ kind: 'invalid_document', message: 'The input could not be parsed as JSON.' }]);
        assert.match(missing.stderr, /^Cannot read missing\.json: No such file or directory\n$/);
    });

    test('--output writes the JSON report atomically beside the summary', async (t) => {
        const dir = tempDir(t);
        project(dir, {});
        const run = await runCli(['check', '--output', 'reports/gate.json'], { cwd: dir });
        assert.equal(run.code, 1);
        assert.match(run.stdout, /^Schema check FAILED/);
        const json = await runCli(['check', '--json'], { cwd: dir });
        assert.equal(readFileSync(join(dir, 'reports', 'gate.json'), 'utf8'), json.stdout);
        mkdirSync(join(dir, 'taken'));
        const failed = await runCli(['check', '--output', 'taken'], { cwd: dir });
        assert.equal(failed.code, 2);
        assert.equal(failed.stdout, '');
        assert.match(failed.stderr, /^Error: /);
        // A report that cannot be written exits 2 and leaves the previous one intact, with no temporary file.
        const locked = join(dir, 'reports');
        chmodSync(locked, 0o555);
        try {
            const denied = await runCli(['check', '--output', 'reports/gate.json'], { cwd: dir });
            assert.equal(denied.code, 2);
            assert.equal(denied.stdout, '');
            assert.match(denied.stderr, /^Error: .*EACCES/);
            assert.equal(readFileSync(join(locked, 'gate.json'), 'utf8'), json.stdout);
            assert.deepEqual(readdirSync(locked), ['gate.json']);
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    test('a comparison requested twice, configured or named, exits 2 with the shared message before the snapshot is read', async (t) => {
        const dir = tempDir(t);
        const request = { baseline: { connection: 'app', schema: 'tenant_a' }, target: { connection: 'app', schema: '*' } };
        const message = 'Error: Requested comparison app:tenant_a → app:* is listed more than once.\n';
        project(dir, { comparisons: [request, { ...request, limit: 3 }, { baseline: { connection: 'app', schema: 'tenant_a' }, target: { connection: 'app', schema: 'tenant_b' } }, request] });
        for (const args of [[], ['--json'], ['--snapshot', join(dir, 'missing.json')]]) {
            const configured = await runCli(['check', ...args], { cwd: dir });
            assert.deepEqual([configured.code, configured.stdout, configured.stderr], [2, '', message], args.join(' '));
        }
        // Named comparisons replace the configured ones; named twice, they are a usage error even with connections
        // the document does not have.
        for (const named of [['app:tenant_a=app:*', 'app:tenant_a=app:*'], ['nope=app', 'nope=app', 'app=nope:x', 'app=nope:x']]) {
            const run = await runCli(['check', '--json', ...named], { cwd: dir });
            assert.equal(run.code, 2, named.join(' '));
            assert.equal(run.stdout, '');
            assert.equal(
                run.stderr,
                named[0] === 'nope=app'
                    ? 'Error: Requested comparison app → nope:x is listed more than once.\nRequested comparison nope → app is listed more than once.\n'
                    : message,
            );
        }
        project(dir, { comparisons: [request] });
        const once = await runCli(['check', '--json'], { cwd: dir });
        assert.notEqual(once.stdout, '');
    });

    test('usage, configuration and argument errors exit 2, never 0 or 1, and never echo URLs', async (t) => {
        const dir = tempDir(t);
        project(dir, {});
        const secret = 'postgres://user:hunter2@db/app';
        for (const args of [
            ['--nope'],
            ['--severity', 'fatal'],
            ['--certainty', 'maybe'],
            ['--limit', '3'],
            ['--limit', 'x', 'app=app:*'],
            ['app:tenant_a=app:tenant_b', '--limit=-1'],
            ['app:tenant_a'],
            [`app=${secret}`],
            ['app:tenant_a=app:tenant_b', 'app:tenant_a=app:tenant_b'],
        ]) {
            const run = await runCli(['check', ...args], { cwd: dir });
            assert.equal(run.code, 2, args.join(' '));
            assert.equal(run.stdout, '', args.join(' '));
            assert.match(run.stderr, /Error: /, args.join(' '));
            assert.doesNotMatch(run.stderr, /hunter2/);
        }
        project(dir, { check: { severity: 'fatal' } });
        const config = await runCli(['check'], { cwd: dir });
        assert.equal(config.code, 2);
        assert.match(config.stderr, /check severity must be one of error, warning, info/);
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ 'node-schema-viewer': { comparisons: [{ baseline: { connection: secret }, target: { connection: 'b' } }] } }));
        const url = await runCli(['check'], { cwd: dir });
        assert.equal(url.code, 2);
        assert.doesNotMatch(url.stderr, /hunter2/);
    });
});
