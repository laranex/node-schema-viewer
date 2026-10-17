#!/usr/bin/env node
// One-off test-data maintenance, not a runtime converter: rewrites python-schema-viewer's recorded laranex-schema 1.0
// database documents (tests/fixtures/conformance/database/*.json, scripts/record-database-conformance.py) as 2.0,
// so that the introspection conformance test keeps comparing Node.js documents with Python's while
// python-schema-viewer migrates to 2.0. Run once from the repository root:
//
//   node scripts/convert-database-conformance-2.0.mjs
//
// It changes only what 2.0 changed for these documents (docs/contract.md, "Changes from 1.0"): version "2.0", the
// driver pgsql -> postgresql, Index.columns and Index.primary removed, diagnostic ids added, and the new required
// arrays comparisons, migrations and inferredAssociations (empty). Every result must pass strict validation. A file
// that is already 2.0 is refused, so the script cannot run twice. Re-record the fixtures from python-schema-viewer once
// it writes 2.0, and delete this script then.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, diagnosticId, validateDocument } from 'laranex-schema-viewer-ui/contract';

const DIRECTORY = join('tests', 'fixtures', 'conformance', 'database');
const DRIVERS = { pgsql: 'postgresql' };

for (const name of readdirSync(DIRECTORY).filter((file) => file.endsWith('.json')).sort()) {
    const path = join(DIRECTORY, name);
    const document = JSON.parse(readFileSync(path, 'utf8'));
    if (document.version !== '1.0') {
        throw new Error(`${path} is version ${JSON.stringify(document.version)}, not 1.0`);
    }
    document.version = '2.0';
    for (const connection of document.connections) {
        connection.driver = DRIVERS[connection.driver] ?? connection.driver;
        for (const table of connection.tables) {
            for (const index of table.indexes) {
                delete index.columns;
                delete index.primary;
            }
        }
    }
    document.diagnostics = document.diagnostics.map((diagnostic) => ({ id: diagnosticId(diagnostic), ...diagnostic }));
    Object.assign(document, { comparisons: [], migrations: [], inferredAssociations: [] });
    const result = validateDocument(document, { strict: true });
    if (!result.ok) {
        throw new Error(`${path} is not a valid 2.0 document:\n${result.errors.join('\n')}`);
    }
    writeFileSync(path, canonicalJson(document));
    console.log(`converted ${path}`);
}
