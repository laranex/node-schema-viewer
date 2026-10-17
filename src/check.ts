// The CI drift gate (check command): a thin layer over the shared reference gate, gateDocument from
// laranex-schema-viewer-ui. It reads the saved document, derives the requested comparisons, computes comparisons named
// on the command line in memory, and returns the laranex-schema-gate 1.0 report or a readable summary of it.
//
// Reads only the document: never a database, an ORM, application code or a subprocess, and never writes the document.
// The report's rules are the shared contract's ("Gate reports"); the request derivation and the summary follow
// python-schema-viewer's check command (its docs/check.md), so both CLIs behave the same.
import { closeSync, openSync, readSync } from 'node:fs';
import { getSystemErrorMessage } from 'node:util';
import { gateDocument, qualifies, validateDocument, VERSION, type GateReport, type GateThresholds, type RequestedComparison } from 'laranex-schema-viewer-ui/contract';
import { compute, scopes, store } from './compare.js';
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

// Comparisons as the gate takes them, by connection name and as written ("*" targets unexpanded).
export function requests(specs: readonly ComparisonConfig[]): RequestedComparison[] {
    return specs.map((spec) => ({
        baseline: { connection: spec.baseline.connection, schema: spec.baseline.schema },
        target: { connection: spec.target.connection, schema: spec.target.schema },
    }));
}

const versionOf = (data: unknown): string | null => {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return null;
    }
    const version = (data as Record<string, unknown>).version;
    return typeof version === 'string' ? version : null;
};

// The document with specs computed and stored in memory, as compare --write would store them, when it is a valid 2.x
// document. Comparisons that name a connection the document does not have, or a "*" target its inspection cannot
// expand, are left for the gate to report as not found; an invalid document is left to the gate.
export function withAdHoc(data: unknown, specs: readonly ComparisonConfig[]): unknown {
    const version = versionOf(data);
    if (version === null) {
        return data;
    }
    const result = validateDocument(data, { strict: version === VERSION });
    if (!result.ok) {
        return data;
    }
    const document = result.document;
    const resolvable = specs.filter((spec) => {
        try {
            scopes(document, spec);
            return true;
        } catch {
            return false;
        }
    });
    const { comparisons, diagnostics } = compute(document, resolvable);
    const stored = store(document, comparisons, diagnostics);
    // Only the computed arrays change: a newer minor's version and additions stay as read.
    return { ...(data as Record<string, unknown>), comparisons: stored.comparisons, diagnostics: stored.diagnostics };
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

const spell = (scope: { connection: string; schema: string | null }): string => (scope.schema === null ? scope.connection : `${scope.connection}:${scope.schema}`);

// A readable, deterministic summary of a report: the verdict, what was checked, the errors and the qualifying findings.
export function summary(report: GateReport): string {
    const { thresholds: t, counts } = report;
    const lines = [
        `Schema check ${VERDICTS[report.exitCode]} (exit code ${String(report.exitCode)}): ${String(counts.qualifying)} of ${String(counts.findings)} findings meet the thresholds (severity ${t.severity} or above, ${t.certainty === 'certain' ? 'certain only' : 'certain or likely'})`,
    ];
    const requested = report.requested.map((r) => `${spell(r.baseline)} → ${spell(r.target)}`).join(', ');
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
// computed in memory, then requested; otherwise the configured ones are requested as configured.
export function run(
    path: string,
    thresholds: Partial<GateThresholds>,
    configured: readonly ComparisonConfig[],
    adHoc: readonly ComparisonConfig[],
): { report: GateReport; notes: string[] } {
    const given = readInput(path);
    const data = adHoc.length ? withAdHoc(given.data, adHoc) : given.data;
    const report = gateDocument(data, { thresholds, requested: requests(adHoc.length ? adHoc : configured) });
    const notes = given.note === null ? [] : [given.note];
    if (report.errors.some((e) => e.kind === 'invalid_document')) {
        notes.push(...validatorErrors(given.data).map((e) => `${path}: ${e}`));
    }
    return { report, notes };
}
