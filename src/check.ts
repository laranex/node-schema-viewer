// The CI drift gate (check command): a thin layer over the shared reference gate, gateDocument from
// laranex-schema-viewer-ui. It reads the saved document, derives the requested comparisons, computes comparisons named
// on the command line in memory, and returns the laranex-schema-gate 1.0 report or a readable summary of it.
//
// Reads only the document: never a database, an ORM, application code or a subprocess, and never writes the document.
// The report's rules are the shared contract's ("Gate reports"); the request derivation and the summary follow
// python-schema-viewer's check command (its docs/check.md), so both CLIs behave the same.
import { closeSync, openSync, readSync } from 'node:fs';
import { getSystemErrorMessage } from 'node:util';
import {
    expandComparisonRequests,
    gateDocument,
    qualifies,
    spellScope,
    storeComparisons,
    validateDocument,
    VERSION,
    type GateReport,
    type GateThresholds,
    type RequestedComparison,
    type SchemaDocument,
} from 'laranex-schema-viewer-ui/contract';
import { CompareError, compute, requests } from './compare.js';
import type { ComparisonConfig } from './config.js';
import { byCodePoint } from './schema/serialize.js';
import { MAX_SNAPSHOT_BYTES } from './snapshot.js';

const RANK = { info: 0, warning: 1, error: 2 } as const;
const VERDICTS = { 0: 'PASSED', 1: 'FAILED', 2: 'INCOMPLETE' } as const;

// The document as the gate receives it (undefined when it could not be read or parsed) and, for stderr only, why it
// could not be read.
export interface Input {
    data: unknown;
    note: string | null;
}

function readBounded(path: string): Buffer {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
        let length = 0;
        let read: number;
        while (length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0) {
            length += read;
        }
        return buffer.subarray(0, length);
    } finally {
        closeSync(fd);
    }
}

// The snapshot parsed as JSON (UTF-8, no BOM), without validating it: validation belongs to the gate.
export function readInput(path: string): Input {
    let raw: Buffer;
    try {
        raw = readBounded(path);
    } catch (error) {
        const { errno, message } = error as NodeJS.ErrnoException;
        const reason = errno === undefined ? message : getSystemErrorMessage(errno);
        return { data: undefined, note: `Cannot read ${path}: ${reason.charAt(0).toUpperCase()}${reason.slice(1)}` };
    }
    if (raw.length > MAX_SNAPSHOT_BYTES) {
        return { data: undefined, note: `${path} exceeds the 32 MiB limit` };
    }
    try {
        return { data: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)) as unknown, note: null };
    } catch (error) {
        return { data: undefined, note: `${path} is not JSON: ${(error as Error).message}` };
    }
}

const versionOf = (data: unknown): string | null => {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return null;
    }
    const version = (data as Record<string, unknown>).version;
    return typeof version === 'string' ? version : null;
};

// The document with specs computed and stored in memory, as compare --write would store them, when it is a valid 2.x
// document. Requests the shared expansion cannot resolve (an unknown connection, a "*" target that expands to nothing)
// are left for the gate, which reports them with the same message. An invalid document is left to the gate.
export function withAdHoc(data: unknown, specs: readonly ComparisonConfig[]): unknown {
    const version = versionOf(data);
    if (version === null) {
        return data;
    }
    const result = validateDocument(data, { strict: version === VERSION });
    if (!result.ok) {
        return data;
    }
    const stored = storeComparisons(result.document, compute(result.document, specs).comparisons);
    // Only the computed arrays change: a newer minor's version and additions stay as read.
    return { ...(data as Record<string, unknown>), comparisons: stored.comparisons, diagnostics: stored.diagnostics };
}

// Expanding requests against no connections finds the errors that do not depend on the document.
const NO_CONNECTIONS: Pick<SchemaDocument, 'source' | 'connections'> = { source: 'database', connections: [] };

// A comparison requested twice, configured or named on the command line, is a configuration or usage error whatever
// the document holds (the gate itself lists each request once). Every other expansion error is the gate's to report.
export function rejectDuplicates(requested: readonly RequestedComparison[]): void {
    const { errors } = expandComparisonRequests(NO_CONNECTIONS, requested);
    const duplicates = errors.filter((e) => e.kind === 'duplicate');
    if (duplicates.length) {
        throw new CompareError(duplicates.map((e) => e.message).join('\n'));
    }
}

// Why a document the gate called invalid failed validation, printed beside the report, never in it.
export function validatorErrors(data: unknown, limit = 5): string[] {
    const version = versionOf(data);
    if (version === null) {
        return [];
    }
    const { errors } = validateDocument(data, { strict: version === VERSION });
    return [...errors.slice(0, limit), ...(errors.length > limit ? [`and ${String(errors.length - limit)} more`] : [])];
}

// A readable, deterministic summary of a report: the verdict, what was checked, the errors and the qualifying findings.
export function summary(report: GateReport): string {
    const { thresholds: t, counts } = report;
    const lines = [
        `Schema check ${VERDICTS[report.exitCode]} (exit code ${String(report.exitCode)}): ${String(counts.qualifying)} of ${String(counts.findings)} findings meet the thresholds (severity ${t.severity} or above, ${t.certainty === 'certain' ? 'certain only' : 'certain or likely'})`,
    ];
    const requested = report.requested.map((r) => `${spellScope(r.baseline.connection, r.baseline.schema)} → ${spellScope(r.target.connection, r.target.schema)}`).join(', ');
    lines.push(`Checked ${String(report.comparisons.length)} comparisons${requested ? ` (requested: ${requested})` : ' (every stored one)'}`);
    if (report.errors.length) {
        lines.push('Errors (the check is incomplete and never passes):');
        lines.push(...report.errors.map((e) => `  ${e.kind}: ${e.message}`));
    }
    const qualifying = report.findings
        .filter((f) => qualifies(f, t))
        .sort((a, b) => RANK[b.severity] - RANK[a.severity] || byCodePoint(a.source, b.source) || byCodePoint(a.label, b.label) || byCodePoint(a.id, b.id));
    if (qualifying.length) {
        lines.push('Findings that meet the thresholds, most severe first:');
        lines.push(...qualifying.map((f) => `  ${f.severity.padEnd(7)} ${f.certainty.padEnd(7)} ${f.source.padEnd(10)} ${f.kind}  ${f.label}: ${f.message} [${f.id}]`));
    }
    const others = counts.findings - counts.qualifying;
    if (others) {
        lines.push(`${String(others)} findings below the thresholds are listed in the JSON report (--json or --output)`);
    }
    return lines.join('\n');
}

// The gate report of the snapshot at path, and notes for stderr. Comparisons named on the command line (adHoc) are
// computed in memory, then requested; otherwise the configured ones are requested as configured. Duplicate requests
// are rejected first (CompareError), before the snapshot is read.
export function run(
    path: string,
    thresholds: Partial<GateThresholds>,
    configured: readonly ComparisonConfig[],
    adHoc: readonly ComparisonConfig[],
): { report: GateReport; notes: string[] } {
    const requested = requests(adHoc.length ? adHoc : configured);
    rejectDuplicates(requested);
    const given = readInput(path);
    const data = adHoc.length ? withAdHoc(given.data, adHoc) : given.data;
    const report = gateDocument(data, { thresholds, requested });
    const notes = given.note === null ? [] : [given.note];
    if (report.errors.some((e) => e.kind === 'invalid_document')) {
        notes.push(...validatorErrors(given.data).map((e) => `${path}: ${e}`));
    }
    return { report, notes };
}
