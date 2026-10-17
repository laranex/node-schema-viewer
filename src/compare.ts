// The schema comparisons a project asks for, computed on a saved document with the shared algorithm
// (compareScopes from laranex-schema-viewer-ui) and stored in its comparisons array.
//
// Comparisons read only what a document already holds: no database connection, no application import, no subprocess.
// A target schema "*" expands to every schema the target connection's inspection read (its coverage schemas) except
// the baseline's own scope, as the shared gate expands requests. An incomplete comparison gets a comparison_incomplete
// diagnostic that says why, worded as python-schema-viewer words it.
import {
    COMPARISON_FEATURES,
    compareScopes,
    diagnosticId,
    scopeCovered,
    type Comparison,
    type Connection,
    type Coverage,
    type Diagnostic,
    type SchemaDocument,
    type Scope,
} from 'laranex-schema-viewer-ui/contract';
import { spellScope, WILDCARD, type ComparisonConfig, type ScopeConfig } from './config.js';
import { byCodePoint } from './schema/serialize.js';

const MAX_VALUE_CHARACTERS = 80;

export class CompareError extends Error {
    override name = 'CompareError';
}

type Document = Pick<SchemaDocument, 'source' | 'connections'>;

// A scope as the command line spells it: the connection's name, then ":schema".
export function scopeLabel(document: Document, scope: Scope): string {
    const name = document.connections.find((c) => c.id === scope.connection)?.name ?? scope.connection;
    return scope.schema === null ? name : `${name}:${scope.schema}`;
}

function connectionNamed(document: Document, scope: ScopeConfig): Connection {
    const connection = document.connections.find((c) => c.name === scope.connection);
    if (connection === undefined) {
        const names = document.connections.map((c) => c.name).join(', ') || 'none';
        throw new CompareError(`A comparison names connection ${scope.connection}, which the document does not have (connections: ${names})`);
    }
    return connection;
}

const coverageOf = (document: Document, connection: Connection): Coverage | null =>
    document.source === 'declared' ? connection.coverage.declared : connection.coverage.database;

// The scope pairs one configured comparison stands for: one, or one per inspected schema for a "*" target.
export function scopes(document: Document, spec: ComparisonConfig): [Scope, Scope][] {
    const baseline: Scope = { connection: connectionNamed(document, spec.baseline).id, schema: spec.baseline.schema };
    const target = connectionNamed(document, spec.target);
    if (spec.target.schema !== WILDCARD) {
        return [[baseline, { connection: target.id, schema: spec.target.schema }]];
    }
    const schemas = coverageOf(document, target)?.schemas ?? null;
    if (schemas === null) {
        throw new CompareError(`Comparison target ${spellScope(spec.target)} needs a connection whose inspection read named schemas; ${target.name} has none`);
    }
    const sameScope = (schema: string): boolean =>
        target.id === baseline.connection && (schema === baseline.schema || (baseline.schema === null && schema === target.defaultSchema));
    return [...new Set(schemas)]
        .sort(byCodePoint)
        .filter((schema) => !sameScope(schema))
        .map((schema) => [baseline, { connection: target.id, schema }]);
}

// The comparisons, sorted by id, and a diagnostic for each incomplete one. A pair named explicitly takes precedence
// over the same pair from a "*" expansion; naming one pair twice otherwise is an error.
export function compute(document: Document, specs: readonly ComparisonConfig[]): { comparisons: Comparison[]; diagnostics: Diagnostic[] } {
    const chosen = new Map<string, { pair: [Scope, Scope]; spec: ComparisonConfig; explicit: boolean }>();
    for (const spec of specs) {
        const explicit = spec.target.schema !== WILDCARD;
        for (const pair of scopes(document, spec)) {
            const key = JSON.stringify(pair);
            const previous = chosen.get(key);
            if (previous !== undefined) {
                if (previous.explicit === explicit) {
                    throw new CompareError(`Comparison ${scopeLabel(document, pair[0])}=${scopeLabel(document, pair[1])} is configured more than once`);
                }
                if (!explicit) {
                    continue;
                }
            }
            chosen.set(key, { pair, spec, explicit });
        }
    }
    const comparisons: Comparison[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const { pair, spec } of chosen.values()) {
        const overrides = spec.overrides.map((o) => ({ objectType: o.objectType, change: o.change, field: o.field, severity: o.severity }));
        const comparison = compareScopes(document, pair[0], pair[1], { overrides, limit: spec.limit });
        comparisons.push(comparison);
        if (!comparison.complete) {
            diagnostics.push(incomplete(document, comparison, spec.limit));
        }
    }
    return { comparisons: comparisons.sort((a, b) => byCodePoint(a.id, b.id)), diagnostics };
}

// Why a side cannot be compared completely (scopeCovered decides; this only words it): the compared features its
// coverage does not have complete or not applicable, and its schema when the coverage did not read it.
function coverageGaps(document: Document, scope: Scope): string[] {
    const connection = document.connections.find((c) => c.id === scope.connection);
    if (connection === undefined) {
        return [];
    }
    const coverage = coverageOf(document, connection);
    if (scopeCovered(coverage, connection, scope.schema)) {
        return [];
    }
    if (coverage === null) {
        return ['coverage unknown'];
    }
    const gaps = COMPARISON_FEATURES.filter((f) => coverage.features[f] !== 'complete' && coverage.features[f] !== 'not_applicable').map(
        (f) => `${f} ${coverage.features[f] ?? 'unknown'}`,
    );
    const read = scope.schema ?? connection.defaultSchema;
    if (read !== null && coverage.schemas !== null && !coverage.schemas.includes(read)) {
        gaps.push(`schema ${read} not read`);
    }
    return gaps;
}

function incomplete(document: Document, comparison: Comparison, limit: number): Diagnostic {
    const reasons: string[] = [];
    if (comparison.omitted) {
        const { missing, extra, changed } = comparison.summary;
        reasons.push(`${String(comparison.omitted)} of ${String(missing + extra + changed)} differences are left out by the limit of ${String(limit)}`);
    }
    for (const [side, scope] of [['baseline', comparison.baseline], ['target', comparison.target]] as const) {
        const gaps = coverageGaps(document, scope);
        if (gaps.length) {
            reasons.push(`the ${side} ${scopeLabel(document, scope)} is not completely covered (${gaps.join(', ')})`);
        }
    }
    const label = `${scopeLabel(document, comparison.baseline)}=${scopeLabel(document, comparison.target)}`;
    const subject = { type: 'comparison' as const, id: comparison.id, columns: null, label };
    const message = `Comparison ${label} is incomplete: ${reasons.join('; ')}`;
    return { id: diagnosticId({ kind: 'comparison_incomplete', subject, message }), kind: 'comparison_incomplete', category: 'inspection', severity: 'warning', certainty: 'certain', subject, message };
}

const diagnosticOrder = (a: Diagnostic, b: Diagnostic): number => {
    const x = [a.category, a.kind, a.subject.type, a.subject.id ?? '', a.message];
    const y = [b.category, b.kind, b.subject.type, b.subject.id ?? '', b.message];
    for (let i = 0; i < x.length; i += 1) {
        const d = byCodePoint(x[i] ?? '', y[i] ?? '');
        if (d !== 0) {
            return d;
        }
    }
    return 0;
};

// The document with computed comparisons and their diagnostics. Comparisons it already holds for the same scopes, and
// their diagnostics, are replaced; others are kept. Diagnostics stay in canonical order, each id listed once.
export function store<T extends SchemaDocument>(document: T, comparisons: readonly Comparison[], diagnostics: readonly Diagnostic[]): T {
    const ids = new Set(comparisons.map((c) => c.id));
    const kept = document.comparisons.filter((c) => !ids.has(c.id));
    const previous = document.diagnostics.filter((d) => !(d.subject.type === 'comparison' && d.subject.id !== null && ids.has(d.subject.id)));
    const unique = new Map<string, Diagnostic>();
    for (const d of [...previous, ...diagnostics].sort(diagnosticOrder)) {
        if (!unique.has(d.id)) {
            unique.set(d.id, d);
        }
    }
    return { ...document, comparisons: [...kept, ...comparisons].sort((a, b) => byCodePoint(a.id, b.id)), diagnostics: [...unique.values()] };
}

function value(item: unknown): string {
    const text = JSON.stringify(item);
    // Python truncates by code points.
    const characters = Array.from(text);
    return characters.length <= MAX_VALUE_CHARACTERS ? text : `${characters.slice(0, MAX_VALUE_CHARACTERS - 1).join('')}…`;
}

// A readable summary: one line per comparison, then one per listed difference.
export function describe(document: Document, comparisons: readonly Comparison[]): string {
    const lines: string[] = [];
    for (const c of comparisons) {
        const s = c.summary;
        const state = c.complete ? 'complete' : 'incomplete';
        const omitted = c.omitted ? `, ${String(c.omitted)} not listed` : '';
        lines.push(
            `${scopeLabel(document, c.baseline)} -> ${scopeLabel(document, c.target)} (${state}): ${String(s.missing)} missing, ${String(s.extra)} extra, ${String(s.changed)} changed${omitted}`,
        );
        for (const d of c.differences) {
            const side = d.baseline ?? d.target;
            const label = side ? side.label : d.key.join('/');
            const fields = d.fields.map((f) => `${f.field} ${value(f.baseline)} -> ${value(f.target)}`).join('; ');
            lines.push(`  ${d.severity.padEnd(7)} ${d.certainty.padEnd(7)} ${d.change.padEnd(7)} ${d.objectType.padEnd(10)} ${label}${fields ? `  ${fields}` : ''}`);
        }
    }
    return lines.join('\n');
}
