import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

// Tests are compiled to build/tests/; the repository root is two levels up.
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = join(ROOT, 'dist', 'cli.js');
export const DOCUMENTS = join(ROOT, 'tests', 'fixtures', 'conformance', 'documents');
export const EXPECTED = join(ROOT, 'tests', 'fixtures', 'conformance', 'mcp');
export const DECLARED = join(DOCUMENTS, 'declared-sqlalchemy.json');
export const COMBINED = join(DOCUMENTS, 'combined-drift.json');

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
