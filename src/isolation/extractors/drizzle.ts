// Drizzle ORM adapter (drizzle-orm 0.x): imports the configured schema modules inside the extraction worker and reads
// what their exported tables and relations() declare through Drizzle's own metadata API: is() and Table, each
// dialect's getTableConfig() (pg-core, mysql-core, sqlite-core), getSQLType(), the dialects' SQL rendering, and
// extractTablesRelationalConfig()/normalizeRelation() for relations. Drizzle is the application's dependency: it is
// imported from the project, never bundled, so the objects compare with the ones the schema modules created.
//
// Drizzle has no model classes: each exported table is the model the relational query API knows by its export name.
// Relations stay ORM relationships (not writable: Drizzle never writes through them), separate from foreign keys.
// Anything the API does not expose is left out, and what cannot be represented is a diagnostic.
import { foreignKeyId, tableId } from '../../schema/ids.js';
import type {
    AssociationModel,
    ColumnModel,
    ConnectionModel,
    DiagnosticModel,
    Dialect,
    EntityModel,
    ForeignKeyModel,
    IndexModel,
    JsonValue,
    KeyPartModel,
    TableModel,
} from '../../schema/model.js';
import type { ExtractContext } from '../extractor.js';
import {
    columnPart,
    declaredConstraints,
    declaredCoverage,
    declaredDocument,
    declaredIndexes,
    diagnostic,
    expressionPart,
    extensions,
    modelId,
    referentialAction,
    relationshipId,
    sqlDefault,
    type ConstraintDeclaration,
    type IndexDeclaration,
} from './declared.js';

export const ORM = 'drizzle';
const UNSUPPORTED = 'unsupported_metadata';
const DRIVERS: Readonly<Record<Family, readonly string[]>> = { pg: ['postgresql'], mysql: ['mysql', 'mariadb'], sqlite: ['sqlite'] };
// drizzle-orm/casing, which names columns declared without a name, arrived in 0.36.
const MIN_MINOR = 36;
const SERIAL = new Set(['PgSerial', 'PgSmallSerial', 'PgBigSerial53', 'PgBigSerial64']);

type Family = 'pg' | 'mysql' | 'sqlite';
type Casing = 'snake_case' | 'camelCase' | null;
// Drizzle's objects, read through their documented properties.
type Entity = Record<string | symbol, unknown>;
type Constructor = abstract new (...args: never[]) => unknown;
type Fn = (...args: unknown[]) => unknown;

export interface DrizzleConnection {
    name: string;
    // postgresql, mysql, mariadb or sqlite; checked against the tables' dialect. Null: from the dialect, where it
    // names one database (pg-core, sqlite-core).
    driver: string | null;
    modules: string[];
}

export interface DrizzleOptions {
    connections: DrizzleConnection[];
    // The casing the application gives drizzle() for columns declared without a name.
    casing: Casing;
}

interface DialectApi {
    family: Family;
    table: Constructor;
    getTableConfig: (table: unknown) => Entity;
    // Renders SQL with column names unqualified, as in a CREATE TABLE or CREATE INDEX statement.
    render: (value: unknown) => string;
    views: Constructor[];
}

interface Api {
    is: (value: unknown, type: Constructor) => boolean;
    Table: Constructor;
    Relations: Constructor;
    One: Constructor;
    SQL: Constructor;
    getTableName: (table: unknown) => string;
    extractTablesRelationalConfig: (schema: Record<string, unknown>, helpers: unknown) => { tables: Record<string, Entity>; tableNamesMap: Record<string, string> };
    createTableRelationsHelpers: unknown;
    normalizeRelation: (schema: Record<string, Entity>, names: Record<string, string>, relation: unknown) => { fields: Entity[]; references: Entity[] };
    dialects: DialectApi[];
    convert: (name: string) => string;
    isSequence: (value: unknown) => boolean;
}

// One exported table, where it was found.
interface Found {
    table: Entity;
    exportName: string;
    connection: string;
    dialect: DialectApi;
    id: string;
    name: string;
    schema: string | null;
    primaryKey: string[];
    keys: string[][];
    model: string;
}

class Extraction {
    readonly diagnostics: DiagnosticModel[] = [];
    readonly partial = new Map<string, Set<string>>();
    readonly found = new Map<unknown, Found>();
    readonly relations: { value: Entity; connection: string }[] = [];

    constructor(readonly api: Api) {}

    report(connection: string, feature: string | null, entry: DiagnosticModel): void {
        this.diagnostics.push(entry);
        if (feature !== null) {
            const features = this.partial.get(connection) ?? new Set<string>();
            features.add(feature);
            this.partial.set(connection, features);
        }
    }

    // A column's name in the database: its declared name, or its key converted with the application's casing.
    columnName(column: Entity): string {
        const name = String(column.name);
        return column.keyAsName === true ? this.api.convert(name) : name;
    }

    // SQL as the dialect renders it, with inline parameters; null and a diagnostic when Drizzle cannot render it.
    sql(dialect: DialectApi, value: unknown, report: (message: string) => void): string | null {
        try {
            return dialect.render(value);
        } catch (error) {
            report(`Drizzle cannot render this SQL: ${errorText(error)}`);
            return null;
        }
    }
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isEntity(value: unknown): value is Entity {
    // Drizzle's is() reads the prototype's constructor, which an object without a prototype does not have.
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) !== null;
}

function callable(value: unknown): value is Fn {
    return typeof value === 'function';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
}

async function load(context: ExtractContext, casing: Casing): Promise<Api> {
    let root: Entity;
    let version: string;
    try {
        root = await context.importModule('drizzle-orm');
        version = String((await context.importModule('drizzle-orm/version')).npmVersion);
    } catch (error) {
        throw new Error(`Cannot load drizzle-orm from the project; install it there (it is the application's dependency): ${errorText(error)}`, { cause: error });
    }
    const [major, minor] = version.split('.').map(Number);
    if (major !== 0 || minor === undefined || !(minor >= MIN_MINOR)) {
        throw new Error(
            `drizzle-orm ${version} is not supported: the Drizzle adapter reads the 0.x metadata API from 0.${String(MIN_MINOR)} on ` +
                '(tested with 0.36.4 to 0.45.4). Drizzle 1.0 changes relations (defineRelations) and is not read yet.',
        );
    }
    const casingModule = await context.importModule('drizzle-orm/casing');
    const convert = casing === 'snake_case' ? (casingModule.toSnakeCase as (s: string) => string) : casing === 'camelCase' ? (casingModule.toCamelCase as (s: string) => string) : (s: string) => s;
    const sql = root.sql as (strings: TemplateStringsArray, ...values: unknown[]) => { inlineParams(): unknown };
    const dialects: DialectApi[] = [];
    for (const [family, path, tableName, dialectName, views] of [
        ['pg', 'drizzle-orm/pg-core', 'PgTable', 'PgDialect', ['PgView', 'PgMaterializedView']],
        ['mysql', 'drizzle-orm/mysql-core', 'MySqlTable', 'MySqlDialect', ['MySqlView']],
        ['sqlite', 'drizzle-orm/sqlite-core', 'SQLiteTable', 'SQLiteDialect', ['SQLiteView']],
    ] as const) {
        const core = await context.importModule(path);
        const DialectClass = core[dialectName] as new (config: { casing?: string }) => { sqlToQuery(sql: unknown, source?: string): { sql: string; params: unknown[] } };
        const renderer = new DialectClass(casing === null ? {} : { casing });
        dialects.push({
            family,
            table: core[tableName] as Constructor,
            getTableConfig: core.getTableConfig as (table: unknown) => Entity,
            render: (value) => {
                const query = renderer.sqlToQuery(sql`${value}`.inlineParams(), 'indexes');
                if (query.params.length > 0) {
                    // A placeholder has no value until a query runs.
                    throw new Error('it has a placeholder, which has no value in the schema');
                }
                return query.sql;
            },
            views: views.map((name) => core[name] as Constructor),
        });
    }
    const pg = await context.importModule('drizzle-orm/pg-core');
    return {
        is: root.is as Api['is'],
        Table: root.Table as Constructor,
        Relations: root.Relations as Constructor,
        One: root.One as Constructor,
        SQL: root.SQL as Constructor,
        getTableName: root.getTableName as Api['getTableName'],
        extractTablesRelationalConfig: root.extractTablesRelationalConfig as Api['extractTablesRelationalConfig'],
        createTableRelationsHelpers: root.createTableRelationsHelpers,
        normalizeRelation: root.normalizeRelation as Api['normalizeRelation'],
        dialects,
        convert,
        isSequence: pg.isPgSequence as (value: unknown) => boolean,
    };
}

function checkOptions(options: Record<string, unknown>): DrizzleOptions {
    const { connections, casing = null } = options as { connections?: unknown; casing?: unknown };
    const valid = (c: unknown): c is DrizzleConnection =>
        isEntity(c) && typeof c.name === 'string' && (c.driver === null || typeof c.driver === 'string') && Array.isArray(c.modules) && c.modules.every((m) => typeof m === 'string');
    if (!Array.isArray(connections) || connections.length === 0 || !connections.every(valid)) {
        throw new Error('The Drizzle adapter needs connections, each with a name, a driver or null, and modules');
    }
    if (casing !== null && casing !== 'snake_case' && casing !== 'camelCase') {
        throw new Error('casing must be snake_case or camelCase');
    }
    return { connections, casing };
}

// A module's exports in a stable order; a CommonJS module's properties are under `default` as well.
function exportsOf(namespace: Record<string, unknown>): [string, unknown][] {
    const entries = Object.entries(namespace);
    const fallback = namespace.default;
    if (isEntity(fallback) && Object.getPrototypeOf(fallback) === Object.prototype) {
        entries.push(...Object.entries(fallback).filter(([key]) => !(key in namespace)));
    }
    return entries;
}

async function discover(extraction: Extraction, context: ExtractContext, connection: DrizzleConnection): Promise<void> {
    const { api } = extraction;
    const seen = new Map<string, unknown>();
    for (const specifier of connection.modules) {
        const namespace = await context.importModule(specifier);
        for (const [exportName, value] of exportsOf(namespace)) {
            if (!isEntity(value)) {
                continue;
            }
            if (api.is(value, api.Relations)) {
                extraction.relations.push({ value, connection: connection.name });
            } else if (api.is(value, api.Table)) {
                addTable(extraction, connection.name, exportName, value, seen);
            } else if (api.dialects.some((d) => d.views.some((view) => api.is(value, view)))) {
                extraction.report(connection.name, null, diagnostic(UNSUPPORTED, { type: 'connection', id: `connection:${connection.name}`, label: exportName },
                    `View ${exportName} (${specifier}) is not represented: views are not tables.`));
            } else if (api.isSequence(value)) {
                extraction.report(connection.name, null, diagnostic(UNSUPPORTED, { type: 'connection', id: `connection:${connection.name}`, label: exportName },
                    `Sequence ${exportName} (${specifier}) is not represented.`));
            }
        }
    }
}

function addTable(extraction: Extraction, connection: string, exportName: string, table: Entity, seen: Map<string, unknown>): void {
    const { api } = extraction;
    const known = extraction.found.get(table);
    if (known !== undefined) {
        if (known.connection !== connection) {
            throw new Error(`Table ${known.name} is exported by modules of two connections (${known.connection} and ${connection}); list each module under one connection`);
        }
        return;
    }
    const dialect = api.dialects.find((d) => api.is(table, d.table));
    if (dialect === undefined) {
        throw new Error(`Table ${api.getTableName(table)} (export ${exportName}) is not a pg-core, mysql-core or sqlite-core table; only those dialects are supported`);
    }
    const config = dialect.getTableConfig(table);
    const name = String(config.name);
    const schema = typeof config.schema === 'string' ? config.schema : null;
    const id = tableId(connection, schema, name);
    if (seen.has(id)) {
        throw new Error(`Connection ${connection} declares table ${schema === null ? name : `${schema}.${name}`} twice (exports ${String(seen.get(id))} and ${exportName})`);
    }
    if ([...extraction.found.values()].some((f) => f.connection === connection && f.exportName === exportName)) {
        throw new Error(`Two different tables are exported as ${exportName} in connection ${connection}; Drizzle's relational queries need distinct export names`);
    }
    seen.set(id, exportName);
    extraction.found.set(table, { table, exportName, connection, dialect, id, name, schema, primaryKey: [], keys: [], model: modelId(exportName, id) });
}

function jsonValue(value: unknown): JsonValue | undefined {
    try {
        const text = JSON.stringify(value) as string | undefined;
        return text === undefined ? undefined : (JSON.parse(text) as JsonValue);
    } catch {
        return undefined;
    }
}

function functionName(fn: Fn): string {
    return fn.name === '' ? '(anonymous function)' : fn.name;
}

// A default given as a JavaScript value: SQL text for what has one spelling in every dialect.
function literal(value: unknown, family: Family): string | null {
    if (value === null) {
        return 'NULL';
    }
    if (typeof value === 'string') {
        // MySQL reads a backslash in a string literal as an escape, so such a value has no portable spelling.
        return family === 'mysql' && value.includes('\\') ? null : `'${value.replace(/'/g, "''")}'`;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : null;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    return null;
}

function extractColumn(extraction: Extraction, found: Found, column: Entity, pk: boolean): ColumnModel {
    const { api } = extraction;
    const { dialect } = found;
    const name = extraction.columnName(column);
    const subject = { type: 'column' as const, id: found.id, columns: [name], label: `${found.name}.${name}` };
    const report = (feature: string | null, message: string): void => {
        extraction.report(found.connection, feature, diagnostic(UNSUPPORTED, subject, message));
    };
    const extra: Record<string, unknown> = {};
    let nativeType: string;
    try {
        nativeType = String((column.getSQLType as Fn).call(column));
    } catch (error) {
        throw new Error(`Column ${found.name}.${name}: getSQLType() failed: ${errorText(error)}`, { cause: error });
    }
    let serverDefault: ColumnModel['serverDefault'] = null;
    let autoIncrement: boolean | null = false;
    const identity = column.generatedIdentity as { type?: string; sequenceName?: string; sequenceOptions?: Record<string, unknown> } | undefined;
    if (identity !== undefined) {
        serverDefault = { kind: 'identity', sql: `GENERATED ${identity.type === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` };
        autoIncrement = true;
        const sequence = { ...(identity.sequenceName === undefined ? {} : { name: identity.sequenceName }), ...(identity.sequenceOptions ?? {}) };
        if (Object.keys(sequence).length > 0) {
            extra.identity = jsonValue(sequence);
        }
    } else if (column.default !== undefined) {
        if (api.is(column.default, api.SQL)) {
            const text = extraction.sql(dialect, column.default, (message) => {
                report('defaults', `The default of ${found.name}.${name} is not represented. ${message}`);
            });
            serverDefault = text === null ? null : sqlDefault(text);
        } else {
            const text = literal(column.default, dialect.family);
            if (text === null) {
                report('defaults', `The default of ${found.name}.${name} is a JavaScript ${Array.isArray(column.default) ? 'array' : typeof column.default} that Drizzle converts for the database; it is kept in extensions.drizzle.default, not as SQL.`);
                extra.default = jsonValue(column.default);
            } else {
                serverDefault = sqlDefault(text);
            }
        }
    }
    if (SERIAL.has(String(column.columnType)) || column.autoIncrement === true) {
        autoIncrement = true;
    } else if (dialect.family === 'sqlite' && pk && found.primaryKey.length === 1 && nativeType.toLowerCase() === 'integer') {
        // SQLite makes an INTEGER PRIMARY KEY the rowid; whether it auto-increments is the database's.
        autoIncrement = null;
    }
    let generated: ColumnModel['generated'] = null;
    const declared = column.generated as { as?: unknown; mode?: string } | undefined;
    if (declared !== undefined && identity === undefined) {
        const as = callable(declared.as) ? declared.as() : declared.as;
        const expression = typeof as === 'string' ? as : extraction.sql(dialect, as, (message) => {
            report(null, `The generated expression of ${found.name}.${name} is not represented. ${message}`);
        });
        if (expression !== null) {
            generated = { storage: declared.mode === 'stored' || declared.mode === 'virtual' ? declared.mode : null, expression };
        }
    }
    let enumeration: ColumnModel['enumeration'] = null;
    const values = Array.isArray(column.enumValues) ? strings(column.enumValues) : null;
    const pgEnum = column.enum as { enumName?: unknown; schema?: unknown } | undefined;
    if (values !== null && pgEnum !== undefined && typeof pgEnum.enumName === 'string') {
        enumeration = { namedType: pgEnum.enumName, values };
        if (typeof pgEnum.schema === 'string') {
            extra.enumSchema = pgEnum.schema;
        }
    } else if (values !== null && String(column.columnType).startsWith('MySqlEnum')) {
        enumeration = { namedType: null, values };
    } else if (values !== null) {
        // A TypeScript-only enum (text({ enum })): the database type is not an enumeration.
        extra.enumValues = values;
    }
    if (callable(column.onUpdateFn)) {
        extra.onUpdate = functionName(column.onUpdateFn);
    }
    return {
        name,
        nativeType,
        baseType: null,
        nullable: column.notNull !== true,
        autoIncrement,
        timezone: typeof column.withTimezone === 'boolean' ? column.withTimezone : null,
        collation: null,
        enumeration,
        serverDefault,
        generated,
        comment: null,
        applicationDefault: callable(column.defaultFn) ? { kind: 'callable', value: functionName(column.defaultFn) } : null,
        extensions: extensions(ORM, extra),
    };
}

// PostgreSQL's defaults (ascending; NULLS LAST ascending, NULLS FIRST descending) are left out, as the database
// document leaves them out.
function pgOrdering(config: { order?: unknown; nulls?: unknown } | undefined): Partial<KeyPartModel> {
    const desc = config?.order === 'desc';
    const nulls = config?.nulls === 'first' ? 'first' : config?.nulls === 'last' ? 'last' : null;
    return { order: desc ? 'desc' : null, nulls: desc ? (nulls === 'last' ? 'last' : null) : nulls === 'first' ? 'first' : null };
}

function extractIndex(extraction: Extraction, found: Found, index: Entity): IndexDeclaration | null {
    const { api } = extraction;
    const { dialect } = found;
    const config = (index.config ?? {}) as Record<string, unknown>;
    const name = typeof config.name === 'string' ? config.name : null;
    const subject = { type: 'table' as const, id: found.id, label: found.name };
    const state = { failed: false };
    const report = (feature: string) => (message: string): void => {
        state.failed = true;
        extraction.report(found.connection, feature, diagnostic(UNSUPPORTED, subject, `Index ${name ?? '(unnamed)'} of ${found.name} is not represented. ${message}`));
    };
    const parts: KeyPartModel[] = [];
    for (const column of Array.isArray(config.columns) ? (config.columns as unknown[]) : []) {
        if (api.is(column, api.SQL)) {
            const text = extraction.sql(dialect, column, report('indexExpressions'));
            if (text !== null) {
                parts.push(expressionPart(text));
            }
        } else if (isEntity(column)) {
            const indexConfig = column.indexConfig as { order?: unknown; nulls?: unknown; opClass?: unknown } | undefined;
            parts.push(columnPart(extraction.columnName(column), dialect.family === 'pg'
                ? { ...pgOrdering(indexConfig), operatorClass: typeof indexConfig?.opClass === 'string' ? indexConfig.opClass : null }
                : {}));
        }
    }
    const predicate = config.where === undefined ? null : extraction.sql(dialect, config.where, report('indexPredicates'));
    if (state.failed) {
        return null;
    }
    const options: Record<string, JsonValue> = {};
    if (dialect.family === 'pg') {
        if (config.concurrently === true) {
            options.concurrently = true;
        }
        if (config.only === true) {
            options.only = true;
        }
        const storage = jsonValue(config.with);
        if (storage !== undefined && storage !== null) {
            options.with = storage;
        }
    } else if (dialect.family === 'mysql') {
        for (const key of ['algorithm', 'lock'] as const) {
            if (typeof config[key] === 'string') {
                options[key] = config[key];
            }
        }
    }
    const method = dialect.family === 'pg' ? (typeof config.method === 'string' ? config.method : null) : dialect.family === 'mysql' && typeof config.using === 'string' ? config.using : null;
    return {
        name,
        keyParts: parts,
        unique: config.unique === true,
        enforces: null,
        method,
        predicate,
        includedColumns: [],
        dialectOptions: Object.keys(options).length === 0 ? {} : { [dialect.family === 'pg' ? 'postgresql' : 'mysql']: options },
    };
}

function extractForeignKey(extraction: Extraction, found: Found, fk: Entity): ForeignKeyModel | null {
    const { api } = extraction;
    let reference: { columns: Entity[]; foreignTable: Entity; foreignColumns: Entity[] };
    let name: string;
    try {
        reference = (fk.reference as () => typeof reference)();
        name = String((fk.getName as Fn).call(fk));
    } catch (error) {
        extraction.report(found.connection, 'foreignKeys', diagnostic(UNSUPPORTED, { type: 'table', id: found.id, label: found.name },
            `A foreign key of ${found.name} is not represented: its reference cannot be resolved (${errorText(error)}).`));
        return null;
    }
    const columns = reference.columns.map((c) => extraction.columnName(c));
    const targetColumns = reference.foreignColumns.map((c) => extraction.columnName(c));
    const target = extraction.found.get(reference.foreignTable);
    const targetName = api.getTableName(reference.foreignTable);
    let targetId: string;
    if (target !== undefined) {
        targetId = target.connection === found.connection ? target.id : tableId(found.connection, target.schema, target.name);
    } else {
        const schema = found.dialect.getTableConfig(reference.foreignTable).schema;
        targetId = tableId(found.connection, typeof schema === 'string' ? schema : null, targetName);
    }
    const id = foreignKeyId(found.id, name, columns, targetId, targetColumns);
    if (target === undefined || target.connection !== found.connection) {
        const where = target === undefined
            ? 'is not exported by the selected modules'
            : `belongs to connection ${target.connection}; a foreign key never crosses connections, so it names ${targetName} in connection ${found.connection}, as that database would resolve it`;
        extraction.diagnostics.push(diagnostic('unresolved_foreign_key', { type: 'foreignKey', id, columns, label: name }, `Foreign key ${name} references ${targetName}, which ${where}.`));
    }
    const onDelete = referentialAction(fk.onDelete as string | undefined);
    const onUpdate = referentialAction(fk.onUpdate as string | undefined);
    return {
        id,
        name,
        columns,
        referencedTable: targetId,
        referencedColumns: targetColumns,
        onUpdate: onUpdate.action,
        onDelete: onDelete.action,
        deferrable: null,
        initially: null,
        extensions: extensions(ORM, { onDelete: onDelete.raw ?? undefined, onUpdate: onUpdate.raw ?? undefined }),
    };
}

function extractTable(extraction: Extraction, found: Found): TableModel {
    const config = found.dialect.getTableConfig(found.table);
    const columns = Array.isArray(config.columns) ? (config.columns as Entity[]) : [];
    const primaryKeys = Array.isArray(config.primaryKeys) ? (config.primaryKeys as Entity[]) : [];
    const subject = { type: 'table' as const, id: found.id, label: found.name };
    const [composite] = primaryKeys;
    found.primaryKey = composite !== undefined
        ? (composite.columns as Entity[]).map((c) => extraction.columnName(c))
        : columns.filter((c) => c.primary === true).map((c) => extraction.columnName(c));
    if (primaryKeys.length > 1 || (composite !== undefined && columns.some((c) => c.primary === true))) {
        extraction.report(found.connection, 'primaryKeys', diagnostic(UNSUPPORTED, subject, `${found.name} declares more than one primary key; the first table-level primaryKey() is kept.`));
    }
    const constraints: ConstraintDeclaration[] = [];
    for (const column of columns) {
        if (column.isUnique === true) {
            constraints.push({
                kind: 'unique',
                name: typeof column.uniqueName === 'string' ? column.uniqueName : null,
                columns: [extraction.columnName(column)],
                extensions: extensions(ORM, { nullsNotDistinct: column.uniqueType === 'not distinct' ? true : undefined }),
            });
        }
    }
    for (const unique of Array.isArray(config.uniqueConstraints) ? (config.uniqueConstraints as Entity[]) : []) {
        constraints.push({
            kind: 'unique',
            name: typeof unique.name === 'string' ? unique.name : null,
            columns: (unique.columns as Entity[]).map((c) => extraction.columnName(c)),
            extensions: extensions(ORM, { nullsNotDistinct: unique.nullsNotDistinct === true ? true : undefined }),
        });
    }
    for (const check of Array.isArray(config.checks) ? (config.checks as Entity[]) : []) {
        const expression = extraction.sql(found.dialect, check.value, (message) => {
            extraction.report(found.connection, 'checkConstraints', diagnostic(UNSUPPORTED, subject, `Check ${String(check.name)} of ${found.name} is not represented. ${message}`));
        });
        if (expression !== null) {
            constraints.push({ kind: 'check', name: typeof check.name === 'string' ? check.name : null, expression, columns: [] });
        }
    }
    const indexes = (Array.isArray(config.indexes) ? (config.indexes as Entity[]) : []).map((i) => extractIndex(extraction, found, i)).filter((i) => i !== null);
    const policies = Array.isArray(config.policies) ? config.policies.length : 0;
    if (policies > 0 || config.enableRLS === true) {
        extraction.report(found.connection, null, diagnostic(UNSUPPORTED, subject, `Row-level security of ${found.name} (enableRLS, ${String(policies)} policies) is not represented.`));
    }
    // The candidate keys that make a one() relation one-to-one.
    found.keys = [
        found.primaryKey,
        ...constraints.filter((c) => c.kind === 'unique').map((c) => c.columns),
        ...indexes.filter((i) => i.unique && i.predicate === null && i.keyParts.every((p) => p.column !== null)).map((i) => i.keyParts.map((p) => p.column ?? '')),
    ].filter((key) => key.length > 0);
    return {
        id: found.id,
        name: found.name,
        schema: found.schema,
        comment: null,
        ownership: { kind: 'application', package: null },
        primaryKey: found.primaryKey,
        columns: columns.map((c) => extractColumn(extraction, found, c, found.primaryKey.includes(extraction.columnName(c)))),
        indexes: declaredIndexes(found.id, indexes) satisfies IndexModel[],
        foreignKeys: (Array.isArray(config.foreignKeys) ? (config.foreignKeys as Entity[]) : []).map((fk) => extractForeignKey(extraction, found, fk)).filter((fk) => fk !== null),
        constraints: declaredConstraints(found.id, constraints),
    };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((x) => b.includes(x));
}

// The relations() of one connection's tables, through Drizzle's own resolution: extractTablesRelationalConfig() and
// normalizeRelation(), which infers a many() or a field-less one() from the inverse one().
function extractRelations(extraction: Extraction, connection: string): AssociationModel[] {
    const { api } = extraction;
    const tables = [...extraction.found.values()].filter((f) => f.connection === connection);
    const schema: Record<string, unknown> = Object.fromEntries(tables.map((f) => [f.exportName, f.table]));
    const own = extraction.relations.filter((r) => r.connection === connection);
    own.forEach((r, n) => {
        schema[`\u0000relations:${String(n)}`] = r.value;
    });
    for (const { value } of own) {
        const owner = extraction.found.get(value.table);
        if (owner === undefined || owner.connection !== connection) {
            extraction.report(connection, 'relationships', diagnostic('unresolved_relationship', { type: 'connection', id: `connection:${connection}`, label: api.getTableName(value.table) },
                `relations() for table ${api.getTableName(value.table)} are exported in connection ${connection}, which does not export that table; they are not represented.`));
        }
    }
    const { tables: configs, tableNamesMap } = api.extractTablesRelationalConfig(schema, api.createTableRelationsHelpers);
    const associations: AssociationModel[] = [];
    const pending: { association: AssociationModel; relation: Entity; owner: Found }[] = [];
    for (const found of tables) {
        const relations = (configs[found.exportName]?.relations ?? {}) as Record<string, Entity>;
        for (const [field, relation] of Object.entries(relations)) {
            const id = relationshipId(found.model, field);
            const subject = { type: 'relationship' as const, id, label: `${found.exportName}.${field}` };
            const target = extraction.found.get(relation.referencedTable);
            const one = api.is(relation, api.One);
            const association: AssociationModel = {
                id,
                name: field,
                model: found.model,
                table: found.id,
                target: { model: target?.model ?? null, table: target?.id ?? null },
                kind: one ? 'one' : 'many',
                cardinality: one ? 'one-to-one' : 'one-to-many',
                many: !one,
                writable: false,
                key: null,
                inverse: null,
                location: null,
                extensions: extensions(ORM, { relationName: typeof relation.relationName === 'string' ? relation.relationName : undefined }),
            };
            associations.push(association);
            if (target === undefined) {
                extraction.report(connection, 'relationships', diagnostic('unresolved_relationship', subject,
                    `Relation ${found.exportName}.${field} leads to ${api.getTableName(relation.referencedTable)}, which is not exported by the selected modules.`));
                continue;
            }
            let normalized: { fields: Entity[]; references: Entity[] };
            try {
                normalized = api.normalizeRelation(configs, tableNamesMap, relation);
            } catch (error) {
                extraction.report(connection, 'relationships', diagnostic('unresolved_relationship', subject, `The columns of relation ${found.exportName}.${field} cannot be resolved: ${errorText(error)}`));
                continue;
            }
            const fields = normalized.fields.map((c) => extraction.columnName(c));
            const references = normalized.references.map((c) => extraction.columnName(c));
            const declaresFields = one && isEntity(relation.config) && Array.isArray(relation.config.fields);
            if (declaresFields) {
                // This side holds the referencing columns.
                association.key = { referencing: { table: found.id, columns: fields }, referenced: { table: target.id, columns: references } };
                association.cardinality = found.keys.some((key) => sameSet(key, fields)) ? 'one-to-one' : 'many-to-one';
            } else {
                // The inverse one() holds them: Drizzle returns this side's columns as fields.
                association.key = { referencing: { table: target.id, columns: references }, referenced: { table: found.id, columns: fields } };
            }
            pending.push({ association, relation, owner: found });
        }
    }
    // The inverse is the target's relation Drizzle pairs with this one (by relationName, else by table), when there is
    // exactly one other.
    for (const { association, relation, owner } of pending) {
        const target = extraction.found.get(relation.referencedTable);
        const candidates = Object.entries((configs[target?.exportName ?? '']?.relations ?? {}) as Record<string, Entity>).filter(([, other]) =>
            other !== relation && (typeof relation.relationName === 'string' ? other.relationName === relation.relationName : other.referencedTable === owner.table));
        const [only] = candidates;
        if (candidates.length === 1 && only !== undefined && target !== undefined) {
            association.inverse = relationshipId(target.model, only[0]);
        }
    }
    return associations;
}

export async function extract(context: ExtractContext): Promise<unknown> {
    const options = checkOptions(context.options);
    const api = await load(context, options.casing);
    const extraction = new Extraction(api);
    for (const connection of options.connections) {
        await discover(extraction, context, connection);
    }
    const connections: ConnectionModel[] = [];
    const entities: EntityModel[] = [];
    const associations: AssociationModel[] = [];
    for (const connection of options.connections) {
        const found = [...extraction.found.values()].filter((f) => f.connection === connection.name);
        if (found.length === 0) {
            throw new Error(`The modules of connection ${connection.name} export no Drizzle tables (${connection.modules.join(', ')})`);
        }
        const families = [...new Set(found.map((f) => f.dialect.family))];
        if (families.length > 1) {
            throw new Error(`Connection ${connection.name} mixes ${families.join(', ')} tables; give each database its own connection`);
        }
        const family = families[0] as Family;
        if (connection.driver !== null && !DRIVERS[family].includes(connection.driver)) {
            throw new Error(`Connection ${connection.name} has driver ${connection.driver}, but its tables are ${family}-core tables`);
        }
        const tables = found.map((f) => extractTable(extraction, f));
        connections.push({ name: connection.name, dialect: (connection.driver ?? (family === 'mysql' ? null : DRIVERS[family][0])) as Dialect | null, defaultSchema: null, read: { schemas: null, features: {} }, tables });
        entities.push(...found.map((f) => ({ id: f.model, name: f.exportName, tables: [f.id], primaryKey: f.primaryKey, location: null })));
    }
    for (const connection of options.connections) {
        associations.push(...extractRelations(extraction, connection.name));
    }
    for (const connection of connections) {
        const family = [...extraction.found.values()].find((f) => f.connection === connection.name)?.dialect.family;
        const partial = Object.fromEntries([...(extraction.partial.get(connection.name) ?? [])].map((feature) => [feature, 'partial']));
        connection.read.features = declaredCoverage({
            comments: 'not_applicable',
            includedColumns: 'not_applicable',
            ...(family === 'mysql' ? { indexPredicates: 'not_applicable' } : {}),
            ...partial,
        });
    }
    return declaredDocument({ orm: ORM, connections, entities, associations, diagnostics: extraction.diagnostics });
}
