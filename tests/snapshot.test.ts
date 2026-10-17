import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalJson } from 'laranex-schema-viewer-ui/contract';
import { loadDocument, MAX_SNAPSHOT_BYTES, revision, SnapshotError, writeDocument } from '../src/snapshot.js';
import { CONTRACT, DECLARED, tempDir, VALID } from './helpers.js';

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
