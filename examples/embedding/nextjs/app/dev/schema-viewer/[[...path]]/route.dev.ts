// The standalone viewer under /dev/schema-viewer/: index.html, app.js, app.css, assets/* and snapshot.json, all
// answered here and all behind the same check. Exists only in `next dev` with SCHEMA_VIEWER_ENABLED=1 (next.config.mjs).
import { devViewerConfig, isAuthorized, PREFIX, UNAUTHORIZED } from '../../../../../lib/dev-auth.mjs';
import { createSchemaViewer } from '../../../../../lib/schema-viewer.mjs';

export const dynamic = 'force-dynamic';

let respond: ReturnType<typeof createSchemaViewer> | undefined;

async function handle(request: Request, { params }: { params: Promise<{ path?: string[] }> }): Promise<Response> {
    const viewer = devViewerConfig();
    if (!viewer.enabled) {
        return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (!isAuthorized(request.headers.get('authorization'), viewer)) {
        return new Response(UNAUTHORIZED.body, { status: UNAUTHORIZED.status, headers: UNAUTHORIZED.headers });
    }
    const { path = [] } = await params;
    if (path.length === 0) {
        // Next.js removes trailing slashes, so the page lives at index.html, where its relative URLs resolve.
        return new Response(null, { status: 308, headers: { Location: `${PREFIX}/index.html`, 'Cache-Control': 'no-store' } });
    }
    respond ??= createSchemaViewer({ snapshot: viewer.snapshot, prefix: PREFIX });
    const result = respond(request.method, `/${path.join('/')}`);
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(result.body), { status: result.status, headers: result.headers });
}

export { handle as GET, handle as HEAD };
