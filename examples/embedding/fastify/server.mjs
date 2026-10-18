// Fastify 5: the application's own routes plus, in development only, the Schema Viewer at /dev/schema-viewer behind
// HTTP Basic Auth. The plugin's onRequest hook runs before every route it registers: the page, each asset and
// snapshot.json.
import Fastify from 'fastify';
import { devViewerConfig, isAuthorized, PREFIX, UNAUTHORIZED } from '../lib/dev-auth.mjs';

const app = Fastify({ logger: false });
app.get('/', async () => 'The application\n');

const viewer = devViewerConfig();
if (viewer.enabled) {
    // Loaded only when enabled: production installs omit node-schema-viewer (a development dependency).
    const { createSchemaViewer } = await import('../lib/schema-viewer.mjs');
    const respond = createSchemaViewer({ snapshot: viewer.snapshot, prefix: PREFIX });

    await app.register(
        async (scope) => {
            scope.addHook('onRequest', async (request, reply) => {
                // Or your application's own authentication (a session, @fastify/jwt, ...) with a developer role check.
                if (!isAuthorized(request.headers.authorization, viewer)) {
                    return reply.code(UNAUTHORIZED.status).headers(UNAUTHORIZED.headers).send(UNAUTHORIZED.body);
                }
            });
            const send = (request, reply, path) => {
                const result = respond(request.method, path);
                return reply.code(result.status).headers(result.headers).send(result.body);
            };
            // With a prefix, '/' answers both /dev/schema-viewer and /dev/schema-viewer/; GET routes also answer HEAD.
            scope.get('/', (request, reply) => send(request, reply, request.url.split('?')[0].endsWith('/') ? '/' : ''));
            scope.get('/*', (request, reply) => send(request, reply, `/${request.params['*']}`));
        },
        { prefix: PREFIX },
    );
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
console.log(`Listening on http://${host}:${port}${viewer.enabled ? ` (schema viewer at ${PREFIX}/)` : ''}`);
