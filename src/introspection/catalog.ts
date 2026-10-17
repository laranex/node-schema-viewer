// A database's catalogs as a laranex-schema 1.0 document (source: database), a port of python-schema-viewer's
// introspection/catalog.py inspect_database and coverage. Runs in the introspection worker on one read-only session.
import { buildGraph, FEATURES, VERSION, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { byId, connectionId, identifier, sortDiagnostics, str, type Diagnostic, type Table } from './common.js';
import { MySQLReader } from './mysql.js';
import { PostgreSQLReader } from './postgresql.js';
import type { Session } from './readonly.js';
import { IntrospectionError } from './request.js';
import { SQLiteReader } from './sqlite.js';

export const GENERATOR = 'node-schema-viewer';

export async function defaultSchema(session: Session): Promise<string | null> {
    if (session.dialect === 'sqlite') {
        return null;
    }
    const sql = session.dialect === 'postgresql' ? 'SELECT current_schema()' : 'SELECT DATABASE()';
    const value = (await session.rows(sql))[0]?.[0];
    return value === null || value === undefined ? null : str(value);
}

export async function inspectDatabase(session: Session, name: string, schemas: readonly string[], diagnostics: Diagnostic[]): Promise<SchemaDocument> {
    const fallback = await defaultSchema(session);
    const tableId = (schema: string | null, table: string): string => identifier(name, schema === null || schema === fallback ? null : schema, table);
    const tables: Table[] = [];
    let selected: (string | null)[] = [null];
    if (session.dialect === 'sqlite') {
        tables.push(...(await new SQLiteReader(session, tableId).tables()));
    } else {
        selected = schemas.length > 0 ? [...schemas] : [fallback];
        const reader = session.dialect === 'postgresql' ? new PostgreSQLReader(session, tableId) : new MySQLReader(session, tableId);
        if (reader instanceof PostgreSQLReader) {
            await reader.load();
        }
        const known = await reader.schemaNames();
        for (const schema of selected) {
            if (schema === null || !known.includes(schema)) {
                throw new IntrospectionError(`Schema ${pyRepr(schema)} does not exist or the role cannot see it`);
            }
            tables.push(...(await reader.tables(schema)));
        }
    }
    for (const table of tables) {
        byId(table.indexes);
        byId(table.foreignKeys);
        byId(table.constraints);
    }
    const driver = session.mariadb ? 'mariadb' : session.dialect === 'postgresql' ? 'pgsql' : session.dialect;
    const document = {
        format: 'laranex-schema',
        version: VERSION,
        source: 'database',
        generator: { name: GENERATOR, orm: null },
        note: null,
        connections: [
            {
                id: connectionId(name),
                name,
                driver,
                defaultSchema: fallback,
                coverage: { database: coverage(session, session.dialect === 'sqlite' ? null : (selected as string[])), declared: null },
                tables: byId(tables),
            },
        ],
        models: [],
        relationships: [],
        links: [],
        derivedLinks: [],
        diagnostics: sortDiagnostics(diagnostics),
    } as unknown as SchemaDocument;
    return { ...document, ...buildGraph(document) };
}

function coverage(session: Session, schemas: string[] | null): { complete: boolean; schemas: string[] | null; features: Record<string, string> } {
    const features: Record<string, string> = Object.fromEntries(FEATURES.map((f) => [f, 'complete']));
    Object.assign(features, { models: 'not_applicable', relationships: 'not_applicable' });
    if (session.dialect === 'mysql') {
        Object.assign(features, { includedColumns: 'not_applicable', indexPredicates: 'not_applicable' });
        const [major = 0, minor = 0, patch = 0] = session.version;
        // Functional key parts: MySQL 8.0.13+, never MariaDB.
        if (session.mariadb || major * 1e6 + minor * 1e3 + patch < 8000013) {
            features.indexExpressions = 'not_applicable';
        }
    } else if (session.dialect === 'sqlite') {
        Object.assign(features, { comments: 'not_applicable', includedColumns: 'not_applicable', checkConstraints: 'partial' });
    }
    const complete = Object.values(features).every((v) => v === 'complete' || v === 'not_applicable');
    return { complete, schemas, features };
}

// Python's repr() of a str (or None), as python-schema-viewer's messages show schema names.
function pyRepr(value: string | null): string {
    if (value === null) {
        return 'None';
    }
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
}
