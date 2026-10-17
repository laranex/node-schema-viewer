import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from 'laranex-schema-viewer-ui/contract';
import { loadDocument, MAX_SNAPSHOT_BYTES, revision, SnapshotError, writeAtomically, writeDocument } from '../src/snapshot.js';
import { CONTRACT, DECLARED, ROOT, tempDir, VALID } from './helpers.js';

const INVALID = join(CONTRACT, 'fixtures', 'invalid');

// A later 2.x minor with a property 2.0 does not define.
function futureMinor(dir: string): string {
    const document = JSON.parse(readFileSync(DECLARED, 'utf8')) as Record<string, unknown>;
    const path = join(dir, 'future.json');
    writeFileSync(path, JSON.stringify({ ...document, version: '2.7', futureField: { added: true } }));
    return path;
}

describe('snapshot', () => {
    test("revision is the contract's documentRevision: the SHA-256 of the canonical bytes of every shared fixture", () => {
        const names = readdirSync(VALID).filter((name) => name.endsWith('.json'));
        assert.ok(names.length >= 10);
        for (const name of names) {
            const bytes = readFileSync(join(VALID, name));
            assert.equal(revision(loadDocument(join(VALID, name))), createHash('sha256').update(bytes).digest('hex'), name);
        }
    });

    test('reads later 2.x minors leniently', (t) => {
        const document = loadDocument(futureMinor(tempDir(t)));
        assert.equal(document.version, '2.7');
    });

    test('rejects every invalid contract fixture with its expected error; strict-only ones only when writing', (t) => {
        const dir = tempDir(t);
        const names = readdirSync(INVALID).filter((name) => name.endsWith('.json'));
        assert.ok(names.length > 10);
        for (const name of names) {
            const fixture = JSON.parse(readFileSync(join(INVALID, name), 'utf8')) as { document: unknown; errors: string[]; strict: boolean };
            const path = join(dir, name);
            writeFileSync(path, JSON.stringify(fixture.document));
            const expected = (error: Error) =>
                error instanceof SnapshotError && fixture.errors.every((message) => error.message.includes(message));
            if (fixture.strict) {
                // Readers ignore properties a later minor may add; this package rejects them in what it writes.
                loadDocument(path);
                assert.throws(
                    () => {
                        writeDocument(fixture.document, join(dir, 'out.json'));
                    },
                    expected,
                    name,
                );
            } else {
                assert.throws(() => loadDocument(path), (error: Error) => expected(error) && error.message.startsWith(path), name);
            }
        }
    });

    test('missing, non-JSON, wrong format and oversized files fail', (t) => {
        const dir = tempDir(t);
        assert.throws(() => loadDocument(join(dir, 'missing.json')), /Snapshot not found/);
        writeFileSync(join(dir, 'bad.json'), '{');
        assert.throws(() => loadDocument(join(dir, 'bad.json')), /is not JSON/);
        writeFileSync(join(dir, 'v1.json'), JSON.stringify({ tables: [], models: [] }));
        assert.throws(() => loadDocument(join(dir, 'v1.json')), /Not a laranex-schema document/);
        // 1.x is refused with one clear error, never converted.
        writeFileSync(join(dir, 'v1.0.json'), JSON.stringify({ ...JSON.parse(readFileSync(DECLARED, 'utf8')), version: '1.0' }));
        assert.throws(
            () => loadDocument(join(dir, 'v1.0.json')),
            /Unsupported laranex-schema version "1\.0"; this reader supports 2\.x\. Rebuild the snapshot with a producer that writes laranex-schema 2\.0/,
        );
        writeFileSync(join(dir, 'v3.json'), JSON.stringify({ format: 'laranex-schema', version: '3.0' }));
        assert.throws(() => loadDocument(join(dir, 'v3.json')), /Unsupported laranex-schema version "3\.0"/);
        writeFileSync(join(dir, 'big.json'), Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 0x20));
        assert.throws(() => loadDocument(join(dir, 'big.json')), /exceeds the 32 MiB limit/);
        writeFileSync(join(dir, 'bom.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(DECLARED)]));
        assert.throws(() => loadDocument(join(dir, 'bom.json')), /is not JSON/);
    });

    test('writes canonical JSON atomically after strict validation', (t) => {
        const dir = tempDir(t);
        const document = loadDocument(DECLARED);
        const path = join(dir, 'nested', 'schema.json');
        writeDocument(document, path);
        assert.equal(readFileSync(path, 'utf8'), canonicalJson(document));
        assert.deepEqual(readdirSync(join(dir, 'nested')), ['schema.json']);

        const lenient = loadDocument(futureMinor(dir));
        writeFileSync(path, 'previous');
        assert.throws(() => {
            writeDocument(lenient, path);
        }, /unknown property/);
        assert.throws(() => {
            writeDocument({ format: 'nope' }, path);
        }, /Not a laranex-schema document/);
        assert.equal(readFileSync(path, 'utf8'), 'previous');
        assert.deepEqual(readdirSync(join(dir, 'nested')), ['schema.json']);

        assert.throws(() => {
            writeDocument({ ...document, version: '1.0' }, path);
        }, /Unsupported laranex-schema version "1\.0"/);
    });
});

// node:fs as CommonJS: replacing a function there and calling syncBuiltinESMExports() changes the binding that
// src/snapshot.ts imports, so a failure can be injected at an exact step of a write.
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
type Patchable = 'fsyncSync' | 'writeSync';

function withPatched<K extends Patchable>(name: K, replacement: (typeof fs)[K], run: () => void): void {
    const original = fs[name];
    fs[name] = replacement;
    syncBuiltinESMExports();
    try {
        run();
    } finally {
        fs[name] = original;
        syncBuiltinESMExports();
    }
}

const failure = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code });
const DATA = Buffer.from('new content\n'.repeat(4096));

describe('atomic writes', () => {
    test('write the complete file and leave no temporary file', (t) => {
        const dir = tempDir(t);
        const path = join(dir, 'out', 'file.json');
        writeAtomically(DATA, path);
        assert.deepEqual(readFileSync(path), DATA);
        writeAtomically(Buffer.from('replaced'), path);
        assert.equal(readFileSync(path, 'utf8'), 'replaced');
        assert.deepEqual(readdirSync(join(dir, 'out')), ['file.json']);
    });

    test('a write that fails midway leaves the existing file intact and no temporary file', (t) => {
        const dir = tempDir(t);
        const path = join(dir, 'file.json');
        writeFileSync(path, 'previous');
        // The first write stores 100 bytes, the next one fails.
        const original = fs.writeSync;
        let calls = 0;
        const partial = (fd: number, data: Uint8Array, offset: number): number => {
            calls += 1;
            if (calls > 1) {
                throw failure('EIO');
            }
            return original(fd, data.subarray(offset, offset + 100));
        };
        withPatched('writeSync', partial as typeof fs.writeSync, () => {
            assert.throws(() => {
                writeAtomically(DATA, path);
            }, /EIO: simulated/);
        });
        assert.equal(calls, 2);
        assert.equal(readFileSync(path, 'utf8'), 'previous');
        assert.deepEqual(readdirSync(dir), ['file.json']);
    });

    test('an fsync failure fails the write: the existing file stays and no temporary file is left', (t) => {
        const dir = tempDir(t);
        const path = join(dir, 'file.json');
        writeFileSync(path, 'previous');
        // ERR_ACCESS_DENIED is tolerated only under the Permission Model, which this process does not run under.
        assert.equal((process as { permission?: unknown }).permission, undefined);
        for (const code of ['EIO', 'ENOSPC', 'ERR_ACCESS_DENIED']) {
            withPatched(
                'fsyncSync',
                () => {
                    throw failure(code);
                },
                () => {
                    assert.throws(() => {
                        writeAtomically(DATA, path);
                    }, new RegExp(`${code}: simulated`));
                },
            );
            assert.equal(readFileSync(path, 'utf8'), 'previous', code);
            assert.deepEqual(readdirSync(dir), ['file.json'], code);
        }
    });

    test('a failed rename leaves no temporary file', (t) => {
        const dir = tempDir(t);
        const path = join(dir, 'taken');
        mkdirSync(path);
        assert.throws(() => {
            writeAtomically(DATA, path);
        });
        assert.deepEqual(readdirSync(dir), ['taken']);
        assert.deepEqual(readdirSync(path), []);
    });

    test('under the Permission Model, a refused fsync is tolerated and any other fsync error is not', (t) => {
        const dir = realpathSync(tempDir(t));
        const ui = dirname(fileURLToPath(import.meta.resolve('laranex-schema-viewer-ui/package.json')));
        const snapshot = join(ROOT, 'build', 'src', 'snapshot.js');
        // fsync refused as Node.js 22.23+, 24 and 26 refuse it (22.13 allows it), an injected EIO, and fsync as it is.
        const script = (fsync: string, name: string) => `
            import fs from 'node:fs';
            import { syncBuiltinESMExports } from 'node:module';
            ${fsync}
            syncBuiltinESMExports();
            const { writeAtomically } = await import(${JSON.stringify(snapshot)});
            writeAtomically(Buffer.from('written'), ${JSON.stringify(join(dir, name))});
        `;
        const run = (fsync: string, name: string) =>
            spawnSync(process.execPath, ['--permission', `--allow-fs-read=${join(ROOT, 'build')}`, `--allow-fs-read=${ui}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '--input-type=module', '-e', script(fsync, name)], {
                encoding: 'utf8',
            });
        const refused = run("fs.fsyncSync = () => { throw Object.assign(new Error('refused'), { code: 'ERR_ACCESS_DENIED' }); };", 'refused.json');
        assert.equal(refused.status, 0, refused.stderr);
        const native = run('', 'native.json');
        assert.equal(native.status, 0, native.stderr);
        const broken = run("fs.fsyncSync = () => { throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' }); };", 'broken.json');
        assert.notEqual(broken.status, 0);
        assert.match(broken.stderr, /EIO: simulated/);
        assert.equal(readFileSync(join(dir, 'refused.json'), 'utf8'), 'written');
        assert.equal(readFileSync(join(dir, 'native.json'), 'utf8'), 'written');
        assert.deepEqual(readdirSync(dir).sort(), ['native.json', 'refused.json']);
    });
});
