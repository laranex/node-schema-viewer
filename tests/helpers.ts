import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { CERTAINTIES, CHANGES, COMPARE_SECTIONS, KINDS, OBJECT_TYPES, SECTIONS, SEVERITIES } from '../src/query.js';
import { buildGraph, canonicalJson, inferAssociations, validateDocument, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';

// Tests are compiled to build/tests/; the repository root is two levels up.
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = join(ROOT, 'dist', 'cli.js');
// python-schema-viewer's MCP conformance recordings (docs/mcp.md there) and the exact text its MCP server sends for
// each call, from scripts/record-mcp-conformance.py.
export const EXPECTED = join(ROOT, 'tests', 'fixtures', 'conformance', 'mcp');
export const EXPECTED_TEXT = join(ROOT, 'tests', 'fixtures', 'conformance', 'mcp-text');
// Recordings whose document the shared contract changed after python-schema-viewer recorded them (at 195c1a6): they
// are skipped, not edited, until they are re-recorded from python-schema-viewer once it adopts the same contract.
export const AWAITING_PYTHON = new Map<string, string>([
    [
        'comparison-incomplete.json',
        'laranex-schema-viewer-ui d9db852 regenerated the comparison-incomplete fixture: its comparison_incomplete diagnostic (id, message, label) and so the revision and every response differ from the recording',
    ],
]);
// The shared contract artifacts, from the installed laranex-schema-viewer-ui package.
export const CONTRACT = join(dirname(fileURLToPath(import.meta.resolve('laranex-schema-viewer-ui/package.json'))), 'contract');
export const VALID = join(CONTRACT, 'fixtures', 'valid');
export const DECLARED = join(VALID, 'declared-sqlalchemy.json');
export const COMBINED = join(VALID, 'combined-drift.json');

// What contract/check.mjs checks of a producer's document, short of its bytes: strict validation, the shared graph
// builder's links and the shared inference's associations.
export function assertProducerDocument(document: SchemaDocument): void {
    assert.deepEqual(validateDocument(document, { strict: true }).errors, []);
    assert.equal(document.version, '2.0');
    const graph = buildGraph(document);
    assert.deepEqual({ links: document.links, derivedLinks: document.derivedLinks }, graph);
    assert.deepEqual(document.inferredAssociations, inferAssociations(document));
}

export function tempDir(t: TestContext): string {
    const directory = mkdtempSync(join(tmpdir(), 'lsv-test-'));
    t.after(() => {
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

// A temporary directory for a whole test file, removed when the process exits.
export function scratchDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'lsv-test-'));
    process.on('exit', () => {
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

export interface Run {
    code: number | null;
    stdout: string;
    stderr: string;
}

export function runCli(args: string[], options: { cwd?: string; input?: string } = {}): Promise<Run> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
        child.stdin.end(options.input ?? '');
    });
}

export interface RecordedCall {
    tool: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    error?: string;
}

export interface Recording {
    name: string;
    // The snapshot the calls run against: a shared valid fixture, or the embedded document written to a file.
    snapshot: string;
    revision: string;
    calls: RecordedCall[];
    texts: { isError: boolean; text: string }[];
    pythonCommit: string;
}

// Every recording, with byte-limit.json's embedded document written (canonically) into `directory`.
export function recordings(directory: string): Recording[] {
    return readdirSync(EXPECTED)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => {
            const raw = JSON.parse(readFileSync(join(EXPECTED, name), 'utf8')) as { document: unknown; revision: string; calls: RecordedCall[] };
            const text = JSON.parse(readFileSync(join(EXPECTED_TEXT, name), 'utf8')) as { pythonCommit: string; texts: Recording['texts'] };
            let snapshot: string;
            if (typeof raw.document === 'string') {
                snapshot = join(VALID, basename(raw.document));
            } else {
                snapshot = join(directory, name);
                writeFileSync(snapshot, canonicalJson(raw.document));
            }
            return { name, snapshot, revision: raw.revision, calls: raw.calls, texts: text.texts, pythonCommit: text.pythonCommit };
        });
}

// Arguments the tool's input schema rejects before the query runs; each SDK words that error its own way.
export function schemaRejected(call: RecordedCall): boolean {
    const { limit, offset, section, kind, object_type: objectType, change, severity, certainty } = call.arguments;
    const outside = (value: unknown, allowed: readonly unknown[]): boolean => value !== undefined && value !== null && !allowed.includes(value);
    return (
        (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)) ||
        (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 0)) ||
        outside(section, call.tool === 'schema_compare' ? COMPARE_SECTIONS : SECTIONS) ||
        outside(kind, KINDS) ||
        outside(objectType, OBJECT_TYPES) ||
        outside(change, CHANGES) ||
        outside(severity, SEVERITIES) ||
        outside(certainty, CERTAINTIES)
    );
}
