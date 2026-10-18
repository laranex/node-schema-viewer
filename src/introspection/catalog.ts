// A database's catalogs as the internal model (source: database), serialized to a laranex-schema 2.0 document; a port
// of python-schema-viewer's introspection/catalog.py inspect_database and coverage. Runs in the introspection worker
// on one read-only session.
import { tableId } from '../schema/ids.js';
import type { ConnectionModel, DiagnosticModel, Feature, FeatureLevel, TableModel } from '../schema/model.js';
import { serialize } from '../schema/serialize.js';
import { FEATURES, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { str } from './common.js';
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

export async function inspectConnection(session: Session, name: string, schemas: readonly string[]): Promise<ConnectionModel> {
    const fallback = await defaultSchema(session);
    const id = (schema: string | null, table: string): string => tableId(name, schema === null || schema === fallback ? null : schema, table);
    const tables: TableModel[] = [];
    let selected: (string | null)[] = [null];
    if (session.dialect === 'sqlite') {
        tables.push(...(await new SQLiteReader(session, id).tables()));
    } else {
        selected = schemas.length > 0 ? [...schemas] : [fallback];
        const reader = session.dialect === 'postgresql' ? new PostgreSQLReader(session, id) : new MySQLReader(session, id);
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
    return {
        name,
        dialect: session.mariadb ? 'mariadb' : session.dialect,
        defaultSchema: fallback,
        read: { schemas: session.dialect === 'sqlite' ? null : (selected as string[]), features: coverage(session) },
        tables,
    };
}

export async function inspectDatabase(session: Session, name: string, schemas: readonly string[], diagnostics: DiagnosticModel[]): Promise<SchemaDocument> {
    const connection = await inspectConnection(session, name, schemas);
    return serialize({ source: 'database', producer: GENERATOR, orm: null, connections: [connection], entities: [], associations: [], diagnostics });
}

function coverage(session: Session): Partial<Record<Feature, FeatureLevel>> {
    const features: Partial<Record<Feature, FeatureLevel>> = Object.fromEntries(FEATURES.map((f) => [f, 'complete']));
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
    return features;
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
