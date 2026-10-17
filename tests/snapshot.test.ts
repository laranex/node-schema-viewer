import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalJson } from 'laranex-schema-viewer-ui/contract';
import { loadDocument, MAX_SNAPSHOT_BYTES, revision, SnapshotError, writeDocument } from '../src/snapshot.js';
import { DECLARED, DOCUMENTS, EXPECTED, ROOT, tempDir } from './helpers.js';

const INVALID = join(ROOT, 'node_modules', 'laranex-schema-viewer-ui', 'contract', 'fixtures', 'invalid');

describe('snapshot', () => {
    test("revision is the contract's documentRevision and equals Python's for every strict fixture", () => {
        for (const name of readdirSync(DOCUMENTS)) {
            const document = loadDocument(join(DOCUMENTS, name));
            const expected = JSON.parse(readFileSync(join(EXPECTED, name), 'utf8')) as { python_revision: string; raw_revision: string };
            const sha = createHash('sha256').update(canonicalJson(document)).digest('hex');
            assert.equal(revision(document), sha, name);
            // Python hashes what it read; for a later minor it drops properties it does not know (documented divergence).
            assert.equal(revision(document), expected.raw_revision, name);
            if (name !== 'lenient-future-minor.json') {
                assert.equal(revision(document), expected.python_revision, name);
            }
        }
    });

    test('reads later 1.x minors leniently', () => {
        const document = loadDocument(join(DOCUMENTS, 'lenient-future-minor.json'));
        assert.equal(document.version, '1.7');
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
        writeFileSync(join(dir, 'v2.json'), JSON.stringify({ format: 'laranex-schema', version: '2.0' }));
        assert.throws(() => loadDocument(join(dir, 'v2.json')), /Unsupported laranex-schema version "2.0"/);
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

        const lenient = loadDocument(join(DOCUMENTS, 'lenient-future-minor.json'));
        writeFileSync(path, 'previous');
        assert.throws(() => {
            writeDocument(lenient, path);
        }, /unknown property/);
        assert.throws(() => {
            writeDocument({ format: 'nope' }, path);
        }, /Not a laranex-schema document/);
        assert.equal(readFileSync(path, 'utf8'), 'previous');
        assert.deepEqual(readdirSync(join(dir, 'nested')), ['schema.json']);
    });
});
