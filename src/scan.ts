// `scan`: the shared snapshot scanner (docs/contract.md in laranex-schema-viewer-ui, "Snapshot scanning"). The Git and
// filesystem I/O is the package's own contract/scan.mjs, imported, never copied; its classifier and allowlist rules are
// the package's scanContent()/scanFiles()/resolveAllowlist(). It reads files and runs git (fixed argv, no shell) only:
// no application code, no database, no network.
import { run } from 'laranex-schema-viewer-ui/contract/scan.mjs';

export interface ScanIo {
    cwd?: string;
    stdout?: { write(text: string): unknown };
    stderr?: { write(text: string): unknown };
    // The size limit in bytes; for tests only, the command line always uses the shared 64 MiB.
    limit?: number;
}

// Runs a scan and returns its exit code: 0 clean, 1 confirmed, 2 scan failure or incomplete, 3 uncertain. The flags,
// the summary line, the report and the exit codes are scan.mjs's; only the name in its messages is this command's.
export function scan(argv: string[], io: ScanIo = {}): number {
    const stderr = io.stderr ?? process.stderr;
    const rename = {
        write: (text: string) => stderr.write(text.replace(/^usage: scan\.mjs /gm, 'usage: node-schema-viewer scan ').replace(/^scan\.mjs: /gm, 'node-schema-viewer scan: ')),
    };
    try {
        return run(argv, { cwd: io.cwd ?? process.cwd(), stdout: io.stdout ?? process.stdout, stderr: rename, ...(io.limit === undefined ? {} : { limit: io.limit }) });
    } catch (error) {
        // An unexpected failure (for example an unwritable --report file) leaves the scan incomplete: never 0, 1 or 3.
        stderr.write(`node-schema-viewer scan: ${(error as Error).message || String(error)}\n`);
        return 2;
    }
}
