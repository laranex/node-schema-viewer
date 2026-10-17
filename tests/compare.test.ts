// The compare command and module: scope pairs, wildcard expansion, the shared algorithm's results, --write.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalJson, compareScopes, storeComparisons, validateDocument, type Comparison, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { compute, describe as describeComparisons } from '../src/compare.js';
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
    const A = { connection: 'connection:app', schema: 'tenant_a' };
    const B = { connection: 'connection:app', schema: 'tenant_b' };

    test('expands requests with the shared expansion and reports what it cannot resolve in the contract\'s words', () => {
        const doc = read(TENANTS);
        assert.deepEqual(compute(doc, [comparisonOption('app:tenant_a=app:*')]), { comparisons: [compareScopes(doc, A, B, { limit: 500 })], errors: [] });
        // A null baseline schema stands for the default schema, public, which the inspection did not read.
        assert.equal(compute(doc, [comparisonOption('app=app:*')]).comparisons.length, 2);
        assert.deepEqual(compute(doc, [comparisonOption('nope=app')]).errors, [
            { kind: 'unknown_connection', request: { baseline: { connection: 'nope', schema: null }, target: { connection: 'app', schema: null } }, message: 'Requested comparison nope → app names connection nope, which the document does not have.' },
        ]);
        const multi = read(MULTI);
        assert.deepEqual(
            compute(multi, [comparisonOption('primary=primary:*')]).errors.map((e) => [e.kind, e.message]),
            [['no_match', 'Requested comparison primary → primary:* matches no schema.']],
        );
        const declared = read(join(VALID, 'declared-sqlalchemy.json'));
        const name = declared.connections[0]?.name ?? '';
        assert.deepEqual(
            compute(declared, [comparisonOption(`${name}=${name}:*`)]).errors.map((e) => [e.kind, e.message]),
            [['no_schemas', `Requested comparison ${name} → ${name}:* cannot be expanded: the inspection of connection ${name} lists no schemas.`]],
        );
    });

    test('an explicit pair takes its own limit and overrides over a * expansion; a request named twice is a duplicate', () => {
        const doc = read(TENANTS);
        const wildcard = { ...comparisonOption('app:tenant_a=app:*'), limit: 1 };
        const explicit = { ...comparisonOption('app:tenant_a=app:tenant_b'), limit: 3, overrides: [{ objectType: 'table' as const, change: 'extra' as const, field: null, severity: 'info' as const }] };
        const expected = compareScopes(doc, A, B, { limit: 3, overrides: explicit.overrides });
        for (const specs of [[wildcard, explicit], [explicit, wildcard]]) {
            assert.deepEqual(compute(doc, specs), { comparisons: [expected], errors: [] });
        }
        for (const spec of [explicit, wildcard]) {
            const { comparisons, errors } = compute(doc, [spec, spec, spec]);
            assert.equal(comparisons.length, 1);
            assert.deepEqual(errors.map((e) => e.kind), ['duplicate']);
            assert.match(errors[0]?.message ?? '', /^Requested comparison app:tenant_a → app:(\*|tenant_b) is listed more than once\.$/);
        }
    });

    test('stores comparison_incomplete diagnostics for omitted differences, coverage gaps, both, and none when complete', () => {
        const tenants = read(TENANTS);
        const incomplete = read(INCOMPLETE);
        const message = (doc: SchemaDocument, option: string, limit: number) => {
            const { comparisons } = compute(doc, [comparisonOption(option, limit)]);
            const empty: SchemaDocument = { ...doc, comparisons: [], diagnostics: [] };
            return storeComparisons(empty, comparisons).diagnostics.map((d) => [d.kind, d.subject.label, d.message]);
        };
        const omitted = compute(tenants, [comparisonOption('app:tenant_a=app:tenant_b', 2)]).comparisons[0] as Comparison;
        const total = omitted.summary.missing + omitted.summary.extra + omitted.summary.changed;
        const gaps = 'the baseline app:tenant_a is not completely covered (checkConstraints unavailable); the target app:tenant_b is not completely covered (checkConstraints unavailable)';
        assert.deepEqual(message(tenants, 'app:tenant_a=app:tenant_b', 2), [
            ['comparison_incomplete', 'app:tenant_a=app:tenant_b', `Comparison app:tenant_a=app:tenant_b is incomplete: ${String(total - 2)} of ${String(total)} differences are left out by the limit of 2`],
        ]);
        assert.deepEqual(message(incomplete, 'app:tenant_a=app:tenant_b', 500), [['comparison_incomplete', 'app:tenant_a=app:tenant_b', `Comparison app:tenant_a=app:tenant_b is incomplete: ${gaps}`]]);
        const both = message(incomplete, 'app:tenant_a=app:tenant_b', 1);
        assert.match(both[0]?.[2] ?? '', new RegExp(`^Comparison app:tenant_a=app:tenant_b is incomplete: \\d+ of \\d+ differences are left out by the limit of 1; ${gaps.replace(/[()]/g, '\\$&')}$`));
        assert.deepEqual(message(tenants, 'app:tenant_a=app:tenant_b', 500), []);
    });

    test('storing replaces comparisons of the same scopes and their diagnostics, keeps the others, and is idempotent', () => {
        const doc = read(MULTI);
        const first = compute(doc, [comparisonOption('primary=replica', 0), comparisonOption('replica:shop=primary')]).comparisons;
        const stored = storeComparisons(doc, first);
        // primary=replica replaces the stored comparison of the same scopes.
        assert.equal(doc.comparisons.length, 1);
        assert.equal(stored.comparisons.length, 2);
        assert.equal(stored.diagnostics.filter((d) => d.kind === 'comparison_incomplete').length, 1);
        assert.deepEqual(storeComparisons(stored, first), stored);
        const second = compute(stored, [comparisonOption('primary=replica')]).comparisons;
        const restored = storeComparisons(stored, second);
        assert.deepEqual(restored.comparisons.map((c) => c.id), stored.comparisons.map((c) => c.id));
        const kept = (d: SchemaDocument) => d.comparisons.find((c) => c.id !== second[0]?.id);
        assert.ok(kept(stored));
        assert.deepEqual(kept(restored), kept(stored));
        assert.equal(restored.diagnostics.filter((d) => d.kind === 'comparison_incomplete').length, 0);
        assert.deepEqual(validateDocument(restored, { strict: true }).errors, []);
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
        assert.deepEqual(written, storeComparisons(read(MULTI), JSON.parse(run.stdout) as Comparison[]));
        writeFileSync(path, JSON.stringify({ ...read(MULTI), version: '2.1' }));
        const before = readFileSync(path, 'utf8');
        const newer = await runCli(['compare', '--snapshot', path, 'primary=replica', '--write']);
        assert.equal(newer.code, 1);
        assert.match(newer.stderr, /is laranex-schema 2\.1; --write rewrites only 2\.0 documents/);
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('--write exits 1 when the document cannot be written, leaving it intact and no temporary file', async (t) => {
        const dir = join(tempDir(t), 'locked');
        mkdirSync(dir);
        const path = join(dir, 'schema.json');
        copyFileSync(MULTI, path);
        chmodSync(dir, 0o555);
        try {
            const run = await runCli(['compare', '--snapshot', path, 'primary=replica', '--write']);
            assert.equal(run.code, 1);
            assert.match(run.stderr, /^Error: .*EACCES/);
            assert.deepEqual(readFileSync(path), readFileSync(MULTI));
            assert.deepEqual(readdirSync(dir), ['schema.json']);
        } finally {
            chmodSync(dir, 0o755);
        }
    });

    test('errors: nothing to compare, unknown connections, limits, malformed scopes and usage', async (t) => {
        const dir = tempDir(t);
        for (const [args, code, message] of [
            [['compare', '--snapshot', TENANTS], 1, /Name comparisons as BASELINE=TARGET/],
            [['compare', '--snapshot', TENANTS, 'app=nope'], 1, /^Error: Requested comparison app → nope names connection nope, which the document does not have\.\n$/],
            [['compare', '--snapshot', MULTI, 'primary=primary:*'], 1, /^Error: Requested comparison primary → primary:\* matches no schema\.\n$/],
            [['compare', '--snapshot', TENANTS, 'app:tenant_a=app:tenant_b', 'app:tenant_a=app:*', 'app:tenant_a=app:*'], 1, /^Error: Requested comparison app:tenant_a → app:\* is listed more than once\.\n$/],
            [['compare', '--snapshot', TENANTS, 'app=nope', 'nope=app:*'], 1, /^Error: Requested comparison app → nope names .*\.\nRequested comparison nope → app:\* names connection nope, .*\.\n$/],
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
        // A configured duplicate fails compare (exit 1) as a named one does; check exits 2 with the same message.
        const request = { baseline: { connection: 'app', schema: 'tenant_a' }, target: { connection: 'app', schema: 'tenant_b' } };
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ 'node-schema-viewer': { comparisons: [request, { ...request, limit: 2 }] } }));
        const message = 'Error: Requested comparison app:tenant_a → app:tenant_b is listed more than once.\n';
        const configured = await runCli(['compare', '--snapshot', TENANTS], { cwd: dir });
        assert.deepEqual([configured.code, configured.stdout, configured.stderr], [1, '', message]);
        const gated = await runCli(['check', '--snapshot', TENANTS], { cwd: dir });
        assert.deepEqual([gated.code, gated.stdout, gated.stderr], [2, '', message]);
        const secret = 'postgres://user:hunter2@db/app';
        const url = await runCli(['compare', '--snapshot', TENANTS, `app=${secret}`]);
        assert.equal(url.code, 1);
        assert.doesNotMatch(url.stderr, /hunter2/);
    });
});
