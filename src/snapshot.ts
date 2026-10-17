// Bounded loading, canonical serialization, revisions and atomic writes of laranex-schema 2.x documents. 1.x is
// rejected with one clear error: nothing reads or converts it.
// The contract (validation, canonical JSON, revision) comes from laranex-schema-viewer-ui; nothing here duplicates it.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertDocument, canonicalJson, documentRevision, UnsupportedDocumentError, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';

export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

const REBUILD = '. Rebuild the snapshot with a producer that writes laranex-schema 2.0; nothing converts older documents';

export class SnapshotError extends Error {
    override name = 'SnapshotError';
}

// At most limit + 1 bytes, so an oversized file is detected without reading all of it.
function readBounded(path: string, limit: number): Buffer {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < buffer.length) {
            const read = readSync(fd, buffer, length, buffer.length - length, null);
            if (read === 0) {
                break;
            }
            length += read;
        }
        return buffer.subarray(0, length);
    } finally {
        closeSync(fd);
    }
}

export function parseDocument(data: Uint8Array, label: string): SchemaDocument {
    if (data.length > MAX_SNAPSHOT_BYTES) {
        throw new SnapshotError(`${label} exceeds the 32 MiB limit`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data));
    } catch (error) {
        throw new SnapshotError(`${label} is not JSON: ${(error as Error).message}`);
    }
    try {
        return assertDocument(parsed);
    } catch (error) {
        throw new SnapshotError(`${label}: ${(error as Error).message}${error instanceof UnsupportedDocumentError ? REBUILD : ''}`);
    }
}

// A laranex-schema 2.x document, validated leniently as a reader: later 2.x minors' unknown properties are ignored.
export function loadDocument(path: string): SchemaDocument {
    let data: Buffer;
    try {
        data = readBounded(path, MAX_SNAPSHOT_BYTES);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new SnapshotError(code === 'ENOENT' ? `Snapshot not found: ${path}` : `Cannot read snapshot ${path}: ${(error as Error).message}`);
    }
    return parseDocument(data, path);
}

export function revision(document: SchemaDocument): string {
    return documentRevision(document);
}

export function snapshotBytes(document: SchemaDocument): Buffer {
    return Buffer.from(canonicalJson(document), 'utf8');
}

// Everything this package writes is strictly validated (producer rules) and canonical.
export function writeDocument(document: unknown, path: string): void {
    let valid: SchemaDocument;
    try {
        valid = assertDocument(document, { strict: true });
    } catch (error) {
        throw new SnapshotError((error as Error).message);
    }
    writeAtomically(snapshotBytes(valid), path);
}

export function writeAtomically(data: Uint8Array, path: string, limit = MAX_SNAPSHOT_BYTES): void {
    if (data.length > limit) {
        throw new SnapshotError('Snapshot exceeds the 32 MiB limit');
    }
    const destination = resolve(path);
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = join(dirname(destination), `.schema-${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(temporary, 'wx', 0o644);
    try {
        try {
            let written = 0;
            while (written < data.length) {
                written += writeSync(fd, data, written, data.length - written);
            }
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temporary, destination);
    } finally {
        rmSync(temporary, { force: true });
    }
}
