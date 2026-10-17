// The schema comparisons a project asks for, computed on a saved document with the shared producer algorithms of
// laranex-schema-viewer-ui (never reimplemented): expandComparisonRequests resolves the requests ("*" targets,
// explicit-over-wildcard precedence, duplicates, unknown connections), compareScopes computes each pair with its
// request's limit and overrides, and storeComparisons stores them with their comparison_incomplete diagnostics.
//
// Comparisons read only what a document already holds: no database connection, no application import, no subprocess.
import { compareScopes, expandComparisonRequests, spellScope, type Comparison, type RequestError, type RequestedComparison, type SchemaDocument, type Scope } from 'laranex-schema-viewer-ui/contract';
import type { ComparisonConfig } from './config.js';
import { byCodePoint } from './schema/serialize.js';

const MAX_VALUE_CHARACTERS = 80;

export class CompareError extends Error {
    override name = 'CompareError';
}

type Document = Pick<SchemaDocument, 'source' | 'connections'>;

// A scope as the command line spells it: the connection's name, then ":schema" (the shared spellScope).
function scopeName(document: Document, scope: Scope): string {
    return spellScope(document.connections.find((c) => c.id === scope.connection)?.name ?? scope.connection, scope.schema);
}

// Comparisons as people request them, by connection name and as written ("*" targets unexpanded).
export function requests(specs: readonly ComparisonConfig[]): RequestedComparison[] {
    return specs.map((spec) => ({
        baseline: { connection: spec.baseline.connection, schema: spec.baseline.schema },
        target: { connection: spec.target.connection, schema: spec.target.schema },
    }));
}

const requestKey = (request: RequestedComparison): string => JSON.stringify([request.baseline, request.target]);

// The comparisons the specs stand for, sorted by id, each pair computed with the limit and overrides of the spec that
// requested it, and the expansion's errors (spelled as the contract spells them). Never throws for a request that
// cannot be resolved: callers decide what an error means.
export function compute(document: Document, specs: readonly ComparisonConfig[]): { comparisons: Comparison[]; errors: RequestError[] } {
    const asked = requests(specs);
    const bySpec = new Map(asked.map((request, i) => [requestKey(request), specs[i] as ComparisonConfig]));
    const { pairs, errors } = expandComparisonRequests(document, asked);
    const comparisons = pairs.map(({ baseline, target, request }) => {
        const { limit, overrides } = bySpec.get(requestKey(request)) as ComparisonConfig;
        return compareScopes(document, baseline, target, { limit, overrides });
    });
    return { comparisons: comparisons.sort((a, b) => byCodePoint(a.id, b.id)), errors };
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
            `${scopeName(document, c.baseline)} -> ${scopeName(document, c.target)} (${state}): ${String(s.missing)} missing, ${String(s.extra)} extra, ${String(s.changed)} changed${omitted}`,
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
