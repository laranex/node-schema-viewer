// Cross-language parity of compare and check, end to end through the CLI:
// - every shared gate conformance case: its document as the snapshot, its requests as configured comparisons and its
//   thresholds as flags; `check --json` must print exactly the expected report in canonical form;
// - python-schema-viewer's output for documents it built from synthetic databases
//   (tests/fixtures/conformance/python-intel/, recorded by scripts/record-python-intel-conformance.py): the same
//   arguments and configuration must print the same bytes, exit with the same code, write the same document and, for
//   an error, print the same message on stderr (with this package's configuration location and key spelling).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalJson, type GateOptions, type GateReport } from 'laranex-schema-viewer-ui/contract';
import { CONTRACT, ROOT, runCli, tempDir } from './helpers.js';

const INTEL = join(ROOT, 'tests', 'fixtures', 'conformance', 'python-intel');

interface GateCase {
    description: string;
    input: { document: unknown; requested: GateOptions['requested']; thresholds: GateOptions['thresholds'] };
    expected: GateReport;
}

interface IntelCase {
    document: string;
    config: Record<string, unknown>;
    args: string[];
    exitCode: number;
    stdout: string;
    stderr?: string;
    written?: string;
}

function project(dir: string, section: Record<string, unknown>): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'parity', private: true, 'node-schema-viewer': section }));
}

describe('gate conformance through check --json', () => {
    const directory = join(CONTRACT, 'conformance', 'gate');
    const names = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();

    test('runs all 23 shared gate cases', () => {
        assert.equal(names.length, 23);
    });

    for (const name of names) {
        const c = JSON.parse(readFileSync(join(directory, name), 'utf8')) as GateCase;
        test(`${name}: ${c.description}`, async (t) => {
            const dir = tempDir(t);
            writeFileSync(join(dir, 'schema-viewer.json'), JSON.stringify(c.input.document));
            project(dir, { comparisons: c.input.requested ?? [] });
            const flags = Object.entries(c.input.thresholds ?? {}).flatMap(([key, value]) => [`--${key}`, value]);
            const run = await runCli(['check', '--json', ...flags], { cwd: dir });
            assert.equal(run.stdout, canonicalJson(c.expected));
            assert.equal(run.code, c.expected.exitCode);
        });
    }
});

// Python's error text as this package spells it: a comparison's location in pyproject.toml
// ([[tool.laranex-schema-viewer.comparisons]] entry N) is comparisons[N - 1] of "node-schema-viewer" in package.json, and
// the override key object_type is objectType. Every other word is the shared specification's, so equal.
function spelledAsNode(stderr: string, packageJson: string): string {
    return stderr
        .replace(/\[\[tool\.laranex-schema-viewer\.comparisons\]\] entry (\d+)/g, (_, n: string) => `${packageJson} "node-schema-viewer" comparisons[${String(Number(n) - 1)}]`)
        .replaceAll('object_type', 'objectType');
}

describe('python-schema-viewer compare and check output on its own documents', () => {
    const recorded = JSON.parse(readFileSync(join(INTEL, 'cli.json'), 'utf8')) as { pythonCommit: string; cases: IntelCase[] };

    test('covers every recorded document', () => {
        const documents = readdirSync(join(INTEL, 'documents')).map((name) => name.replace(/\.json$/, '')).sort();
        assert.deepEqual([...new Set(recorded.cases.map((c) => c.document))].sort(), documents);
        assert.equal(recorded.cases.length, 39);
    });

    for (const c of recorded.cases) {
        test(`${c.document}: ${c.args.join(' ')}${Object.keys(c.config).length ? ` with ${JSON.stringify(c.config)}` : ''}`, async (t) => {
            const dir = tempDir(t);
            const snapshot = join(dir, 'schema-viewer.json');
            copyFileSync(join(INTEL, 'documents', `${c.document}.json`), snapshot);
            project(dir, c.config);
            const run = await runCli(c.args, { cwd: dir });
            assert.equal(run.stdout, c.stdout, run.stderr);
            assert.equal(run.code, c.exitCode);
            if (c.stderr !== undefined) {
                assert.equal(run.stderr, spelledAsNode(c.stderr, join(realpathSync(dir), 'package.json')));
            }
            if (c.written !== undefined) {
                assert.equal(createHash('sha256').update(readFileSync(snapshot)).digest('hex'), c.written);
            }
        });
    }
});
