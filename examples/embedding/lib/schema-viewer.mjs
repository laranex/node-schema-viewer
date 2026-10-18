// The embedded viewer's files and snapshot as plain { status, headers, body } responses, so Express, Fastify, NestJS and
// Next.js route handlers send the same thing. Import it only after the development switch is on: node-schema-viewer is
// a development dependency and is not installed in production.
import { loadDocument, loadViewer, POLICY } from 'node-schema-viewer';
import { canonicalJson } from 'laranex-schema-viewer-ui/contract';

const COMMON = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const text = (status, message, extra = {}) => ({
    status,
    headers: { ...COMMON, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
    body: Buffer.from(`${message}\n`),
});

// prefix: where the viewer is mounted, e.g. /dev/schema-viewer. policy: the Content-Security-Policy of every response;
// node-schema-viewer's POLICY forbids framing (frame-ancestors 'none'), so pass one with frame-ancestors 'self' to
// show the viewer in an iframe of the same application.
export function createSchemaViewer({ snapshot, prefix, policy = POLICY }) {
    loadDocument(snapshot); // Fail at startup when the snapshot is missing or not a laranex-schema 2.x document.
    const files = loadViewer(); // Only the files laranex-schema-viewer-ui's manifest lists, checked by SHA-256.
    const headers = (type) => ({ ...COMMON, 'Content-Security-Policy': policy, 'Content-Type': type });

    // path: the request path below the prefix ('' for the prefix itself, '/', '/app.js', '/snapshot.json', ...).
    // It checks neither credentials nor the Host header: call it only after the application's authentication has
    // accepted the request. Every response, errors included, carries Cache-Control: no-store.
    return function respond(method, path) {
        if (method !== 'GET' && method !== 'HEAD') {
            return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
        }
        if (path === '') {
            // index.html loads app.css, app.js and snapshot.json by relative URLs, so it needs the trailing slash.
            return text(308, 'Permanent redirect', { Location: `${prefix}/` });
        }
        if (path === '/snapshot.json') {
            try {
                // Re-read and validated on every request, so a rebuilt snapshot shows up on reload.
                return { status: 200, headers: headers('application/json; charset=utf-8'), body: Buffer.from(canonicalJson(loadDocument(snapshot))) };
            } catch {
                return text(503, 'Snapshot unavailable');
            }
        }
        const file = files.get(path);
        return file ? { status: 200, headers: headers(file.type), body: file.body } : text(404, 'Not found');
    };
}
