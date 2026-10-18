// Canonical serialization of the internal model (model.ts) to a laranex-schema 2.0 document, and the composition of
// serialized documents. The only module that knows the document's field names. Every document it returns has the
// shared graph builder's links and passed the contract's strict validation; canonical bytes are snapshot.ts's.
import {
    assertDocument,
    buildGraph,
    diagnosticId,
    FORMAT,
    inferAssociations,
    VERSION,
    type Column,
    type Connection,
    type Constraint,
    type Diagnostic,
    type ForeignKey,
    type Index,
    type Model,
    type Relationship,
    type SchemaDocument,
    type Table,
} from 'laranex-schema-viewer-ui/contract';
import { connectionId } from './ids.js';
import type {
    AssociationModel,
    ColumnModel,
    ConnectionModel,
    ConstraintModel,
    DiagnosticModel,
    EntityModel,
    ForeignKeyModel,
    IndexModel,
    OrmExtensions,
    SchemaModel,
    SourceKind,
    TableModel,
} from './model.js';

type Provenance = [SourceKind];

// Unicode code point order, as the contract sorts strings.
export function byCodePoint(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length) {
        const x = a.codePointAt(i) ?? 0;
        const y = b.codePointAt(i) ?? 0;
        if (x !== y) {
            return x - y;
        }
        i += x > 0xffff ? 2 : 1;
    }
    return a.length - b.length;
}

function byKey<T>(key: (item: T) => (string | null)[]): (a: T, b: T) => number {
    return (a, b) => {
        const x = key(a);
        const y = key(b);
        for (let i = 0; i < x.length; i += 1) {
            const d = byCodePoint(x[i] ?? '', y[i] ?? '');
            if (d !== 0) {
                return d;
            }
        }
        return 0;
    };
}

const sortById = <T extends { id: string }>(items: T[]): T[] => items.sort(byKey((i) => [i.id]));
const sortDiagnostics = (items: Diagnostic[]): Diagnostic[] => items.sort(byKey((d) => [d.category, d.kind, d.subject.type, d.subject.id, d.message]));

// Equal diagnostics have one id; each is listed once.
function uniqueDiagnostics(items: Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    return items.filter((d) => !seen.has(d.id) && seen.add(d.id));
}

// A relationship's inverse must name a relationship the document has.
function knownInverses(relationships: Relationship[]): Relationship[] {
    const ids = new Set(relationships.map((r) => r.id));
    return relationships.map((r) => (r.inverse === null || ids.has(r.inverse) ? r : { ...r, inverse: null }));
}

// Only when an extractor recorded something; an empty extensions object is never written.
function withExtensions<T extends object>(entry: T, extensions: OrmExtensions | undefined): T {
    const namespaces = Object.entries(extensions ?? {}).filter(([, values]) => Object.keys(values).length > 0);
    return namespaces.length === 0 ? entry : { ...entry, extensions: Object.fromEntries(namespaces) };
}

export function serialize(model: SchemaModel): SchemaDocument {
    const provenance: Provenance = [model.source];
    return finish({
        format: FORMAT,
        version: VERSION,
        source: model.source,
        generator: { name: model.producer, orm: model.orm },
        note: null,
        connections: model.connections.map((c) => connection(c, model.source, provenance)).sort(byKey((c) => [c.name])),
        models: sortById(model.entities.map(entity)),
        relationships: knownInverses(sortById(model.associations.map(association))),
        links: [],
        derivedLinks: [],
        diagnostics: uniqueDiagnostics(sortDiagnostics(model.diagnostics.map(diagnostic))),
        comparisons: [],
        migrations: [],
        inferredAssociations: [],
    });
}

// Documents of one source and generator, with distinct connections, as one document.
export function merge(documents: readonly SchemaDocument[]): SchemaDocument {
    const [first] = documents;
    if (first === undefined) {
        throw new Error('Nothing to merge');
    }
    for (const document of documents) {
        if (document.source !== first.source || document.generator.name !== first.generator.name || document.generator.orm !== first.generator.orm) {
            throw new Error('Only documents of one source and generator can be merged');
        }
    }
    return finish({
        ...first,
        connections: documents.flatMap((d) => d.connections).sort(byKey((c) => [c.name])),
        models: sortById(documents.flatMap((d) => d.models)),
        relationships: sortById(documents.flatMap((d) => d.relationships)),
        links: [],
        derivedLinks: [],
        diagnostics: sortDiagnostics(documents.flatMap((d) => d.diagnostics)),
        comparisons: sortById(documents.flatMap((d) => d.comparisons)),
        migrations: sortById(documents.flatMap((d) => d.migrations)),
        inferredAssociations: [],
    });
}

// The shared graph builder's links, then the shared inference's associations (none without models).
function finish(document: SchemaDocument): SchemaDocument {
    const linked = { ...document, ...buildGraph(document) };
    return assertDocument({ ...linked, inferredAssociations: inferAssociations(linked) }, { strict: true });
}

function connection(c: ConnectionModel, source: SourceKind, provenance: Provenance): Connection {
    const features = { ...c.read.features };
    const read = {
        complete: Object.values(features).every((level) => level === 'complete' || level === 'not_applicable'),
        schemas: c.read.schemas === null ? null : [...c.read.schemas],
        features,
    };
    return {
        id: connectionId(c.name),
        name: c.name,
        driver: c.dialect,
        defaultSchema: c.defaultSchema,
        coverage: source === 'database' ? { database: read, declared: null } : { database: null, declared: read },
        tables: sortById(c.tables.map((t) => table(t, provenance))),
    };
}

function table(t: TableModel, provenance: Provenance): Table {
    return withExtensions({
        id: t.id,
        name: t.name,
        schema: t.schema,
        comment: t.comment,
        note: null,
        owner: { kind: t.ownership.kind, package: t.ownership.package },
        primaryKey: [...t.primaryKey],
        columns: t.columns.map((c) => column(c, provenance)),
        indexes: sortById(t.indexes.map((i) => index(i, provenance))),
        foreignKeys: sortById(t.foreignKeys.map((f) => foreignKey(f, provenance))),
        constraints: sortById(t.constraints.map((k) => constraint(k, provenance))),
        provenance: [...provenance],
    }, t.extensions);
}

function column(c: ColumnModel, provenance: Provenance): Column {
    const applied = c.applicationDefault ?? null;
    return withExtensions({
        name: c.name,
        type: c.nativeType,
        typeName: c.baseType,
        nullable: c.nullable,
        autoIncrement: c.autoIncrement,
        timezone: c.timezone,
        collation: c.collation,
        enum: c.enumeration === null ? null : { name: c.enumeration.namedType, values: [...c.enumeration.values] },
        default: c.serverDefault === null ? null : { kind: c.serverDefault.kind, value: c.serverDefault.sql },
        ormDefault: applied === null ? null : { kind: applied.kind, value: applied.value },
        generated: c.generated === null ? null : { kind: c.generated.storage, expression: c.generated.expression },
        comment: c.comment,
        note: null,
        provenance: [...provenance],
    }, c.extensions);
}

function index(i: IndexModel, provenance: Provenance): Index {
    const entry: Index = {
        id: i.id,
        name: i.name,
        parts: i.keyParts.map((p) => ({
            column: p.column,
            expression: p.expression,
            order: p.order,
            nulls: p.nulls,
            length: p.prefixLength,
            collation: p.collation,
            opclass: p.operatorClass,
        })),
        expression: i.keyParts.some((p) => p.expression !== null),
        unique: i.unique,
        backs: i.enforces === null ? null : { kind: i.enforces.kind, constraint: i.enforces.kind === 'unique_constraint' ? i.enforces.constraint : null },
        method: i.method,
        partial: i.predicate !== null,
        predicate: i.predicate,
        included: [...i.includedColumns],
        provenance: [...provenance],
    };
    const dialects = Object.entries(i.dialectOptions);
    if (dialects.length > 0) {
        entry.dialectOptions = Object.fromEntries(dialects.map(([dialect, options]) => [dialect, { options: { ...options } }]));
    }
    return withExtensions(entry, i.extensions);
}

function foreignKey(f: ForeignKeyModel, provenance: Provenance): ForeignKey {
    return withExtensions({
        id: f.id,
        name: f.name,
        columns: [...f.columns],
        foreignTable: f.referencedTable,
        foreignColumns: [...f.referencedColumns],
        onUpdate: f.onUpdate,
        onDelete: f.onDelete,
        deferrable: f.deferrable,
        initially: f.initially,
        provenance: [...provenance],
    }, f.extensions);
}

function constraint(k: ConstraintModel, provenance: Provenance): Constraint {
    return withExtensions({
        id: k.id,
        kind: k.kind,
        name: k.name,
        columns: [...k.columns],
        expression: k.kind === 'check' ? k.expression : null,
        provenance: [...provenance],
    }, k.extensions);
}

function entity(e: EntityModel): Model {
    return withExtensions({
        id: e.id,
        className: e.name,
        tables: [...e.tables].sort(byCodePoint),
        primaryKey: [...e.primaryKey],
        source: e.location === null ? null : { file: e.location.file, line: e.location.line },
    }, e.extensions);
}

function association(a: AssociationModel): Relationship {
    return withExtensions({
        id: a.id,
        name: a.name,
        model: a.model,
        table: a.table,
        relatedModel: a.target.model,
        relatedTable: a.target.table,
        type: a.kind,
        cardinality: a.cardinality,
        collection: a.many,
        readOnly: !a.writable,
        keys: a.key === null ? null : { from: { table: a.key.referencing.table, columns: [...a.key.referencing.columns] }, to: { table: a.key.referenced.table, columns: [...a.key.referenced.columns] } },
        pivot: null,
        polymorphic: null,
        through: null,
        join: null,
        constraints: [],
        inverse: a.inverse,
        note: null,
        source: a.location === null ? null : { file: a.location.file, line: a.location.line },
    }, a.extensions);
}

function diagnostic(d: DiagnosticModel): Diagnostic {
    const subject = { type: d.subject.type, id: d.subject.id, columns: d.subject.columns === null ? null : [...d.subject.columns], label: d.subject.label };
    return { id: diagnosticId({ kind: d.kind, subject, message: d.message }), kind: d.kind, category: d.category, severity: d.severity, certainty: d.certainty, subject, message: d.message };
}
