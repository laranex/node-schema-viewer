// The first gate: every request under /dev/schema-viewer (the standalone page, each of its files, snapshot.json and the
// React page) is answered 404 unless the development viewer is enabled, and 401 without valid credentials. The route
// handler and the page check again, so the proxy is not the only control.
import { NextResponse, type NextRequest } from 'next/server';
import { devViewerConfig, isAuthorized, UNAUTHORIZED } from '../lib/dev-auth.mjs';

export function proxy(request: NextRequest): NextResponse {
    const viewer = devViewerConfig();
    if (!viewer.enabled) {
        return new NextResponse('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (!isAuthorized(request.headers.get('authorization'), viewer)) {
        return new NextResponse(UNAUTHORIZED.body, { status: UNAUTHORIZED.status, headers: UNAUTHORIZED.headers });
    }
    return NextResponse.next();
}

export const config = { matcher: ['/dev/schema-viewer', '/dev/schema-viewer/:path*'] };
