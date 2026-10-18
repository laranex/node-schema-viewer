import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { addConfig, comparisonOption, ConfigError, EMPTY_BUILD, loadConfig, resolveSnapshot } from '../src/config.js';
import { tempDir } from './helpers.js';

function project(dir: string, data: unknown, text?: string): string {
    const path = join(dir, 'package.json');
    writeFileSync(path, text ?? `${JSON.stringify(data, null, 2)}\n`);
    return path;
}

const NONE = { comparisons: [], check: { severity: null, certainty: null }, build: EMPTY_BUILD };

describe('config', () => {
    test('no package.json or no key means no configured output', (t) => {
        const dir = tempDir(t);
        assert.deepEqual(loadConfig(dir), { output: null, ...NONE });
        project(dir, { name: 'app' });
        assert.deepEqual(loadConfig(dir), { output: null, ...NONE });
        assert.equal(resolveSnapshot(undefined, dir), join(dir, 'schema-viewer.json'));
    });

    test('output resolves against the project root; an explicit snapshot wins', (t) => {
        const dir = tempDir(t);
        project(dir, { name: 'app', 'node-schema-viewer': { output: 'docs/schema.json' } });
        assert.deepEqual(loadConfig(dir), { output: join(dir, 'docs', 'schema.json'), ...NONE });
        assert.equal(resolveSnapshot(undefined, dir), join(dir, 'docs', 'schema.json'));
        assert.equal(resolveSnapshot('/elsewhere/x.json', dir), '/elsewhere/x.json');
    });

    test('rejects unknown keys, wrong types and non-objects', (t) => {
        const dir = tempDir(t);
        for (const [section, message] of [
            [{ output: 'a.json', recursive: true }, /Unknown .* keys: recursive/],
            [{ output: 3 }, /output must be a non-empty string path/],
            [{ output: '' }, /output must be a non-empty string path/],
            ['schema.json', /must be an object/],
            [null, /must be an object/],
            [[], /must be an object/],
        ] as const) {
            project(dir, { name: 'app', 'node-schema-viewer': section });
            assert.throws(() => loadConfig(dir), (error: Error) => error instanceof ConfigError && message.test(error.message));
        }
    });

    test('rejects database URLs without echoing them', (t) => {
        const dir = tempDir(t);
        const secret = 'postgres://user:hunter2@db.internal/app';
        for (const section of [{ databaseUrl: 'x' }, { database_url: 'x' }, { url: 'x' }, { output: secret }, { DSN: 'x' }]) {
            project(dir, { 'node-schema-viewer': section });
            assert.throws(
                () => loadConfig(dir),
                (error: Error) => error instanceof ConfigError && /URL/.test(error.message) && !error.message.includes('hunter2'),
            );
        }
    });

    test('invalid package.json is reported', (t) => {
        const dir = tempDir(t);
        project(dir, null, '{ not json');
        assert.throws(() => loadConfig(dir), /is not valid JSON/);
        project(dir, null, '[]');
        assert.throws(() => loadConfig(dir), /must contain a JSON object/);
    });

    test('init adds the key and keeps everything else, order, indentation and final newline', (t) => {
        const dir = tempDir(t);
        const original = '{\n    "name": "app",\n    "scripts": {\n        "test": "node --test"\n    },\n    "private": true\n}\n';
        const path = project(dir, null, original);
        assert.equal(addConfig(dir, 'docs/schema.json'), path);
        const text = readFileSync(path, 'utf8');
        assert.equal(
            text,
            '{\n    "name": "app",\n    "scripts": {\n        "test": "node --test"\n    },\n    "private": true,\n    "node-schema-viewer": {\n        "output": "docs/schema.json"\n    }\n}\n',
        );
        assert.deepEqual(loadConfig(dir), { output: join(dir, 'docs', 'schema.json'), ...NONE });
    });

    test('init keeps tabs and the absence of a final newline', (t) => {
        const dir = tempDir(t);
        const path = project(dir, null, '{\n\t"name": "app"\n}');
        addConfig(dir);
        assert.equal(readFileSync(path, 'utf8'), '{\n\t"name": "app",\n\t"node-schema-viewer": {\n\t\t"output": "schema-viewer.json"\n\t}\n}');
    });

    test('init refuses to replace an existing key, a missing package.json and URLs', (t) => {
        const dir = tempDir(t);
        assert.throws(() => addConfig(dir), /No package.json/);
        const path = project(dir, { name: 'app', 'node-schema-viewer': { output: 'a.json' } });
        const before = readFileSync(path, 'utf8');
        assert.throws(() => addConfig(dir), /already contains "node-schema-viewer"/);
        assert.equal(readFileSync(path, 'utf8'), before);
        project(dir, { name: 'app' });
        assert.throws(() => addConfig(dir, 'mysql://root@localhost/db'), /must not contain a URL/);
    });

    test('comparisons and check thresholds', (t) => {
        const dir = tempDir(t);
        project(dir, {
            'node-schema-viewer': {
                comparisons: [
                    {
                        baseline: { connection: 'app', schema: 'tenant_template' },
                        target: { connection: 'app', schema: '*' },
                        limit: 0,
                        overrides: [
                            { objectType: 'index', change: 'extra', severity: 'info' },
                            { objectType: 'column', change: 'changed', field: 'comment', severity: 'warning' },
                        ],
                    },
                    { baseline: { connection: 'primary' }, target: { connection: 'replica', schema: null } },
                ],
                check: { severity: 'error', certainty: 'likely' },
            },
        });
        assert.deepEqual(loadConfig(dir), {
            output: null,
            comparisons: [
                {
                    baseline: { connection: 'app', schema: 'tenant_template' },
                    target: { connection: 'app', schema: '*' },
                    limit: 0,
                    overrides: [
                        { objectType: 'index', change: 'extra', field: null, severity: 'info' },
                        { objectType: 'column', change: 'changed', field: 'comment', severity: 'warning' },
                    ],
                },
                { baseline: { connection: 'primary', schema: null }, target: { connection: 'replica', schema: null }, limit: 500, overrides: [] },
            ],
            check: { severity: 'error', certainty: 'likely' },
            build: EMPTY_BUILD,
        });
    });

    test('rejects invalid comparisons and thresholds', (t) => {
        const dir = tempDir(t);
        const scope = { baseline: { connection: 'a' }, target: { connection: 'b' } };
        for (const [section, message] of [
            [{ comparisons: {} }, /comparisons must be an array of objects/],
            [{ comparisons: [1] }, /comparisons must be an array of objects/],
            [{ comparisons: [{ ...scope, extra: 1 }] }, /Unknown .*comparisons\[0\] keys: extra/],
            [{ comparisons: [{ target: { connection: 'b' } }] }, /comparisons\[0\] baseline must be an object/],
            [{ comparisons: [{ ...scope, baseline: { connection: 'a b' } }] }, /baseline needs connection, a connection name/],
            [{ comparisons: [{ ...scope, baseline: { connection: 'a', schema: '*' } }] }, /baseline schema cannot be "\*"/],
            [{ comparisons: [{ ...scope, target: { connection: 'b', schema: '' } }] }, /target schema must be a schema name \(never a URL\)/],
            [{ comparisons: [{ ...scope, target: { connection: 'b', schema: 'u@h' } }] }, /target schema must be a schema name \(never a URL\)/],
            [{ comparisons: [{ ...scope, target: { connection: 'b', port: 1 } }] }, /Unknown .*target keys: port/],
            [{ comparisons: [{ baseline: { connection: 'a' }, target: { connection: 'a' } }] }, /compares a with itself/],
            [{ comparisons: [{ ...scope, limit: -1 }] }, /limit must be a nonnegative integer/],
            [{ comparisons: [{ ...scope, limit: 1.5 }] }, /limit must be a nonnegative integer/],
            [{ comparisons: [{ ...scope, limit: true }] }, /limit must be a nonnegative integer/],
            [{ check: [] }, /check must be an object/],
            [{ check: { severity: 'fatal' } }, /check severity must be one of error, warning, info/],
            [{ check: { certainty: 'maybe' } }, /check certainty must be one of certain, likely/],
            [{ check: { fail: true } }, /Unknown .*check keys: fail/],
        ] as const) {
            project(dir, { 'node-schema-viewer': section });
            assert.throws(() => loadConfig(dir), (error: Error) => error instanceof ConfigError && message.test(error.message), JSON.stringify(section));
        }
    });

    test('validates overrides with the shared rules and reports them at their package.json location', (t) => {
        const dir = tempDir(t);
        const at = `${join(dir, 'package.json')} "node-schema-viewer" comparisons[1]`;
        const scope = { baseline: { connection: 'a' }, target: { connection: 'b' } };
        const general = { objectType: 'column', change: 'changed', severity: 'info' };
        for (const [overrides, message] of [
            [{}, `${at} overrides must be an array`],
            [[1], `${at} overrides[0] must be an object`],
            [[{ object_type: 'table', change: 'changed', severity: 'info' }], `${at} overrides[0] has unknown keys: object_type; ${at} overrides[0].objectType must be one of table, column, primaryKey, index, foreignKey, constraint`],
            [[{ objectType: 'view', change: 'gone' }], `${at} overrides[0].objectType must be one of table, column, primaryKey, index, foreignKey, constraint; ${at} overrides[0].change must be one of missing, extra, changed; ${at} overrides[0].severity must be one of error, warning, info`],
            [[{ ...general, field: 'width' }], `${at} overrides[0].field must be one of collation, comment, default, enum, generated, nullable, type for objectType column`],
            [[{ objectType: 'index', change: 'extra', field: 'name', severity: 'info' }], `${at} overrides[0].field applies only to changed differences, not extra`],
            [[{ ...general, field: 1 }], `${at} overrides[0].field must be a string or null`],
            [[general, { ...general, field: 'type' }, { ...general, field: null, severity: 'error' }], `${at} overrides[2] repeats overrides[0]`],
        ] as const) {
            project(dir, { 'node-schema-viewer': { comparisons: [scope, { ...scope, overrides }] } });
            assert.throws(() => loadConfig(dir), (error: Error) => error instanceof ConfigError && error.message === message, JSON.stringify(overrides));
        }
    });

    test('comparisons never accept a URL, and errors never echo one', (t) => {
        const dir = tempDir(t);
        const secret = 'postgres://user:hunter2@db.internal/app';
        for (const scope of [{ connection: secret }, { connection: 'a', schema: secret }, { connection: 'a', schema: 'user:hunter2@db' }, { connection: 'a', url: 'x' }]) {
            project(dir, { 'node-schema-viewer': { comparisons: [{ baseline: scope, target: { connection: 'b' } }] } });
            assert.throws(() => loadConfig(dir), (error: Error) => error instanceof ConfigError && !error.message.includes('hunter2'), JSON.stringify(scope));
        }
        for (const option of [secret, `a=${secret}`, `${secret}=b`, 'a=b:user:hunter2@db', 'a=b://hunter2']) {
            assert.throws(() => comparisonOption(option), (error: Error) => error instanceof ConfigError && !error.message.includes('hunter2'), option);
        }
    });

    test('BASELINE=TARGET options', () => {
        assert.deepEqual(comparisonOption('app:tenant_a=app:*', 7), {
            baseline: { connection: 'app', schema: 'tenant_a' },
            target: { connection: 'app', schema: '*' },
            limit: 7,
            overrides: [],
        });
        assert.deepEqual(comparisonOption('primary=replica').target, { connection: 'replica', schema: null });
        for (const [option, message] of [
            ['app', /A comparison is BASELINE=TARGET/],
            ['app:=b', /A comparison is BASELINE=TARGET/],
            ['=b', /A comparison is BASELINE=TARGET/],
            ['app:*=b', /Only a comparison target's schema can be "\*"/],
            ['app:x=app:x', /not app:x with itself/],
        ] as const) {
            assert.throws(() => comparisonOption(option), message, option);
        }
    });
});
