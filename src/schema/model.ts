// The normalized internal schema model: what extraction (database catalog readers now, ORM adapters later) found,
// independent of the laranex-schema document's field names. Extractors fill it; only serialize.ts knows the document.
//
// Entities carry opaque ids (ids.ts): they are identities other entities refer to, not serialization details.
import type { Feature, FeatureCoverage as FeatureLevel } from 'laranex-schema-viewer-ui/contract';

export type Dialect = 'postgresql' | 'mysql' | 'mariadb' | 'sqlite';

export type SourceKind = 'database' | 'declared';

// The coverage vocabulary is the contract's (feature names and levels are values the model records, not fields).
export type { Feature, FeatureLevel };

export type JsonScalar = string | number | boolean | null;

export interface SchemaModel {
    source: SourceKind;
    producer: string;
    // The ORM the metadata came from; null for database introspection.
    orm: string | null;
    connections: ConnectionModel[];
    diagnostics: DiagnosticModel[];
}

export interface ConnectionModel {
    name: string;
    dialect: Dialect | null;
    defaultSchema: string | null;
    // What the source read for this connection.
    read: { schemas: string[] | null; features: Partial<Record<Feature, FeatureLevel>> };
    tables: TableModel[];
}

export interface TableModel {
    id: string;
    name: string;
    // null: unqualified (the connection's default schema).
    schema: string | null;
    comment: string | null;
    ownership: { kind: 'application' | 'framework' | 'package'; package: string | null };
    primaryKey: string[];
    columns: ColumnModel[];
    indexes: IndexModel[];
    foreignKeys: ForeignKeyModel[];
    constraints: ConstraintModel[];
}

export interface ColumnModel {
    name: string;
    nativeType: string;
    baseType: string | null;
    nullable: boolean;
    autoIncrement: boolean | null;
    timezone: boolean | null;
    collation: string | null;
    enumeration: { namedType: string | null; values: string[] } | null;
    serverDefault: { kind: 'literal' | 'expression' | 'sequence' | 'identity' | 'raw'; sql: string } | null;
    generated: { storage: 'stored' | 'virtual' | null; expression: string } | null;
    comment: string | null;
}

// A key part is a column or an expression, never both.
export interface KeyPartModel {
    column: string | null;
    expression: string | null;
    order: 'asc' | 'desc' | null;
    nulls: 'first' | 'last' | null;
    prefixLength: number | null;
    collation: string | null;
    operatorClass: string | null;
}

export interface IndexModel {
    id: string;
    name: string | null;
    keyParts: KeyPartModel[];
    unique: boolean;
    // The constraint the index enforces: the primary key, or a unique constraint (its id when it is an entity).
    enforces: { kind: 'primary_key' } | { kind: 'unique_constraint'; constraint: string | null } | null;
    method: string | null;
    // The WHERE clause of a partial index.
    predicate: string | null;
    includedColumns: string[];
    // Options only one dialect family states, such as { postgresql: { nullsNotDistinct: true } } or
    // { mysql: { visible: false } } (MySQL and MariaDB share the mysql family).
    dialectOptions: Record<string, Record<string, JsonScalar>>;
}

export type ReferentialAction = 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';

export interface ForeignKeyModel {
    id: string;
    name: string | null;
    columns: string[];
    // The referenced table's id, in the same connection.
    referencedTable: string;
    referencedColumns: string[];
    onUpdate: ReferentialAction | null;
    onDelete: ReferentialAction | null;
    deferrable: boolean | null;
    initially: 'DEFERRED' | 'IMMEDIATE' | null;
}

export type ConstraintModel =
    | { kind: 'unique'; id: string; name: string | null; columns: string[] }
    | { kind: 'check'; id: string; name: string | null; expression: string; columns: string[] };

export interface DiagnosticModel {
    kind: string;
    category: 'extraction' | 'inspection' | 'reconciliation' | 'drift' | 'lint';
    severity: 'error' | 'warning' | 'info';
    certainty: 'certain' | 'likely';
    subject: { type: 'document' | 'connection' | 'table' | 'column' | 'index' | 'foreignKey' | 'constraint'; id: string | null; columns: string[] | null; label: string | null };
    message: string;
}
