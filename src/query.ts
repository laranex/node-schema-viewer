// Bounded, read-only queries shared by the MCP tools. A port of python-schema-viewer's query.py (SnapshotQuery and the
// unified_view projection): the same fields, in the same order, with the same pagination and byte limits, so both
// packages answer the same tool calls with the same responses (tests/fixtures/conformance/mcp holds the evidence).
import type {
    Column,
    Connection,
    Coverage,
    Diagnostic,
    Drift,
    Index,
    Model,
    Relationship,
    SchemaDocument,
    Table,
} from 'laranex-schema-viewer-ui/contract';
import { loadDocument, revision as documentRevision } from './snapshot.js';

export const MAX_RESPONSE_BYTES = 64 * 1024;
const SCOPES = { declared: 'declared_metadata', database: 'database_metadata', combined: 'combined_metadata' } as const;
const DIALECTS: Record<string, string> = { pgsql: 'postgresql' };

type Row = Record<string, unknown>;

export class QueryError extends Error {
    override name = 'QueryError';
}

export interface Pagination {
    limit?: number;
    offset?: number;
    revision?: string | null;
}

export interface Page extends Row {
    revision: string;
    total: number;
    items: unknown[];
    next_offset: number | null;
}

// Python truthiness: unlike JavaScript, empty lists and objects are false.
function truthy(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (value !== null && typeof value === 'object') {
        return Object.keys(value).length > 0;
    }
    return Boolean(value);
}

// Python's zip: pairs up to the shorter list.
function zip<A, B>(a: readonly A[], b: readonly B[]): [A, B][] {
    return Array.from({ length: Math.min(a.length, b.length) }, (_, i) => [a[i] as A, b[i] as B]);
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

// Python's float repr for the byte count of json.dumps; integers print as JavaScript prints them.
function pythonNumber(value: number): string {
    if (Number.isInteger(value) && Math.abs(value) < 1e16) {
        return String(value);
    }
    if (!Number.isFinite(value)) {
        return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
    }
    const [mantissa = '', exponentText = '0'] = value.toExponential().split('e');
    const exponent = Number(exponentText);
    if (exponent < -4 || exponent >= 16) {
        return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
    }
    const digits = mantissa.replace('-', '').replace('.', '');
    const sign = value < 0 ? '-' : '';
    if (exponent < 0) {
        return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
    }
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
    return `${sign}${whole}.${digits.slice(exponent + 1) || '0'}`;
}

// The UTF-8 length of Python's json.dumps(value, ensure_ascii=False): ", " and ": " separators.
export function pythonJsonBytes(value: unknown): number {
    if (value === null || value === undefined) {
        return 4;
    }
    if (typeof value === 'boolean') {
        return value ? 4 : 5;
    }
    if (typeof value === 'number') {
        return pythonNumber(value).length;
    }
    if (typeof value === 'string') {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    if (Array.isArray(value)) {
        return value.length ? 2 + value.reduce((n: number, v) => n + pythonJsonBytes(v), 0) + 2 * (value.length - 1) : 2;
    }
    const entries = Object.entries(value as Row);
    let size = 2 + (entries.length ? 2 * (entries.length - 1) : 0);
    for (const [key, v] of entries) {
        size += Buffer.byteLength(JSON.stringify(key), 'utf8') + 2 + pythonJsonBytes(v);
    }
    return size;
}

// Contract objects passed through as they are, with only the properties this version defines (as python-schema-viewer
// reads them), so a later 1.x minor's additions do not leak into responses.
function pick<T extends object>(value: T | null, keys: readonly (keyof T)[]): Row | null {
    if (value === null) {
        return null;
    }
    const out: Row = {};
    for (const key of keys) {
        out[key as string] = value[key];
    }
    return out;
}

function coverage(value: Coverage | null): Row | null {
    return pick(value, ['complete', 'schemas', 'features']);
}

function drift(values: Drift[]): Row[] {
    return values.map((d) => pick(d, ['field', 'database', 'declared']) as Row);
}

function physical(entity: { provenance: string[]; drift?: Drift[] }, out: Row): Row {
    out.provenance = entity.provenance;
    if (truthy(entity.drift)) {
        out.drift = drift(entity.drift ?? []);
    }
    return out;
}

function serverDefault(column: Column): Row | null {
    if (truthy(column.generated)) {
        return { kind: 'generated', value: column.generated?.expression };
    }
    const value = column.default;
    if (value === null) {
        return null;
    }
    const kinds: Record<string, string> = { literal: 'sql', expression: 'sql', sequence: 'sequence' };
    return { kind: kinds[value.kind] ?? 'generated', value: value.value };
}

function ormDefault(column: Column): Row | null {
    const value = column.ormDefault;
    if (value === null) {
        return null;
    }
    return { kind: value.kind === 'expression' ? 'sql' : value.kind, value: value.value };
}

function firstExtension(extensions: Record<string, unknown> | undefined): Row | undefined {
    const values = Object.values(extensions ?? {});
    return values.length ? (values[0] as Row) : undefined;
}

function indexView(i: Index, dialect: string | null): Row {
    const options = Object.entries(i.dialectOptions ?? {});
    const predicates: Row = {};
    const included: Row = {};
    const methods: Row = {};
    for (const [d, o] of options) {
        if (truthy(o.predicate)) predicates[d] = o.predicate;
    }
    for (const [d, o] of options) {
        if (truthy(o.included)) included[d] = o.included;
    }
    for (const [d, o] of options) {
        if (truthy(o.method)) methods[d] = o.method;
    }
    if (truthy(dialect) && dialect !== null) {
        if (truthy(i.predicate) && !(dialect in predicates)) predicates[dialect] = i.predicate;
        if (truthy(i.included) && !(dialect in included)) included[dialect] = i.included;
        if (truthy(i.method) && !(dialect in methods)) methods[dialect] = i.method;
    }
    return physical(i, {
        name: i.name,
        columns: i.columns,
        expressions: i.expression ? i.parts.map((p) => (truthy(p.expression) ? p.expression : p.column)) : [],
        unique: i.unique,
        predicates,
        included_columns: included,
        methods,
        id: i.id,
        parts: i.parts.map((p) => pick(p, ['column', 'expression', 'order', 'nulls', 'length', 'collation', 'opclass'])),
        primary: i.primary,
        backs: pick(i.backs, ['kind', 'constraint']),
        partial: i.partial,
    });
}

function tableView(t: Table, connection: Connection): Row {
    const dialect = connection.driver === null ? null : (DIALECTS[connection.driver] ?? connection.driver);
    const columns = t.columns.map((c) => {
        const extension = firstExtension(c.extensions)?.autoincrement;
        return physical(c, {
            name: c.name,
            type: c.type,
            timezone: c.timezone,
            nullable: c.nullable,
            primary_key: t.primaryKey.includes(c.name),
            autoincrement: truthy(extension) ? extension : c.autoIncrement === null ? 'auto' : c.autoIncrement,
            default: ormDefault(c),
            server_default: serverDefault(c),
            comment: c.comment,
            type_name: c.typeName,
            collation: c.collation,
            enum: pick(c.enum, ['name', 'values']),
        });
    });
    const foreignKeys = t.foreignKeys.map((fk) => {
        const raw = firstExtension(fk.extensions) ?? {};
        return physical(fk, {
            id: fk.id,
            name: fk.name,
            columns: fk.columns,
            target_table: fk.foreignTable,
            target_columns: fk.foreignColumns,
            on_delete: 'onDelete' in raw ? raw.onDelete : fk.onDelete,
            on_update: 'onUpdate' in raw ? raw.onUpdate : fk.onUpdate,
            deferrable: fk.deferrable,
            initially: fk.initially,
        });
    });
    return physical(t, {
        id: t.id,
        namespace: connection.name,
        name: t.name,
        schema_name: t.schema,
        comment: t.comment,
        columns,
        primary_key: t.primaryKey,
        indexes: t.indexes.map((i) => indexView(i, dialect)),
        foreign_keys: foreignKeys,
        constraints: t.constraints.map((c) =>
            physical(c, { kind: c.kind, name: c.name, columns: c.columns, expression: c.expression, id: c.id }),
        ),
        owner: pick(t.owner, ['kind', 'package']),
    });
}

function relationshipView(r: Relationship, relationships: Map<string, Relationship>): Row {
    let pairs: Row[] = [];
    if (truthy(r.keys) && r.keys) {
        const [local, remote] = r.type === 'MANYTOONE' ? [r.keys.from, r.keys.to] : [r.keys.to, r.keys.from];
        pairs = zip(local.columns, remote.columns).map(([a, b]) => ({
            local: { table: local.table, column: a },
            remote: { table: remote.table, column: b },
        }));
    } else if (truthy(r.pivot) && r.pivot) {
        const pivot = r.pivot;
        pairs = zip(pivot.parentColumns, pivot.parentPivotColumns).map(([a, b]) => ({
            local: { table: r.table, column: a },
            remote: { table: pivot.table, column: b },
        }));
        pairs.push(
            ...zip(pivot.relatedColumns, pivot.relatedPivotColumns).map(([a, b]) => ({
                local: { table: r.relatedTable, column: a },
                remote: { table: pivot.table, column: b },
            })),
        );
    }
    const inverse = truthy(r.inverse) && r.inverse !== null ? relationships.get(r.inverse) : undefined;
    const join = r.join;
    return {
        id: r.id,
        name: r.name,
        model: r.model,
        target_model: r.relatedModel,
        source_table: r.table,
        target_table: r.relatedTable,
        direction: r.type,
        uselist: r.collection,
        viewonly: r.readOnly,
        back_populates: inverse ? inverse.name : null,
        secondary: truthy(r.pivot) ? (r.pivot?.table ?? null) : null,
        primary_join: join && truthy(join.primary) ? join.primary : '',
        secondary_join: join ? join.secondary : null,
        join_pairs: pairs,
        cardinality: r.cardinality,
        polymorphic: pick(r.polymorphic, ['typeColumn', 'idColumn', 'typeValue']),
        through: r.through,
        constraints: r.constraints,
        note: r.note,
    };
}

function diagnosticView(d: Diagnostic): Row {
    const subject = d.subject;
    return {
        kind: d.kind,
        subject: truthy(subject.id) ? subject.id : truthy(subject.label) ? subject.label : '',
        message: d.message,
        category: d.category,
        severity: d.severity,
        certainty: d.certainty,
        subject_type: subject.type,
        columns: subject.columns,
    };
}

function modelView(m: Model): Row {
    return {
        id: m.id,
        class_name: m.className,
        table_ids: m.tables,
        primary_key: m.primaryKey,
        source: pick(m.source, ['file', 'line']),
    };
}

export interface View {
    scope: string;
    source: string;
    connections: Row[];
    tables: Row[];
    models: Row[];
    relationships: Row[];
    diagnostics: Row[];
}

// A laranex-schema document in the version 1 response fields, keeping what only the unified contract has.
export function unifiedView(doc: SchemaDocument): View {
    const relationships = new Map(doc.relationships.map((r) => [r.id, r]));
    return {
        scope: SCOPES[doc.source],
        source: doc.source,
        connections: doc.connections.map((c) => ({
            id: c.id,
            name: c.name,
            driver: c.driver,
            default_schema: c.defaultSchema,
            coverage: { database: coverage(c.coverage.database), declared: coverage(c.coverage.declared) },
        })),
        tables: doc.connections.flatMap((c) => c.tables.map((t) => tableView(t, c))),
        models: doc.models.map(modelView),
        relationships: doc.relationships.map((r) => relationshipView(r, relationships)),
        diagnostics: doc.diagnostics.map(diagnosticView),
    };
}

const list = (row: Row, key: string) => row[key] as Row[];
const text = (row: Row, key: string) => row[key] as string;

// One validated snapshot and revision, pinned for a server's lifetime.
export class SnapshotQuery {
    readonly view: View;
    readonly revision: string;
    readonly tables: Map<string, Row>;
    readonly models: Map<string, Row>;

    constructor(document: SchemaDocument) {
        this.view = unifiedView(document);
        this.revision = documentRevision(document);
        this.tables = new Map(this.view.tables.map((t) => [text(t, 'id'), t]));
        this.models = new Map(this.view.models.map((m) => [text(m, 'id'), m]));
    }

    static fromFile(path: string): SnapshotQuery {
        return new SnapshotQuery(loadDocument(path));
    }

    page(items: unknown[], { limit = 25, offset = 0, revision = null }: Pagination = {}, context: Row = {}): Page {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new QueryError('limit must be an integer from 1 to 100');
        }
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
            throw new QueryError('offset must be a nonnegative integer');
        }
        if (revision !== null && revision !== this.revision) {
            throw new QueryError('Snapshot revision differs; restart pagination without revision');
        }
        const result: Page = { ...context, revision: this.revision, total: items.length, items: [], next_offset: null };
        // Python measures the whole result after each item; the same total, computed incrementally.
        let size = pythonJsonBytes(result);
        for (const item of items.slice(offset, offset + limit)) {
            const grown = size + pythonJsonBytes(item) + (result.items.length ? 2 : 0);
            if (grown > MAX_RESPONSE_BYTES - 128) {
                if (!result.items.length) {
                    throw new QueryError('One result exceeds the response byte limit');
                }
                break;
            }
            result.items.push(item);
            size = grown;
        }
        const end = offset + result.items.length;
        result.next_offset = end < items.length ? end : null;
        if (pythonJsonBytes(result) > MAX_RESPONSE_BYTES) {
            throw new QueryError('Response metadata exceeds the response byte limit');
        }
        return result;
    }

    overview(pagination: Pagination = {}): Page {
        const view = this.view;
        const tables = view.tables;
        const sum = (key: string) => tables.reduce((n, t) => n + list(t, key).length, 0);
        const counts: Row = {
            tables: tables.length,
            models: view.models.length,
            columns: sum('columns'),
            indexes: sum('indexes'),
            foreign_keys: sum('foreign_keys'),
            relationships: view.relationships.length,
            diagnostics: view.diagnostics.length,
            drift: view.diagnostics.filter((d) => d.category === 'drift').length,
        };
        const items = tables.map((t) => ({
            id: t.id,
            namespace: t.namespace,
            schema_name: t.schema_name,
            name: t.name,
            columns: list(t, 'columns').length,
            foreign_keys: list(t, 'foreign_keys').length,
            provenance: t.provenance,
        }));
        return this.page(items, pagination, { counts, scope: view.scope, source: view.source, connections: view.connections });
    }

    getTable(table: string, section = 'columns', pagination: Pagination = {}): Page {
        const value = this.tables.get(table);
        if (value === undefined) {
            throw new QueryError('Unknown table ID; use schema_overview or schema_search');
        }
        const sections: Record<string, unknown[]> = {
            columns: list(value, 'columns'),
            indexes: list(value, 'indexes'),
            foreign_keys: list(value, 'foreign_keys'),
            constraints: list(value, 'constraints'),
            models: this.view.models.filter((m) => (m.table_ids as string[]).includes(table)),
            relationships: this.view.relationships.filter((r) => table === r.source_table || table === r.target_table),
        };
        const items = Object.hasOwn(sections, section) ? sections[section] : undefined;
        if (items === undefined) {
            throw new QueryError(`Unknown table section: ${section}`);
        }
        const summary: Row = {
            id: value.id,
            name: value.name,
            namespace: value.namespace,
            schema_name: value.schema_name,
            primary_key: value.primary_key,
        };
        for (const key of ['provenance', 'drift', 'owner']) {
            if (key in value) {
                summary[key] = value[key];
            }
        }
        const counts = Object.fromEntries(Object.entries(sections).map(([key, entries]) => [key, entries.length]));
        return this.page(items, pagination, { table: summary, section, counts });
    }

    getModel(model: string, pagination: Pagination = {}): Page {
        const value = this.models.get(model);
        if (value === undefined) {
            throw new QueryError('Unknown model ID; use schema_search');
        }
        return this.page(
            this.view.relationships.filter((r) => r.model === model),
            pagination,
            { model: value },
        );
    }

    relationships(table: string | null = null, kind = 'orm', pagination: Pagination = {}): Page {
        if (table !== null && !this.tables.has(table)) {
            throw new QueryError('Unknown table ID');
        }
        let items: Row[];
        if (kind === 'orm') {
            items = this.view.relationships.filter((r) => table === null || table === r.source_table || table === r.target_table);
        } else if (kind === 'foreign_key') {
            items = this.view.tables.flatMap((t) =>
                list(t, 'foreign_keys')
                    .filter((fk) => table === null || table === t.id || table === fk.target_table)
                    .map((fk) => ({ source_table: t.id, ...fk })),
            );
        } else {
            throw new QueryError('kind must be orm or foreign_key');
        }
        return this.page(items, pagination, { kind });
    }

    search(query: string, pagination: Pagination = {}): Page {
        const length = typeof query === 'string' ? Array.from(query).length : 0;
        if (length < 1 || length > 200) {
            throw new QueryError('query must contain 1 to 200 characters');
        }
        const needle = casefold(query);
        const items: Row[] = [];
        for (const table of this.view.tables) {
            const name = `${text(table, 'namespace')}.${truthy(table.schema_name) ? text(table, 'schema_name') : ''}.${text(table, 'name')}`;
            if (casefold(name).includes(needle)) {
                items.push({ kind: 'table', id: table.id, name: table.name });
            }
            for (const column of list(table, 'columns')) {
                if (casefold(text(column, 'name')).includes(needle)) {
                    items.push({ kind: 'column', table: table.id, name: column.name });
                }
            }
        }
        for (const model of this.view.models) {
            if (casefold(text(model, 'class_name')).includes(needle)) {
                items.push({ kind: 'model', id: model.id, name: model.class_name });
            }
        }
        for (const relation of this.view.relationships) {
            if (casefold(`${text(relation, 'name')} ${text(relation, 'direction')}`).includes(needle)) {
                items.push({ kind: 'relationship', id: relation.id, name: relation.name });
            }
        }
        return this.page(items, pagination);
    }
}

