// The compare command and module: scope pairs, wildcard expansion, the shared algorithm's results, --write.
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalJson, compareScopes, validateDocument, type Comparison, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { compute, describe as describeComparisons, scopes, store } from '../src/compare.js';
import { comparisonOption } from '../src/config.js';
import { runCli, tempDir, VALID } from './helpers.js';

const TENANTS = join(VALID, 'comparison-tenant-schemas.json');
const MULTI = join(VALID, 'comparison-multi-connection.json');
const INCOMPLETE = join(VALID, 'comparison-incomplete.json');
const read = (path: string): SchemaDocument => JSON.parse(readFileSync(path, 'utf8')) as SchemaDocument;

function project(dir: string, section: unknown): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', 'node-schema-viewer': section }));
}

describe('compare module', () => {
    test('expands a * target to the inspected schemas except the baseline scope', () => {
        const doc = read(TENANTS);
        assert.deepEqual(scopes(doc, comparisonOption('app:tenant_a=app:*')), [[{ connection: 'connection:app', schema: 'tenant_a' }, { connection: 'connection:app', schema: 'tenant_b' }]]);
        // A null baseline schema stands for the default schema, public, which the inspection did not read.
        assert.equal(scopes(doc, comparisonOption('app=app:*')).length, 2);
        assert.throws(() => scopes(doc, comparisonOption('nope=app')), /names connection nope, which the document does not have \(connections: app\)/);
        const declared = read(join(VALID, 'declared-sqlalchemy.json'));
        const name = declared.connections[0]?.name ?? '';
        assert.throws(() => scopes(declared, comparisonOption(`${name}=${name}:*`)), /needs a connection whose inspection read named schemas/);
    });

    test('computes with the shared algorithm; an explicit pair wins over a * expansion, a pair named twice is an error', () => {
        const doc = read(TENANTS);
        const wildcard = { ...comparisonOption('app:tenant_a=app:*'), limit: 1 };
        const explicit = comparisonOption('app:tenant_a=app:tenant_b');
        const expected = compareScopes(doc, { connection: 'connection:app', schema: 'tenant_a' }, { connection: 'connection:app', schema: 'tenant_b' }, { limit: 500, overrides: [] });
        for (const specs of [[wildcard, explicit], [explicit, wildcard]]) {
            const { comparisons, diagnostics } = compute(doc, specs);
            assert.deepEqual(comparisons, [expected]);
            assert.deepEqual(diagnostics, []);
        }
        assert.throws(() => compute(doc, [explicit, explicit]), /Comparison app:tenant_a=app:tenant_b is configured more than once/);
        assert.throws(() => compute(doc, [wildcard, wildcard]), /configured more than once/);
    });

    test('applies severity overrides and reports an incomplete comparison', () => {
        const doc = read(TENANTS);
        const spec = { ...comparisonOption('app:tenant_a=app:tenant_b'), limit: 2, overrides: [{ objectType: 'table' as const, change: 'extra' as const, field: null, severity: 'info' as const }] };
        const { comparisons, diagnostics } = compute(doc, [spec]);
        const [comparison] = comparisons as [Comparison];
        assert.equal(comparison.complete, false);
        assert.equal(comparison.differences.length, 2);
        assert.ok(comparison.differences.filter((d) => d.objectType === 'table' && d.change === 'extra').every((d) => d.severity === 'info'));
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0]?.kind, 'comparison_incomplete');
        assert.equal(diagnostics[0].message, `Comparison app:tenant_a=app:tenant_b is incomplete: ${String(comparison.omitted)} of ${String(comparison.omitted + 2)} differences are left out by the limit of 2`);
        const gaps = compute(read(INCOMPLETE), [comparisonOption('app:tenant_a=app:tenant_b')]).diagnostics[0]?.message;
        assert.equal(
            gaps,
            'Comparison app:tenant_a=app:tenant_b is incomplete: the baseline app:tenant_a is not completely covered (checkConstraints unavailable); the target app:tenant_b is not completely covered (checkConstraints unavailable)',
        );
    });

    test('store replaces comparisons of the same scopes and their diagnostics, and keeps the others', () => {
        const doc = read(MULTI);
        const first = compute(doc, [{ ...comparisonOption('primary=replica'), limit: 0 }, comparisonOption('replica:shop=primary')]);
        const stored = store(doc, first.comparisons, first.diagnostics);
        // primary=replica replaces the stored comparison of the same scopes.
        assert.equal(doc.comparisons.length, 1);
        assert.equal(stored.comparisons.length, 2);
        assert.equal(stored.diagnostics.filter((d) => d.kind === 'comparison_incomplete').length, 1);
        const second = compute(stored, [comparisonOption('primary=replica')]);
        const restored = store(stored, second.comparisons, second.diagnostics);
        assert.deepEqual(restored.comparisons.map((c) => c.id), stored.comparisons.map((c) => c.id));
        const kept = (d: SchemaDocument) => d.comparisons.find((c) => c.id !== second.comparisons[0]?.id);
        assert.ok(kept(stored));
        assert.deepEqual(kept(restored), kept(stored));
        assert.equal(restored.diagnostics.filter((d) => d.kind === 'comparison_incomplete').length, 0);
        assert.deepEqual(validateDocument(restored, { strict: true }).errors, []);
        assert.deepEqual(
            restored.comparisons.map((c) => c.id),
            restored.comparisons.map((c) => c.id).sort(),
        );
    });

    test('describes comparisons one line each, then one per listed difference', () => {
        const doc = read(TENANTS);
        const text = describeComparisons(doc, compute(doc, [comparisonOption('app:tenant_a=app:tenant_b')]).comparisons);
        const lines = text.split('\n');
        assert.match(lines[0] ?? '', /^app:tenant_a -> app:tenant_b \(complete\): \d+ missing, \d+ extra, \d+ changed$/);
        assert.ok(lines.slice(1).every((line) => /^ {2}(error|warning|info) +(certain|likely) +(missing|extra|changed) +\w+ +\S/.test(line)), text);
    });
});

describe('compare command', () => {
    test('prints a summary, or the comparison objects as canonical JSON', async () => {
        const json = await runCli(['compare', '--snapshot', TENANTS, 'app:tenant_a=app:*', '--json']);
        assert.equal(json.code, 0, json.stderr);
        const doc = read(TENANTS);
        assert.equal(json.stdout, canonicalJson(compute(doc, [comparisonOption('app:tenant_a=app:*')]).comparisons));
        const text = await runCli(['compare', '--snapshot', TENANTS, 'app:tenant_a=app:tenant_b', '--limit', '1']);
        assert.equal(text.code, 0, text.stderr);
        assert.match(text.stdout, /^app:tenant_a -> app:tenant_b \(incomplete\): .* not listed\n {2}\S.*\n$/);
        const none = await runCli(['compare', '--snapshot', MULTI, 'primary=primary:*']);
        assert.equal(none.code, 0, none.stderr);
        assert.equal(none.stdout, 'No scope pairs to compare\n');
    });

    test('uses the configured comparisons and output without arguments', async (t) => {
        const dir = tempDir(t);
        copyFileSync(TENANTS, join(dir, 'schema.json'));
        project(dir, { output: 'schema.json', comparisons: [{ baseline: { connection: 'app', schema: 'tenant_b' }, target: { connection: 'app', schema: '*' }, limit: 0 }] });
        const run = await runCli(['compare'], { cwd: dir });
        assert.equal(run.code, 0, run.stderr);
        assert.match(run.stdout, /^app:tenant_b -> app:tenant_a \(incomplete\): .* not listed\n$/);
    });

    test('--write stores the comparisons strictly validated and atomically, and refuses newer minors', async (t) => {
        const dir = tempDir(t);
        const path = join(dir, 'schema.json');
        copyFileSync(MULTI, path);
        const run = await runCli(['compare', '--snapshot', path, 'primary=replica', '--write', '--json']);
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.stderr, `Stored 1 comparisons in ${path}\n`);
        const written = read(path);
        assert.deepEqual(validateDocument(written, { strict: true }).errors, []);
        assert.equal(readFileSync(path, 'utf8'), canonicalJson(written));
        assert.deepEqual(written.comparisons, store(read(MULTI), JSON.parse(run.stdout) as Comparison[], []).comparisons);
        writeFileSync(path, JSON.stringify({ ...read(MULTI), version: '2.1' }));
        const before = readFileSync(path, 'utf8');
        const newer = await runCli(['compare', '--snapshot', path, 'primary=replica', '--write']);
        assert.equal(newer.code, 1);
        assert.match(newer.stderr, /is laranex-schema 2\.1; --write rewrites only 2\.0 documents/);
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('errors: nothing to compare, unknown connections, limits, malformed scopes and usage', async (t) => {
        const dir = tempDir(t);
        for (const [args, code, message] of [
            [['compare', '--snapshot', TENANTS], 1, /Name comparisons as BASELINE=TARGET/],
            [['compare', '--snapshot', TENANTS, 'app=nope'], 1, /names connection nope, which the document does not have/],
            [['compare', '--snapshot', TENANTS, '--limit', '3'], 1, /A comparison limit applies to comparisons named on the command line/],
            [['compare', '--snapshot', TENANTS, 'app:tenant_a=app:tenant_b', '--limit=-1'], 1, /nonnegative integer/],
            [['compare', '--snapshot', TENANTS, 'app:tenant_a'], 1, /A comparison is BASELINE=TARGET/],
            [['compare', '--snapshot', join(dir, 'missing.json'), 'a=b'], 1, /Snapshot not found/],
            [['compare', '--limit', 'x', 'a=b'], 2, /--limit must be an integer/],
            [['compare', '--nope'], 2, /Usage:/],
        ] as const) {
            const run = await runCli([...args], { cwd: dir });
            assert.equal(run.code, code, args.join(' '));
            assert.match(run.stderr, message, args.join(' '));
        }
        const secret = 'postgres://user:hunter2@db/app';
        const url = await runCli(['compare', '--snapshot', TENANTS, `app=${secret}`]);
        assert.equal(url.code, 1);
        assert.doesNotMatch(url.stderr, /hunter2/);
    });
});
