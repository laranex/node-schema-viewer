// Test-only extractor (never shipped): imports each hostile module and returns a minimal valid laranex-schema 2.0
// declared document with one table per module, whose comment carries the module's `outcome` export as JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function extract(context) {
    const tables = [];
    for (const specifier of context.modules) {
        const loaded = await context.importModule(specifier);
        const name = specifier.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
        tables.push(table(name, loaded.outcome === undefined ? null : JSON.stringify(loaded.outcome)));
    }
    const document = {
        format: 'laranex-schema',
        version: '2.0',
        source: 'declared',
        generator: { name: 'node-schema-viewer-tests', orm: 'adversarial' },
        note: null,
        connections: [
            {
                id: 'connection:default',
                name: 'default',
                driver: null,
                defaultSchema: null,
                coverage: { database: null, declared: { complete: false, features: {}, schemas: null } },
                tables,
            },
        ],
        models: [],
        relationships: [],
        links: [],
        derivedLinks: [],
        diagnostics: [],
        comparisons: [],
        migrations: [],
        inferredAssociations: [],
    };
    const mode = context.options.mode;
    if (mode === 'invalid') {
        document.connections[0].tables.push({ name: 'broken' });
    } else if (mode === 'database') {
        // A valid 2.0 document, but not a declared one: the shared fixture from the installed contract package.
        const path = join(context.projectRoot, 'node_modules', 'laranex-schema-viewer-ui', 'contract', 'fixtures', 'valid', 'database-sqlite-indexes.json');
        return JSON.parse(readFileSync(path, 'utf8'));
    } else if (mode === 'v1') {
        // A 1.0 document: refused, never converted.
        const { comparisons, migrations, inferredAssociations, ...v1 } = document;
        return { ...v1, version: '1.0' };
    } else if (mode === 'huge') {
        document.note = 'x'.repeat(33 * 1024 * 1024);
    }
    return document;
}

function table(name, comment) {
    return {
        id: `table:default.${name}`,
        name,
        schema: null,
        comment,
        note: null,
        owner: { kind: 'application', package: null },
        provenance: ['declared'],
        primaryKey: ['id'],
        columns: [
            {
                name: 'id', type: 'INTEGER', typeName: 'integer', nullable: false, default: null, ormDefault: null,
                autoIncrement: null, collation: null, comment: null, enum: null, generated: null, note: null,
                timezone: null, provenance: ['declared'],
            },
        ],
        indexes: [],
        constraints: [],
        foreignKeys: [],
    };
}
