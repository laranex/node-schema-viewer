// `node-schema-viewer scan` on temporary Git repositories: every scope (the index's staged bytes and files tracked
// before they were ignored, untracked against ignored files, artifacts, history and a shallow clone), the allowlist
// (allowed, tampered, moved, stale, include with a root, invalid), exit codes and their precedence, the summary, the
// report, and byte parity with laranex-schema-viewer-ui's own contract/scan.mjs. The repository's own allowlist is
// checked for being current, and the repository holds exactly its allowlisted synthetic documents.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { allowlistDigest, validateScanReport, type ScanReport } from 'laranex-schema-viewer-ui/contract';
import { scan } from '../src/scan.js';
import { CONTRACT, ROOT, runCli, tempDir, VALID } from './helpers.js';

const SCAN_MJS = join(CONTRACT, 'scan.mjs');
const DOCUMENT = readFileSync(join(VALID, 'database-sqlite-indexes.json'));
// A table name that must never appear in the command's output.
const SECRET = 'lsv_private_payroll_ledger';
const SECRET_DOCUMENT = DOCUMENT.toString('utf8').replace('"notes"', `"${SECRET}"`);
const FRAGMENT = '<p>{"format": "laranex-schema", "version": "2.0"}</p>\n';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root: string, path: string, content: string | Buffer): void {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
}

function repository(t: TestContext): string {
    const root = realpathSync(tempDir(t));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    write(root, 'README.md', 'synthetic\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'init');
    return root;
}

function commitAll(root: string, message: string): void {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', message);
}

async function report(cwd: string, ...args: string[]): Promise<{ code: number | null; report: ScanReport; stderr: string }> {
    const run = await runCli(['scan', ...args, '--json'], { cwd });
    const parsed = JSON.parse(run.stdout) as ScanReport;
    assert.deepEqual(validateScanReport(parsed, { strict: true }).errors, []);
    assert.equal(run.code, parsed.exitCode);
    return { code: run.code, report: parsed, stderr: run.stderr };
}

const statuses = (r: ScanReport) => r.findings.map((f) => `${f.scope} ${f.status} ${f.reason} ${f.path}`);

function allowlist(root: string, entries: { path: string; sha256: string }[], include?: { path: string; root: string }[]): void {
    write(root, '.laranex-schema-allowlist.json', JSON.stringify({ format: 'laranex-schema-allowlist', version: '1.0', entries, ...(include ? { include } : {}) }));
}

const DIGEST = allowlistDigest(new Uint8Array(DOCUMENT));

describe('scan scopes', () => {
    test('tracked reads the index: a file tracked before it was ignored, and the staged bytes', async (t) => {
        const root = repository(t);
        write(root, 'build/schema-viewer.json', DOCUMENT);
        commitAll(root, 'snapshot');
        write(root, '.gitignore', '/build/\n');
        commitAll(root, 'ignore');
        assert.deepEqual(statuses((await report(root, '--tracked')).report), ['tracked confirmed document build/schema-viewer.json']);
        assert.deepEqual((await report(root, '--untracked')).report.findings, []);

        // Staged: a document; working tree: clean. The index is what is scanned.
        write(root, 'staged.json', DOCUMENT);
        git(root, 'add', 'staged.json');
        write(root, 'staged.json', '{}\n');
        // Staged: clean; working tree: a document (not untracked either, since it is tracked).
        write(root, 'unstaged.json', '{}\n');
        git(root, 'add', 'unstaged.json');
        write(root, 'unstaged.json', DOCUMENT);
        const both = await report(root, '--tracked', '--untracked');
        assert.deepEqual(statuses(both.report), ['tracked confirmed document build/schema-viewer.json', 'tracked confirmed document staged.json']);
        assert.equal(both.code, 1);
    });

    test('untracked scans files Git would add, never ignored ones; JavaScript is not read in the tree', async (t) => {
        const root = repository(t);
        write(root, '.gitignore', 'ignored.json\n');
        write(root, 'ignored.json', DOCUMENT);
        write(root, 'new/schema.json', DOCUMENT);
        write(root, 'bundle.js', `JSON.parse('${DOCUMENT.toString('utf8').replace(/\n\s*/g, '')}')`);
        const result = await report(root, '--untracked');
        assert.deepEqual(statuses(result.report), ['untracked confirmed document new/schema.json']);
        assert.equal(result.report.counts.files, 1);
    });

    test('artifacts read every candidate, ignore rules not applied, JavaScript and source maps included', async (t) => {
        const root = repository(t);
        write(root, '.gitignore', '/dist/\n');
        write(root, 'dist/assets/app.js', `const d=JSON.parse('${DOCUMENT.toString('utf8').replace(/\n\s*/g, '')}');`);
        write(root, 'dist/index.html', '<!doctype html><title>x</title>\n');
        write(root, 'dist/notes.txt', DOCUMENT);
        const result = await report(root, '--artifacts', 'dist');
        assert.deepEqual(statuses(result.report), ['artifacts confirmed embedded_json dist/assets/app.js']);
        assert.equal(result.report.counts.files, 2);
        // A symbolic link to a directory is not followed: incomplete.
        symlinkSync(join(root, 'dist', 'assets'), join(root, 'dist', 'linked'));
        const linked = await report(root, '--artifacts', 'dist');
        assert.equal(linked.code, 2);
        assert.ok(statuses(linked.report).includes('artifacts incomplete symlinked_directory dist/linked'));
        // A missing directory fails the scan.
        const missing = await report(root, '--artifacts', 'nowhere');
        assert.equal(missing.code, 2);
        assert.deepEqual(missing.report.errors.map((e) => e.kind), ['artifact_missing']);
    });

    test('history finds a removed snapshot with its commit; a shallow clone fails', async (t) => {
        const root = repository(t);
        write(root, 'old/schema.json', DOCUMENT);
        commitAll(root, 'add');
        const added = git(root, 'rev-parse', 'HEAD').trim();
        git(root, 'rm', '-q', 'old/schema.json');
        commitAll(root, 'remove');
        assert.equal((await report(root, '--tracked')).code, 0);
        const history = await report(root, '--history');
        assert.equal(history.code, 1);
        assert.deepEqual(
            history.report.findings.map((f) => [f.scope, f.status, f.path, f.commit]),
            [['history', 'confirmed', 'old/schema.json', added]],
        );

        const clone = join(realpathSync(tempDir(t)), 'clone');
        execFileSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, clone], { stdio: 'ignore' });
        const shallow = await report(clone, '--history');
        assert.equal(shallow.code, 2);
        assert.deepEqual(shallow.report.errors.map((e) => e.kind), ['history_unavailable']);
    });

    test('outside a Git work tree the Git scopes fail, artifacts still work', async (t) => {
        const dir = realpathSync(tempDir(t));
        write(dir, 'out/schema.json', DOCUMENT);
        for (const scope of ['--tracked', '--untracked', '--history']) {
            const result = await report(dir, scope);
            assert.equal(result.code, 2, scope);
            assert.deepEqual(result.report.errors.map((e) => e.kind), ['not_a_repository'], scope);
        }
        assert.deepEqual(statuses((await report(dir, '--artifacts', 'out')).report), ['artifacts confirmed document out/schema.json']);
    });

    test('the scan root is the Git top level, with its default allowlist, from any subdirectory', async (t) => {
        const root = repository(t);
        write(root, 'tests/fixtures/schema.json', DOCUMENT);
        allowlist(root, [{ path: 'tests/fixtures/schema.json', sha256: DIGEST }]);
        commitAll(root, 'fixture');
        const result = await report(join(root, 'tests'), '--tracked', '--untracked');
        assert.equal(result.code, 0);
        assert.deepEqual(statuses(result.report), ['tracked allowed document tests/fixtures/schema.json']);
    });
});

describe('scan allowlist', () => {
    test('allowed, tampered, moved and stale entries', async (t) => {
        const root = repository(t);
        write(root, 'tests/fixtures/schema.json', DOCUMENT);
        allowlist(root, [
            { path: 'tests/fixtures/schema.json', sha256: DIGEST },
            { path: 'tests/fixtures/gone.json', sha256: DIGEST },
        ]);
        commitAll(root, 'fixtures');
        const stale = await report(root, '--tracked', '--untracked');
        assert.equal(stale.code, 0);
        assert.deepEqual(statuses(stale.report), ['allowlist stale not_found tests/fixtures/gone.json', 'tracked allowed document tests/fixtures/schema.json']);
        // Stale only when both tracked and untracked files were scanned.
        assert.deepEqual(statuses((await report(root, '--tracked')).report), ['tracked allowed document tests/fixtures/schema.json']);

        // CRLF is read as LF: a Windows checkout still matches.
        write(root, 'tests/fixtures/schema.json', DOCUMENT.toString('utf8').replace(/\n/g, '\r\n'));
        git(root, 'add', '-A');
        assert.equal((await report(root, '--tracked')).code, 0);

        write(root, 'tests/fixtures/schema.json', SECRET_DOCUMENT);
        git(root, 'add', '-A');
        const tampered = await report(root, '--tracked');
        assert.equal(tampered.code, 1);
        assert.deepEqual(statuses(tampered.report), ['tracked tampered document tests/fixtures/schema.json']);

        write(root, 'tests/fixtures/schema.json', DOCUMENT);
        git(root, 'add', '-A');
        renameSync(join(root, 'tests/fixtures/schema.json'), join(root, 'tests/fixtures/elsewhere.json'));
        git(root, 'add', '-A');
        const moved = await report(root, '--tracked');
        assert.equal(moved.code, 1);
        assert.deepEqual(statuses(moved.report), ['tracked moved document tests/fixtures/elsewhere.json']);
    });

    test('an include applies its entries under its root', async (t) => {
        const root = repository(t);
        write(root, 'vendor/ui/contract/fixtures/valid/schema.json', DOCUMENT);
        write(root, 'vendor/ui/contract/synthetic.json', JSON.stringify({ format: 'laranex-schema-allowlist', version: '1.0', entries: [{ path: 'contract/fixtures/valid/schema.json', sha256: DIGEST }] }));
        allowlist(root, [], [{ path: 'vendor/ui/contract/synthetic.json', root: 'vendor/ui' }]);
        commitAll(root, 'vendor');
        const result = await report(root, '--tracked', '--untracked');
        assert.equal(result.code, 0);
        assert.deepEqual(statuses(result.report), ['tracked allowed document vendor/ui/contract/fixtures/valid/schema.json']);
    });

    test('an invalid, unreadable or missing allowlist fails the scan, which still reports its findings', async (t) => {
        const root = repository(t);
        write(root, 'schema.json', DOCUMENT);
        commitAll(root, 'snapshot');
        allowlist(root, [{ path: '/abs/schema.json', sha256: DIGEST }]);
        const invalid = await report(root, '--tracked');
        assert.equal(invalid.code, 2);
        assert.deepEqual(invalid.report.errors.map((e) => e.kind), ['allowlist_invalid']);
        assert.deepEqual(statuses(invalid.report), ['tracked confirmed document schema.json']);
        write(root, '.laranex-schema-allowlist.json', '{not json');
        assert.equal((await report(root, '--tracked')).code, 2);
        const missing = await report(root, '--tracked', '--allowlist', 'missing.json');
        assert.equal(missing.code, 2);
        assert.deepEqual(missing.report.errors.map((e) => e.kind), ['allowlist_invalid']);
    });
});

describe('scan exit codes and output', () => {
    test('precedence: incomplete over confirmed over uncertain over clean', async (t) => {
        const root = repository(t);
        assert.equal((await report(root, '--tracked', '--untracked')).code, 0);
        write(root, 'page.html', FRAGMENT);
        assert.equal((await report(root, '--untracked')).code, 3);
        write(root, 'schema.json', DOCUMENT);
        assert.equal((await report(root, '--untracked')).code, 1);
        // Over the size limit: incomplete (exit 2), whatever else was found.
        write(root, 'dist/big.json', '{}');
        let output = '';
        const sink = {
            write: (text: string) => {
                output += text;
            },
        };
        assert.equal(scan(['--untracked', '--artifacts', 'dist'], { cwd: root, stdout: sink, stderr: sink, limit: 1 }), 2);
        assert.match(output, / 4 incomplete, .*; exit 2\n/);
    });

    test('a file over 64 MiB makes the scan incomplete', async (t) => {
        const dir = realpathSync(tempDir(t));
        write(dir, 'dist/big.json', Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
        const result = await report(dir, '--artifacts', 'dist');
        assert.equal(result.code, 2);
        assert.deepEqual(statuses(result.report), ['artifacts incomplete size_limit dist/big.json']);
    });

    test('the summary prints counts only, never content; the report names paths, never content', async (t) => {
        const root = repository(t);
        write(root, 'schema.json', SECRET_DOCUMENT);
        write(root, 'page.html', FRAGMENT);
        const summary = await runCli(['scan', '--untracked'], { cwd: root });
        assert.equal(summary.code, 1);
        assert.equal(
            summary.stdout,
            'laranex-schema-scan: 2 files (untracked); 1 confirmed, 0 tampered, 0 moved, 1 uncertain, 0 incomplete, 0 allowed, 0 stale; exit 1\n' +
                'Paths and reasons are in the report: --report FILE or --json.\n',
        );
        assert.equal(summary.stderr, '');
        const json = await runCli(['scan', '--untracked', '--json', '--report', 'report.json'], { cwd: root });
        for (const text of [summary.stdout, json.stdout, json.stderr, readFileSync(join(root, 'report.json'), 'utf8')]) {
            assert.ok(!text.includes(SECRET));
            assert.ok(!text.includes('"connections"'));
        }
        assert.equal(readFileSync(join(root, 'report.json'), 'utf8'), json.stdout);
        // With --report, the summary does not repeat where the paths are.
        const written = await runCli(['scan', '--untracked', '--report', 'again.json'], { cwd: root });
        assert.equal(written.stdout.split('\n').length, 2);
    });

    test('usage errors and an unwritable report exit 2', async (t) => {
        const root = repository(t);
        for (const args of [[], ['--nope'], ['--artifacts'], ['--report', '--tracked']]) {
            const run = await runCli(['scan', ...args], { cwd: root });
            assert.equal(run.code, 2, args.join(' '));
            assert.equal(run.stdout, '', args.join(' '));
            assert.match(run.stderr, /^node-schema-viewer scan: .+\nusage: node-schema-viewer scan \[--tracked\]/, args.join(' '));
        }
        const unwritable = await runCli(['scan', '--tracked', '--report', join(root, 'missing', 'report.json')], { cwd: root });
        assert.equal(unwritable.code, 2);
        const help = await runCli(['scan', '--help'], { cwd: root });
        assert.equal(help.code, 0);
        assert.match(help.stdout, /\n {2}scan \[--tracked\]/);
    });

    test('reports, summaries and exit codes are byte-identical to contract/scan.mjs', async (t) => {
        const root = repository(t);
        write(root, 'tests/fixtures/schema.json', DOCUMENT);
        write(root, 'tests/fixtures/old.json', DOCUMENT);
        allowlist(root, [
            { path: 'tests/fixtures/schema.json', sha256: DIGEST },
            { path: 'tests/fixtures/gone.json', sha256: DIGEST },
        ]);
        commitAll(root, 'fixtures');
        git(root, 'rm', '-q', 'tests/fixtures/old.json');
        commitAll(root, 'remove');
        write(root, 'page.html', FRAGMENT);
        write(root, 'dist/app.js', `JSON.parse('${DOCUMENT.toString('utf8').replace(/\n\s*/g, '')}')`);
        for (const args of [['--tracked'], ['--untracked'], ['--tracked', '--untracked'], ['--history'], ['--artifacts', 'dist'], ['--tracked', '--untracked', '--history', '--artifacts', 'dist'], ['--tracked', '--allowlist', 'none.json'], []]) {
            for (const output of [[], ['--json']]) {
                const ours = await runCli(['scan', ...args, ...output], { cwd: root });
                const reference = spawnSync(process.execPath, [SCAN_MJS, ...args, ...output], { cwd: root, encoding: 'utf8' });
                assert.equal(ours.code, reference.status, args.join(' '));
                assert.equal(ours.stdout, reference.stdout, args.join(' '));
                assert.equal(ours.stderr, reference.stderr.replace(/scan\.mjs/g, 'node-schema-viewer scan'), args.join(' '));
            }
        }
    });
});

describe('this repository', () => {
    test('.laranex-schema-allowlist.json is what scripts/allowlist.mjs generates', () => {
        const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'allowlist.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
    });

    test('tracks exactly its 16 allowlisted synthetic documents', async () => {
        const result = await report(ROOT, '--tracked');
        assert.equal(result.code, 0, JSON.stringify(result.report.errors));
        assert.equal(result.report.counts.allowed, 16);
        assert.deepEqual(new Set(result.report.findings.map((f) => f.status)), new Set(['allowed']));
    });
});
