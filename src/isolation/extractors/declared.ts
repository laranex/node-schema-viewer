// What every ORM adapter shares: turning what an ORM declares into the internal schema model (../../schema/model.ts)
// the same way for every ORM, and serializing it as a declared document. A port of python-schema-viewer's
// adapters/__init__.py. Runs in the extraction worker; imports no ORM and never writes document fields.
import { constraintId, identifier, indexId } from '../../schema/ids.js';
import type {
    ColumnModel,
    ConstraintModel,
    DiagnosticModel,
    Feature,
    FeatureLevel,
    IndexModel,
    KeyPartModel,
    OrmExtensions,
    ReferentialAction,
    SchemaModel,
} from '../../schema/model.js';
import { byCodePoint, serialize } from '../../schema/serialize.js';
import type { SchemaDocument } from 'laranex-schema-viewer-ui/contract';

export const GENERATOR = 'node-schema-viewer';

const ACTIONS = new Set<string>(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']);
// python-schema-viewer's adapters.LITERAL: SQL text that is a literal rather than an expression the database evaluates.
const LITERAL = /^(?:'(?:[^']|'')*'(?:::[\w ]+)?|-?\d+(?:\.\d+)?|true|false|null)$/i;
// Every feature an ORM adapter reads from declarations.
const FEATURES: readonly Feature[] = [
    'tables', 'columns', 'columnTypes', 'defaults', 'comments', 'primaryKeys', 'foreignKeys', 'referentialActions', 'indexes',
    'indexExpressions', 'indexPredicates', 'includedColumns', 'uniqueConstraints', 'checkConstraints', 'models', 'relationships',
];

// A database default as SQL text: a literal, or an expression the database evaluates.
export function sqlDefault(text: string): NonNullable<ColumnModel['serverDefault']> {
    return { kind: LITERAL.test(text.trim()) ? 'literal' : 'expression', sql: text };
}

// A referential action as the contract spells it, or null with the ORM's own word when it is not an SQL action.
export function referentialAction(value: string | null | undefined): { action: ReferentialAction | null; raw: string | null } {
    if (value === null || value === undefined) {
        return { action: null, raw: null };
    }
    const normal = value.trim().toUpperCase().replace(/_/g, ' ');
    return ACTIONS.has(normal) ? { action: normal as ReferentialAction, raw: null } : { action: null, raw: value };
}

export function columnPart(column: string, extra: Partial<KeyPartModel> = {}): KeyPartModel {
    return { column, expression: null, order: null, nulls: null, prefixLength: null, collation: null, operatorClass: null, ...extra };
}

export function expressionPart(expression: string): KeyPartModel {
    return { column: null, expression, order: null, nulls: null, prefixLength: null, collation: null, operatorClass: null };
}

// An index as an ORM declares it, before it gets its id from its name or its place in the table.
export type IndexDeclaration = Omit<IndexModel, 'id'>;
export type ConstraintDeclaration = ConstraintModel extends infer C ? (C extends ConstraintModel ? Omit<C, 'id'> : never) : never;

type KeyItem = boolean | string | KeyItem[];
type Key = KeyItem[];

function compareKeys(a: Key, b: Key): number {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        const x = a[i] as KeyItem;
        const y = b[i] as KeyItem;
        const d = Array.isArray(x) && Array.isArray(y) ? compareKeys(x, y) : typeof x === 'boolean' ? Number(x) - Number(y) : byCodePoint(String(x), String(y));
        if (d !== 0) {
            return d;
        }
    }
    return a.length - b.length;
}

// Unnamed indexes and constraints are identified by their place in a deterministic order (python-schema-viewer's
// IndexDeclaration.order and ConstraintDeclaration.order).
export function declaredIndexes(table: string, declarations: readonly IndexDeclaration[]): IndexModel[] {
    const key = (i: IndexDeclaration): Key => [i.name === null, i.name ?? '', i.keyParts.map((p) => [p.column ?? '', p.expression ?? '', p.order ?? '']), i.unique];
    return [...declarations]
        .sort((a, b) => compareKeys(key(a), key(b)))
        .map((i, n) => ({ ...i, id: indexId(table, i.name ?? String(n)) }));
}

export function declaredConstraints(table: string, declarations: readonly ConstraintDeclaration[]): ConstraintModel[] {
    const key = (c: ConstraintDeclaration): Key => [c.kind, c.name === null, c.name ?? '', c.columns, c.kind === 'check' ? c.expression : ''];
    return [...declarations]
        .sort((a, b) => compareKeys(key(a), key(b)))
        .map((c, n) => ({ ...c, id: constraintId(table, c.name ?? String(n)) }));
}

export function relationshipId(model: string, name: string): string {
    return identifier('relationship', model, name);
}

export function modelId(name: string, ...tables: string[]): string {
    return identifier('model', name, ...tables);
}

// What extraction could not represent.
export function diagnostic(kind: string, subject: Partial<DiagnosticModel['subject']> & Pick<DiagnosticModel['subject'], 'type'>, message: string): DiagnosticModel {
    return {
        kind,
        category: 'extraction',
        severity: 'warning',
        certainty: 'certain',
        subject: { type: subject.type, id: subject.id ?? null, columns: subject.columns ?? null, label: subject.label ?? null },
        message,
    };
}

// Every feature complete, except what the adapter reports otherwise.
export function declaredCoverage(levels: Partial<Record<Feature, FeatureLevel>> = {}): Partial<Record<Feature, FeatureLevel>> {
    return { ...Object.fromEntries(FEATURES.map((f) => [f, 'complete'])), ...levels };
}

// Only the namespaces that hold something.
export function extensions(namespace: string, values: Record<string, unknown>): OrmExtensions | undefined {
    const kept = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    return Object.keys(kept).length === 0 ? undefined : { [namespace]: kept as OrmExtensions[string] };
}

export function declaredDocument(model: Omit<SchemaModel, 'source' | 'producer'>): SchemaDocument {
    return serialize({ source: 'declared', producer: GENERATOR, ...model });
}
