// Express 5: the application's own routes plus, in development only, the Schema Viewer at /dev/schema-viewer behind
// HTTP Basic Auth. Every viewer request (the page, each asset and snapshot.json) passes the same check first.
import express from 'express';
import { devViewerConfig, isAuthorized, PREFIX, UNAUTHORIZED } from '../lib/dev-auth.mjs';

const app = express();
app.disable('x-powered-by');
app.get('/', (request, response) => {
    response.type('text').send('The application\n');
});

const viewer = devViewerConfig();
if (viewer.enabled) {
    // Loaded only when enabled: production installs omit node-schema-viewer (a development dependency).
    const { createSchemaViewer } = await import('../lib/schema-viewer.mjs');
    const respond = createSchemaViewer({ snapshot: viewer.snapshot, prefix: PREFIX });

    const requireDeveloper = (request, response, next) => {
        // Replace this with your application's own developer or admin check where you have one, e.g.
        // `if (request.user?.roles.includes('developer')) return next();` after your session middleware.
        if (isAuthorized(request.get('authorization'), viewer)) {
            next();
            return;
        }
        response.status(UNAUTHORIZED.status).set(UNAUTHORIZED.headers).send(UNAUTHORIZED.body);
    };

    app.use(PREFIX, requireDeveloper, (request, response) => {
        // Inside app.use, request.path is relative to the prefix; originalUrl tells /dev/schema-viewer from .../.
        const bare = request.originalUrl.split('?')[0] === PREFIX;
        const result = respond(request.method, bare ? '' : request.path);
        response.status(result.status).set(result.headers).send(result.body);
    });
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host, () => {
    console.log(`Listening on http://${host}:${port}${viewer.enabled ? ` (schema viewer at ${PREFIX}/)` : ''}`);
});
