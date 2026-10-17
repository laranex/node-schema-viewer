// Bounded loading, canonical serialization, revisions and atomic writes of laranex-schema 2.x documents. 1.x is
// rejected with one clear error: nothing reads or converts it.
// The contract (validation, canonical JSON, revision) comes from laranex-schema-viewer-ui; nothing here duplicates it.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
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

// Under the Node.js Permission Model, Node.js 22.23+, 24 and 26 refuse fsync with ERR_ACCESS_DENIED even for a path
// --allow-fs-write grants (22.13 allows it). There the write stays atomic (a temporary file renamed over the
// destination) but is not flushed before the rename. Any other fsync failure, or ERR_ACCESS_DENIED without the
// Permission Model, fails the write.
function flush(fd: number): void {
    try {
        fsyncSync(fd);
    } catch (error) {
        const underPermissionModel = (process as { permission?: unknown }).permission !== undefined;
        if (!underPermissionModel || (error as NodeJS.ErrnoException).code !== 'ERR_ACCESS_DENIED') {
            throw error;
        }
    }
}

// A temporary file in the destination's directory, written, flushed and renamed over the destination: readers see the
// previous file or the new one, never a partial one, and a failed write removes the temporary file.
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
            flush(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temporary, destination);
    } catch (error) {
        // unlink, not rm: rm also reads the path, which a process granted only writes to this directory cannot.
        try {
            unlinkSync(temporary);
        } catch {
            // The write's own error is the one to report.
        }
        throw error;
    }
}
