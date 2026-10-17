import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { buildGraph, inferAssociations, validateDocument, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';

// Tests are compiled to build/tests/; the repository root is two levels up.
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = join(ROOT, 'dist', 'cli.js');
// python-schema-viewer's recorded MCP responses for laranex-schema 1.0 documents; pending until they are re-recorded
// for 2.0 (see tests/pending.ts).
export const DOCUMENTS = join(ROOT, 'tests', 'fixtures', 'conformance', 'documents');
export const EXPECTED = join(ROOT, 'tests', 'fixtures', 'conformance', 'mcp');
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

// The shared declared fixture with one table widened to `columns` extra columns.
export function largeDocument(columns: number): SchemaDocument {
    const document = JSON.parse(readFileSync(DECLARED, 'utf8')) as SchemaDocument;
    const table = document.connections[0]?.tables[0];
    const template = table?.columns[0];
    assert.ok(table && template);
    for (let n = 0; n < columns; n += 1) {
        table.columns.push({ ...template, name: `wide_${String(n).padStart(4, '0')}`, comment: 'A synthetic column with a description long enough to fill pages' });
    }
    assert.deepEqual(validateDocument(document, { strict: true }).errors, []);
    return document;
}
