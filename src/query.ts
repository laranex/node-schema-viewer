// Bounded, read-only queries over one saved laranex-schema 2.x document, shared by the MCP tools. A port of
// python-schema-viewer's query.py; the response format is the shared specification, python-schema-viewer's
// docs/mcp.md, and tests/fixtures/conformance/mcp holds python-schema-viewer's recorded responses with the exact text
// its MCP server sends. Items are the document's own contract objects, apart from the overview's table summaries,
// search hits and foreign-key entries.
//
// Key order is part of the response text. Contract objects are written in python-schema-viewer's field order
// (pyOrder below), as its serializer writes them, so both packages send the same bytes.
import type { Comparison, Connection, Diagnostic, SchemaDocument, Scope, Table } from 'laranex-schema-viewer-ui/contract';
import { loadDocument, revision as documentRevision } from './snapshot.js';

export const MAX_RESPONSE_BYTES = 64 * 1024;
// Room kept for nextOffset, which is set after the items that fit are chosen.
export const RESERVED_BYTES = 128;
export const SECTIONS = ['columns', 'indexes', 'foreign_keys', 'constraints', 'models', 'relationships', 'links', 'derived_links', 'diagnostics'] as const;
export const KINDS = ['orm', 'foreign_key'] as const;
const CATEGORIES = ['extraction', 'inspection', 'reconciliation', 'drift', 'lint'] as const;
export const SEVERITIES = ['error', 'warning', 'info'] as const;
export const CERTAINTIES = ['certain', 'likely'] as const;
export const COMPARE_SECTIONS = ['comparisons', 'differences'] as const;
export const OBJECT_TYPES = ['table', 'column', 'primaryKey', 'index', 'foreignKey', 'constraint'] as const;
export const CHANGES = ['missing', 'extra', 'changed'] as const;

type Row = Record<string, unknown>;

export class QueryError extends Error {
    override name = 'QueryError';
}

// schema_compare's selection and difference filters; null when not given.
export interface CompareFilters {
    comparison?: string | null;
    baseline?: string | null;
    target?: string | null;
    objectType?: string | null;
    change?: string | null;
    severity?: string | null;
    certainty?: string | null;
}

export interface Pagination {
    limit?: number;
    offset?: number;
    revision?: string | null;
}

export interface Page extends Row {
    revision: string;
    total: number;
    offset: number;
    limit: number;
    items: unknown[];
    nextOffset: number | null;
}

// UTF-8 bytes of compact JSON (no whitespace, non-ASCII unescaped).
export function size(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// Python's str.casefold, closely enough for search: full case folding per code point (ß and ẞ fold to ss, Σ and ς to
// σ, ligatures expand) without JavaScript's locale and context rules; dotless ı stays distinct from i, as in Python.
export function casefold(text: string): string {
    let out = '';
    for (const c of text) {
        out += c === 'ı' ? c : c === 'ẞ' ? 'ss' : c.toUpperCase().toLowerCase();
    }
    return out;
}

// python-schema-viewer's model field order per contract object (its dataclasses), which its serializer follows.
// Optional fields it leaves out: drift when empty, extensions and dialectOptions when unset, and unset index options.
type Shape = readonly (string | readonly [string, string])[];
const SHAPES: Record<string, Shape> = {
    drift: ['field', 'database', 'declared'],
    coverage: ['complete', 'schemas', 'features'],
    connectionCoverage: [['database', 'coverage'], ['declared', 'coverage']],
    column: [
        'name', 'type', 'nullable', 'provenance', 'typeName', 'autoIncrement', 'timezone', 'collation', ['enum', 'enumType'],
        ['default', 'value'], ['ormDefault', 'value'], ['generated', 'generated'], 'comment', 'note', ['drift', 'drift'], 'extensions',
    ],
    enumType: ['name', 'values'],
    value: ['kind', 'value'],
    generated: ['kind', 'expression'],
    part: ['column', 'expression', 'order', 'nulls', 'length', 'collation', 'opclass'],
    backs: ['kind', 'constraint'],
    indexOptions: ['method', 'predicate', 'included', 'options'],
    index: [
        'id', 'name', ['parts', 'part'], 'unique', 'provenance', 'expression', ['backs', 'backs'], 'method', 'partial', 'predicate',
        'included', ['dialectOptions', 'indexOptions'], ['drift', 'drift'], 'extensions',
    ],
    foreignKey: [
        'id', 'name', 'columns', 'foreignTable', 'foreignColumns', 'provenance', 'onUpdate', 'onDelete', 'deferrable', 'initially',
        ['drift', 'drift'], 'extensions',
    ],
    constraint: ['id', 'kind', 'name', 'provenance', 'columns', 'expression', ['drift', 'drift'], 'extensions'],
    owner: ['kind', 'package'],
    table: [
        'id', 'name', 'provenance', 'schema', 'comment', 'note', ['owner', 'owner'], 'primaryKey', ['columns', 'column'],
        ['indexes', 'index'], ['foreignKeys', 'foreignKey'], ['constraints', 'constraint'], ['drift', 'drift'], 'extensions',
    ],
    source: ['file', 'line'],
    model: ['id', 'className', 'tables', 'primaryKey', ['source', 'source'], 'extensions'],
    endpoint: ['table', 'columns'],
    keys: [['from', 'endpoint'], ['to', 'endpoint']],
    pivot: ['table', 'parentColumns', 'parentPivotColumns', 'relatedColumns', 'relatedPivotColumns', 'columns'],
    polymorphic: ['typeColumn', 'idColumn', 'typeValue'],
    join: ['primary', 'secondary'],
    relationship: [
        'id', 'name', 'model', 'table', 'relatedModel', 'relatedTable', 'type', 'cardinality', 'collection', 'readOnly', ['keys', 'keys'],
        ['pivot', 'pivot'], ['polymorphic', 'polymorphic'], 'through', ['join', 'join'], 'constraints', 'inverse', 'note',
        ['source', 'source'], 'extensions',
    ],
    link: ['id', ['from', 'endpoint'], ['to', 'endpoint'], 'foreignKey', 'relationships', 'state', 'polymorphic', 'note'],
    derivedLink: ['id', 'from', 'to', 'via', 'relationship'],
    subject: ['type', 'id', 'columns', 'label'],
    // The diagnostic id is computed from its content, and written last.
    diagnostic: ['kind', 'category', 'severity', 'certainty', ['subject', 'subject'], 'message', 'extensions', 'id'],
    generator: ['name', 'orm'],
    scope: ['connection', 'schema'],
    summary: ['missing', 'extra', 'changed'],
    comparison: ['id', ['baseline', 'scope'], ['target', 'scope'], 'complete', 'omitted', ['summary', 'summary'], ['differences', 'difference'], 'extensions'],
    differenceRef: ['table', 'id', 'label'],
    fieldDifference: ['field', 'baseline', 'target'],
    difference: [
        'id', 'change', 'objectType', 'key', ['baseline', 'differenceRef'], ['target', 'differenceRef'], ['fields', 'fieldDifference'], 'severity', 'certainty',
        'extensions',
    ],
};

const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// A contract object (or a list of them) in python-schema-viewer's key order, without the properties its model does
// not have.
export function pyOrder(kind: string, value: unknown): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (Array.isArray(value)) {
        return value.map((v) => pyOrder(kind, v));
    }
    const source = value as Row;
    if (kind === 'indexOptions') {
        // A mapping of dialect -> options, each option written only when set.
        return Object.fromEntries(
            Object.entries(source).map(([dialect, options]) => [
                dialect,
                Object.fromEntries((SHAPES.indexOptions as readonly string[]).flatMap((key) => (options as Row)[key] == null ? [] : [[key, (options as Row)[key]]])),
            ]),
        );
    }
    const out: Row = {};
    for (const entry of SHAPES[kind] ?? []) {
        const [key, nested] = typeof entry === 'string' ? [entry, null] : entry;
        const item = source[key];
        if ((key === 'drift' && (!Array.isArray(item) || item.length === 0)) || ((key === 'extensions' || key === 'dialectOptions') && item == null)) {
            continue;
        }
        out[key] = nested === null ? (item ?? null) : pyOrder(nested, item);
    }
    if (kind === 'drift') {
        out.field = camel(snake(String(source.field)));
    }
    return out;
}

export class SnapshotQuery {
    readonly document: SchemaDocument;
    readonly revision: string;
    readonly tables: Map<string, Table>;
    readonly models: Map<string, SchemaDocument['models'][number]>;
    readonly comparisons: Map<string, Comparison>;
    private readonly connectionOf: Map<string, Connection>;

    constructor(document: SchemaDocument) {
        this.document = document;
        this.revision = documentRevision(document);
        this.connectionOf = new Map(document.connections.flatMap((c) => c.tables.map((t) => [t.id, c] as const)));
        this.tables = new Map(this.allTables().map((t) => [t.id, t]));
        this.models = new Map(document.models.map((m) => [m.id, m]));
        this.comparisons = new Map(document.comparisons.map((c) => [c.id, c]));
    }

    static fromFile(path: string): SnapshotQuery {
        return new SnapshotQuery(loadDocument(path));
    }

    private allTables(): Table[] {
        return this.document.connections.flatMap((c) => c.tables);
    }

    page(items: unknown[], { limit = 25, offset = 0, revision = null }: Pagination = {}, context: Row = {}): Page {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new QueryError('limit must be an integer from 1 to 100');
        }
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
            throw new QueryError('offset must be a nonnegative integer');
        }
        if (revision !== null && revision !== this.revision) {
            throw new QueryError('Document revision differs; restart pagination without revision');
        }
        const result: Page = { ...context, revision: this.revision, total: items.length, offset, limit, items: [], nextOffset: null };
        for (const item of items.slice(offset, offset + limit)) {
            result.items.push(item);
            if (size(result) > MAX_RESPONSE_BYTES - RESERVED_BYTES) {
                result.items.pop();
                if (result.items.length === 0) {
                    throw new QueryError('One result exceeds the response byte limit');
                }
                break;
            }
        }
        const end = offset + result.items.length;
        result.nextOffset = end < items.length ? end : null;
        if (size(result) > MAX_RESPONSE_BYTES) {
            throw new QueryError('Response metadata exceeds the response byte limit');
        }
        return result;
    }

    overview(pagination: Pagination = {}): Page {
        const doc = this.document;
        const tables = this.allTables();
        const drifted = (entities: { drift?: unknown[] }[]): number => entities.filter((e) => (e.drift?.length ?? 0) > 0).length;
        const physical = tables.flatMap((t) => [t, ...t.columns, ...t.indexes, ...t.foreignKeys, ...t.constraints]);
        const sum = (f: (t: Table) => number): number => tables.reduce((n, t) => n + f(t), 0);
        const counts = {
            connections: doc.connections.length,
            tables: tables.length,
            columns: sum((t) => t.columns.length),
            indexes: sum((t) => t.indexes.length),
            foreignKeys: sum((t) => t.foreignKeys.length),
            constraints: sum((t) => t.constraints.length),
            models: doc.models.length,
            relationships: doc.relationships.length,
            links: doc.links.length,
            derivedLinks: doc.derivedLinks.length,
            diagnostics: doc.diagnostics.length,
            drift: drifted(physical),
            comparisons: doc.comparisons.length,
            migrations: doc.migrations.length,
            inferredAssociations: doc.inferredAssociations.length,
        };
        const by = (name: 'category' | 'severity' | 'certainty', values: readonly string[]): Row =>
            Object.fromEntries(values.map((value) => [value, doc.diagnostics.filter((d) => d[name] === value).length]));
        const connections = doc.connections.map((c) => ({
            id: c.id,
            name: c.name,
            driver: c.driver,
            defaultSchema: c.defaultSchema,
            coverage: pyOrder('connectionCoverage', c.coverage),
            tables: c.tables.length,
        }));
        return this.page(
            tables.map((t) => this.summary(t)),
            pagination,
            {
                version: doc.version,
                source: doc.source,
                generator: pyOrder('generator', doc.generator),
                note: doc.note,
                connections,
                counts,
                diagnosticCounts: { category: by('category', CATEGORIES), severity: by('severity', SEVERITIES), certainty: by('certainty', CERTAINTIES) },
            },
        );
    }

    private summary(table: Table): Row {
        const entities: { drift?: unknown[] }[] = [table, ...table.columns, ...table.indexes, ...table.foreignKeys, ...table.constraints];
        return {
            id: table.id,
            connection: this.connectionOf.get(table.id)?.id,
            name: table.name,
            schema: table.schema,
            provenance: [...table.provenance],
            counts: {
                columns: table.columns.length,
                indexes: table.indexes.length,
                foreignKeys: table.foreignKeys.length,
                constraints: table.constraints.length,
                drift: entities.filter((e) => (e.drift?.length ?? 0) > 0).length,
                diagnostics: this.tableDiagnostics(table).length,
            },
        };
    }

    // Diagnostics about the table, its columns, or its indexes, foreign keys and constraints.
    private tableDiagnostics(table: Table): Diagnostic[] {
        const own = new Set([table.id, ...table.indexes.map((x) => x.id), ...table.foreignKeys.map((x) => x.id), ...table.constraints.map((x) => x.id)]);
        const types = new Set(['table', 'column', 'index', 'foreignKey', 'constraint']);
        return this.document.diagnostics.filter((d) => types.has(d.subject.type) && d.subject.id !== null && own.has(d.subject.id));
    }

    // Relationships declared from, to, through or over a pivot of the table.
    private tableRelationships(table: string): SchemaDocument['relationships'] {
        return this.document.relationships.filter(
            (r) => r.table === table || r.relatedTable === table || r.pivot?.table === table || (r.through ?? []).includes(table),
        );
    }

    getTable(table: string, section = 'columns', pagination: Pagination = {}): Page {
        const value = this.tables.get(table);
        if (value === undefined) {
            throw new QueryError('Unknown table ID; use schema_overview or schema_search');
        }
        if (!(SECTIONS as readonly string[]).includes(section)) {
            throw new QueryError(`Unknown table section: ${section}`);
        }
        const doc = this.document;
        const sections: Record<(typeof SECTIONS)[number], unknown[]> = {
            columns: pyOrder('column', value.columns) as unknown[],
            indexes: pyOrder('index', value.indexes) as unknown[],
            foreign_keys: pyOrder('foreignKey', value.foreignKeys) as unknown[],
            constraints: pyOrder('constraint', value.constraints) as unknown[],
            models: pyOrder('model', doc.models.filter((m) => m.tables.includes(table))) as unknown[],
            relationships: pyOrder('relationship', this.tableRelationships(table)) as unknown[],
            links: pyOrder('link', doc.links.filter((l) => l.from.table === table || l.to.table === table)) as unknown[],
            derived_links: pyOrder('derivedLink', doc.derivedLinks.filter((l) => l.from === table || l.to === table || l.via.includes(table))) as unknown[],
            diagnostics: pyOrder('diagnostic', this.tableDiagnostics(value)) as unknown[],
        };
        const header = pyOrder('table', value) as Row;
        for (const key of ['columns', 'indexes', 'foreignKeys', 'constraints']) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the four fixed sections
            delete header[key];
        }
        const connection = this.connectionOf.get(table);
        return this.page(sections[section as (typeof SECTIONS)[number]], pagination, {
            table: header,
            connection: { id: connection?.id, name: connection?.name, driver: connection?.driver, defaultSchema: connection?.defaultSchema },
            section,
            counts: Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, items.length])),
        });
    }

    getModel(model: string, pagination: Pagination = {}): Page {
        const value = this.models.get(model);
        if (value === undefined) {
            throw new QueryError('Unknown model ID; use schema_search');
        }
        const items = pyOrder('relationship', this.document.relationships.filter((r) => r.model === model)) as unknown[];
        return this.page(items, pagination, { model: pyOrder('model', value) });
    }

    relationships(table: string | null = null, kind = 'orm', pagination: Pagination = {}): Page {
        if (table !== null && !this.tables.has(table)) {
            throw new QueryError('Unknown table ID');
        }
        let items: unknown[];
        if (kind === 'orm') {
            items = pyOrder('relationship', table === null ? this.document.relationships : this.tableRelationships(table)) as unknown[];
        } else if (kind === 'foreign_key') {
            items = this.allTables().flatMap((t) =>
                t.foreignKeys
                    .filter((fk) => table === null || table === t.id || table === fk.foreignTable)
                    .map((fk) => ({ table: t.id, foreignKey: pyOrder('foreignKey', fk) })),
            );
        } else {
            throw new QueryError('kind must be orm or foreign_key');
        }
        return this.page(items, pagination, { kind, table });
    }

    search(query: string, pagination: Pagination = {}): Page {
        // Python counts code points: a surrogate pair is one character.
        const length = typeof query === 'string' ? query.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '.').length : 0;
        if (length < 1 || length > 200) {
            throw new QueryError('query must contain 1 to 200 characters');
        }
        const needle = casefold(query);
        const items: Row[] = [];
        const hit = (kind: string, id: string | null, table: string | null, name: string): void => {
            items.push({ kind, id, table, name });
        };
        for (const table of this.allTables()) {
            // Python's ".".join(filter(None, ...)): empty and null parts are left out.
            const qualified = [this.connectionOf.get(table.id)?.name, table.schema, table.name].filter((p): p is string => Boolean(p)).join('.');
            if (casefold(qualified).includes(needle)) {
                hit('table', table.id, table.id, table.name);
            }
            for (const column of table.columns) {
                if (casefold(column.name).includes(needle)) {
                    hit('column', null, table.id, column.name);
                }
            }
            for (const [kind, entities] of [['index', table.indexes], ['foreignKey', table.foreignKeys], ['constraint', table.constraints]] as const) {
                for (const entity of entities) {
                    if (entity.name !== null && casefold(entity.name).includes(needle)) {
                        hit(kind, entity.id, table.id, entity.name);
                    }
                }
            }
        }
        for (const model of this.document.models) {
            if (casefold(model.className).includes(needle)) {
                hit('model', model.id, null, model.className);
            }
        }
        for (const r of this.document.relationships) {
            if (casefold(`${r.name} ${r.type}`).includes(needle)) {
                hit('relationship', r.id, r.table, r.name);
            }
        }
        return this.page(items, pagination, { query });
    }

    // A scope as the command line spells it: the connection's name, then ":schema".
    private scopeLabel(scope: Scope): string {
        const name = this.document.connections.find((c) => c.id === scope.connection)?.name ?? scope.connection;
        return scope.schema === null ? name : `${name}:${scope.schema}`;
    }

    private scopeFilter(value: string | null, side: 'baseline' | 'target'): Scope | null {
        if (value === null) {
            return null;
        }
        if (typeof value !== 'string') {
            throw new QueryError(`${side} must be CONNECTION or CONNECTION:SCHEMA`);
        }
        // Python's str.partition(":").
        const separator = value.indexOf(':');
        const name = separator < 0 ? value : value.slice(0, separator);
        const schema = separator < 0 ? '' : value.slice(separator + 1);
        if (separator >= 0 && !schema) {
            throw new QueryError(`${side} must be CONNECTION or CONNECTION:SCHEMA`);
        }
        const connection = this.document.connections.find((c) => c.name === name);
        if (connection === undefined) {
            throw new QueryError(`Unknown ${side} connection; use schema_overview`);
        }
        return { connection: connection.id, schema: separator < 0 ? null : schema };
    }

    // Stored comparisons, or their differences, selected by comparison id or scopes and difference filters.
    compare(section = 'comparisons', filters: CompareFilters = {}, pagination: Pagination = {}): Page {
        const { comparison = null, baseline = null, target = null, objectType = null, change = null, severity = null, certainty = null } = filters;
        if (!(COMPARE_SECTIONS as readonly string[]).includes(section)) {
            throw new QueryError('section must be comparisons or differences');
        }
        if (comparison !== null && !this.comparisons.has(comparison)) {
            throw new QueryError('Unknown comparison ID; use schema_compare');
        }
        const scopes = { baseline: this.scopeFilter(baseline, 'baseline'), target: this.scopeFilter(target, 'target') };
        const given = { objectType, change, severity, certainty };
        for (const [name, value, allowed] of [
            ['object_type', objectType, OBJECT_TYPES],
            ['change', change, CHANGES],
            ['severity', severity, SEVERITIES],
            ['certainty', certainty, CERTAINTIES],
        ] as const) {
            if (value !== null && !(allowed as readonly string[]).includes(value)) {
                throw new QueryError(`${name} must be one of ${allowed.join(', ')}`);
            }
        }
        if (section === 'comparisons' && Object.values(given).some((v) => v !== null)) {
            throw new QueryError('object_type, change, severity and certainty filter differences; use section differences');
        }
        const same = (a: Scope, b: Scope | null): boolean => b === null || (a.connection === b.connection && a.schema === b.schema);
        const selected = this.document.comparisons.filter(
            (c) => (comparison === null || c.id === comparison) && same(c.baseline, scopes.baseline) && same(c.target, scopes.target),
        );
        const context = { section, filters: { comparison, baseline, target, ...given } };
        if (section === 'comparisons') {
            return this.page(
                selected.map((c) => this.comparisonSummary(c)),
                pagination,
                context,
            );
        }
        const items = selected.flatMap((c) =>
            c.differences
                .filter(
                    (d) =>
                        (objectType === null || d.objectType === objectType) &&
                        (change === null || d.change === change) &&
                        (severity === null || d.severity === severity) &&
                        (certainty === null || d.certainty === certainty),
                )
                .map((d) => ({ comparison: c.id, difference: pyOrder('difference', d) })),
        );
        return this.page(items, pagination, { ...context, comparisons: selected.length, omitted: selected.reduce((n, c) => n + c.omitted, 0) });
    }

    // The Comparison object without its differences, with readable scope labels and counts of the listed ones.
    private comparisonSummary(comparison: Comparison): Row {
        const summary = pyOrder('comparison', comparison) as Row;
        delete summary.differences;
        const listed = comparison.differences;
        const count = (key: 'severity' | 'certainty', values: readonly string[]): Row => Object.fromEntries(values.map((v) => [v, listed.filter((d) => d[key] === v).length]));
        summary.labels = { baseline: this.scopeLabel(comparison.baseline), target: this.scopeLabel(comparison.target) };
        summary.counts = { differences: listed.length, ...count('severity', SEVERITIES), ...count('certainty', CERTAINTIES) };
        return summary;
    }
}
