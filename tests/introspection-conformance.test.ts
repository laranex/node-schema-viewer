// Database introspection compared with python-schema-viewer: tests/fixtures/conformance/database/*.json are Python's
// own laranex-schema 2.0 documents for the synthetic schemas in tests/databases/ (scripts/record-database-conformance.py). The Node.js
// documents must be equal after normalizing only the generator and the random MySQL/MariaDB database name.
// SQLite cases always run; server cases need LSV_TEST_POSTGRES_URL, LSV_TEST_MYSQL_URL, LSV_TEST_MARIADB_URL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { introspect, introspectAll } from '../src/introspection/index.js';
import { adminUrl, serverDatabase, sqliteDatabase, type Server } from './databases.js';
import { ROOT } from './helpers.js';

const FIXTURES = join(ROOT, 'tests', 'fixtures', 'conformance', 'database');
const PLACEHOLDER = '<database>';

// name -> (server, DDL files, schemas), as in scripts/record-database-conformance.py.
const CASES: Record<string, [Server | 'sqlite', string[], string[]]> = {
    postgresql: ['postgres', ['postgresql.sql'], ['public', 'billing']],
    'postgresql-default-schema': ['postgres', ['postgresql.sql'], []],
    'drift-postgresql': ['postgres', ['drift-postgresql.sql'], []],
    mysql: ['mysql', ['mysql.sql', 'mysql-functional.sql'], []],
    'drift-mysql': ['mysql', ['drift-mysql.sql'], []],
    mariadb: ['mariadb', ['mysql.sql'], []],
    'drift-mariadb': ['mariadb', ['drift-mysql.sql'], []],
    sqlite: ['sqlite', ['sqlite.sql'], []],
    'drift-sqlite': ['sqlite', ['drift-sqlite.sql'], []],
};

// Only generator-specific fields differ by design; the random database name is replaced as the recorder replaced it.
export function normalize(document: unknown, names: string[]): unknown {
    const text = names.reduce((json, name) => json.split(name).join(PLACEHOLDER), JSON.stringify(document));
    const value = JSON.parse(text) as { generator: unknown };
    value.generator = { name: '<generator>', orm: null };
    return value;
}

function expected(name: string): unknown {
    return normalize(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')), []);
}

describe('conformance with python-schema-viewer', () => {
    for (const [name, [server, files, schemas]] of Object.entries(CASES)) {
        const skip = server !== 'sqlite' && adminUrl(server) === undefined ? `set the ${server} test URL` : false;
        test(name, { skip }, async () => {
            if (server === 'sqlite') {
                const database = sqliteDatabase(files);
                try {
                    assert.deepEqual(normalize(await introspect({ url: database.url }), []), expected(name));
                } finally {
                    database.drop();
                }
                return;
            }
            const database = await serverDatabase(server, files);
            try {
                const document = await introspect({ url: database.url('reader'), schemas });
                assert.deepEqual(normalize(document, [database.name]), expected(name));
            } finally {
                await database.drop();
            }
        });
    }

    const multiSkip = adminUrl('postgres') === undefined || adminUrl('mysql') === undefined ? 'set the PostgreSQL and MySQL test URLs' : false;
    test('multi-connection', { skip: multiSkip }, async () => {
        const postgres = await serverDatabase('postgres', ['drift-postgresql.sql']);
        const mysql = await serverDatabase('mysql', ['drift-mysql.sql']);
        const sqlite = sqliteDatabase(['drift-sqlite.sql']);
        try {
            const document = await introspectAll([
                { url: postgres.url('reader'), connection: 'default' },
                { url: mysql.url('reader'), connection: 'analytics' },
                { url: sqlite.url, connection: 'local' },
            ]);
            assert.deepEqual(normalize(document, [postgres.name, mysql.name]), expected('multi-connection'));
        } finally {
            await postgres.drop();
            await mysql.drop();
            sqlite.drop();
        }
    });
});
