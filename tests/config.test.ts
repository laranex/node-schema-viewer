import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { addConfig, ConfigError, loadConfig, resolveSnapshot } from '../src/config.js';
import { tempDir } from './helpers.js';

function project(dir: string, data: unknown, text?: string): string {
    const path = join(dir, 'package.json');
    writeFileSync(path, text ?? `${JSON.stringify(data, null, 2)}\n`);
    return path;
}

describe('config', () => {
    test('no package.json or no key means no configured output', (t) => {
        const dir = tempDir(t);
        assert.deepEqual(loadConfig(dir), { output: null });
        project(dir, { name: 'app' });
        assert.deepEqual(loadConfig(dir), { output: null });
        assert.equal(resolveSnapshot(undefined, dir), join(dir, 'schema-viewer.json'));
    });

    test('output resolves against the project root; an explicit snapshot wins', (t) => {
        const dir = tempDir(t);
        project(dir, { name: 'app', 'laranex-schema-viewer': { output: 'docs/schema.json' } });
        assert.deepEqual(loadConfig(dir), { output: join(dir, 'docs', 'schema.json') });
        assert.equal(resolveSnapshot(undefined, dir), join(dir, 'docs', 'schema.json'));
        assert.equal(resolveSnapshot('/elsewhere/x.json', dir), '/elsewhere/x.json');
    });

    test('rejects unknown keys, wrong types and non-objects', (t) => {
        const dir = tempDir(t);
        for (const [section, message] of [
            [{ output: 'a.json', modules: [] }, /Unknown .* keys: modules/],
            [{ output: 3 }, /output must be a non-empty string path/],
            [{ output: '' }, /output must be a non-empty string path/],
            ['schema.json', /must be an object/],
            [null, /must be an object/],
            [[], /must be an object/],
        ] as const) {
            project(dir, { name: 'app', 'laranex-schema-viewer': section });
            assert.throws(() => loadConfig(dir), (error: Error) => error instanceof ConfigError && message.test(error.message));
        }
    });

    test('rejects database URLs without echoing them', (t) => {
        const dir = tempDir(t);
        const secret = 'postgres://user:hunter2@db.internal/app';
        for (const section of [{ databaseUrl: 'x' }, { database_url: 'x' }, { url: 'x' }, { output: secret }, { DSN: 'x' }]) {
            project(dir, { 'laranex-schema-viewer': section });
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
            '{\n    "name": "app",\n    "scripts": {\n        "test": "node --test"\n    },\n    "private": true,\n    "laranex-schema-viewer": {\n        "output": "docs/schema.json"\n    }\n}\n',
        );
        assert.deepEqual(loadConfig(dir), { output: join(dir, 'docs', 'schema.json') });
    });

    test('init keeps tabs and the absence of a final newline', (t) => {
        const dir = tempDir(t);
        const path = project(dir, null, '{\n\t"name": "app"\n}');
        addConfig(dir);
        assert.equal(readFileSync(path, 'utf8'), '{\n\t"name": "app",\n\t"laranex-schema-viewer": {\n\t\t"output": "schema-viewer.json"\n\t}\n}');
    });

    test('init refuses to replace an existing key, a missing package.json and URLs', (t) => {
        const dir = tempDir(t);
        assert.throws(() => addConfig(dir), /No package.json/);
        const path = project(dir, { name: 'app', 'laranex-schema-viewer': { output: 'a.json' } });
        const before = readFileSync(path, 'utf8');
        assert.throws(() => addConfig(dir), /already contains "laranex-schema-viewer"/);
        assert.equal(readFileSync(path, 'utf8'), before);
        project(dir, { name: 'app' });
        assert.throws(() => addConfig(dir, 'mysql://root@localhost/db'), /must not contain a URL/);
    });
});
