// Small snapshot-only HTTP server on node:http, mirroring python-schema-viewer's server.py.
// It serves exactly the files the prebuilt viewer's manifest lists (laranex-schema-viewer-ui's dist/viewer, each
// verified against its SHA-256 at startup and held in memory) and the configured document as /snapshot.json, which is
// re-read and validated on every request.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, FORMAT, MAJOR } from 'laranex-schema-viewer-ui/contract';
import { loadDocument } from './snapshot.js';

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
};
const JSON_TYPE = 'application/json; charset=utf-8';
export const POLICY =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export class ViewerError extends Error {
    override name = 'ViewerError';
}

export interface Asset {
    body: Buffer;
    type: string;
}

export function defaultViewerDirectory(): string {
    return fileURLToPath(new URL('.', import.meta.resolve('laranex-schema-viewer-ui/viewer/manifest.json')));
}

// URL path -> asset, for exactly the files the manifest lists, verified against their sizes and SHA-256 digests.
export function loadViewer(directory: string = defaultViewerDirectory()): Map<string, Asset> {
    let manifest: unknown;
    try {
        manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    } catch (error) {
        throw new ViewerError(`Cannot read the viewer manifest in ${directory}: ${(error as Error).message}`);
    }
    // The viewer must read the contract major this package writes and validates.
    const contract = (manifest as { contract?: { format?: unknown; major?: unknown } }).contract;
    if (contract?.format !== FORMAT || contract.major !== MAJOR) {
        throw new ViewerError(`The viewer in ${directory} does not read ${FORMAT} ${String(MAJOR)}.x`);
    }
    const files = (manifest as { files?: unknown }).files;
    if (!Array.isArray(files)) {
        throw new ViewerError('The viewer manifest has no files list');
    }
    const routes = new Map<string, Asset>();
    for (const entry of files as { path?: unknown; size?: unknown; sha256?: unknown }[]) {
        const path = entry.path;
        if (typeof path !== 'string' || !SAFE_PATH.test(path) || typeof entry.sha256 !== 'string') {
            throw new ViewerError(`The viewer manifest lists an invalid entry: ${JSON.stringify(path)}`);
        }
        const type = TYPES[extname(path)];
        if (type === undefined) {
            continue; // Like the Python server: only known web asset types are served (never JSON, which /snapshot.json owns).
        }
        let body: Buffer;
        try {
            body = readFileSync(join(directory, ...path.split('/')));
        } catch (error) {
            throw new ViewerError(`Viewer file ${path} is missing: ${(error as Error).message}`);
        }
        const digest = createHash('sha256').update(body).digest('hex');
        if (digest !== entry.sha256 || (typeof entry.size === 'number' && entry.size !== body.length)) {
            throw new ViewerError(`Viewer file ${path} does not match its manifest checksum`);
        }
        routes.set(`/${path}`, { body, type });
    }
    const index = routes.get('/index.html');
    if (index === undefined) {
        throw new ViewerError('The viewer manifest does not list index.html');
    }
    routes.set('/', index);
    return routes;
}

// The Host header's hostname as Python's urlsplit("//" + host).hostname reads it: lower case, without user info, port
// or IPv6 brackets; null when there is none.
export function hostname(header: string | undefined): string | null {
    let netloc = (header ?? '').toLowerCase();
    netloc = netloc.slice(netloc.lastIndexOf('@') + 1);
    let name: string;
    if (netloc.startsWith('[')) {
        const end = netloc.indexOf(']');
        name = end === -1 ? '' : netloc.slice(1, end);
    } else {
        name = netloc.split(':', 1)[0] ?? '';
    }
    return name === '' ? null : name;
}

export interface ServeOptions {
    snapshot: string;
    host?: string;
    port?: number;
    viewerDirectory?: string;
}

const COMMON_HEADERS = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': POLICY,
};

function send(response: ServerResponse, status: number, body: Buffer, type: string, head: boolean, extra: Record<string, string> = {}): void {
    response.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': type, 'Content-Length': String(body.length), ...extra });
    response.end(head ? undefined : body);
}

function sendError(response: ServerResponse, status: number, message: string, head: boolean, extra: Record<string, string> = {}): void {
    send(response, status, Buffer.from(`${message}\n`), 'text/plain; charset=utf-8', head, extra);
}

// Validates the snapshot and the viewer files before binding; listens with Node's default backlog (511).
export function createViewerServer(options: ServeOptions): Server {
    const host = options.host ?? '127.0.0.1';
    const snapshot = options.snapshot;
    loadDocument(snapshot); // Fail before binding if the snapshot is missing, invalid or oversized.
    const routes = loadViewer(options.viewerDirectory);
    const allowed = new Set([host, 'localhost', '127.0.0.1', '::1']);

    return createServer((request: IncomingMessage, response: ServerResponse) => {
        const head = request.method === 'HEAD';
        if (request.method !== 'GET' && !head) {
            sendError(response, 405, 'Method not allowed', false, { Allow: 'GET, HEAD' });
            return;
        }
        const name = hostname(request.headers.host);
        if (name === null || !allowed.has(name)) {
            sendError(response, 403, 'Host not allowed', head);
            return;
        }
        const route = (request.url ?? '').split(/[?#]/, 1)[0] ?? '';
        if (route === '/snapshot.json') {
            let body: Buffer;
            try {
                body = Buffer.from(canonicalJson(loadDocument(snapshot)), 'utf8');
            } catch {
                sendError(response, 503, 'Snapshot unavailable or invalid', head);
                return;
            }
            send(response, 200, body, JSON_TYPE, head);
            return;
        }
        const asset = routes.get(route);
        if (asset !== undefined) {
            send(response, 200, asset.body, asset.type, head);
        } else {
            sendError(response, 404, 'Not found', head);
        }
    });
}

export function displayUrl(host: string, port: number): string {
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}
