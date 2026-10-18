// NestJS 12 (Express platform): the application's module plus, in development only, the Schema Viewer at
// /dev/schema-viewer behind HTTP Basic Auth. The viewer is functional middleware on the underlying Express instance,
// registered before Nest's routes, so every viewer request (the page, each asset and snapshot.json) passes the same
// check first. Nest guards only run for controllers, so they cannot protect these files.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { devViewerConfig, isAuthorized, PREFIX, UNAUTHORIZED } from '../../lib/dev-auth.mjs';
import { AppModule } from './app.module.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
app.disable('x-powered-by');

const viewer = devViewerConfig();
if (viewer.enabled) {
    // Loaded only when enabled: production installs omit node-schema-viewer (a development dependency).
    const { createSchemaViewer } = await import('../../lib/schema-viewer.mjs');
    const respond = createSchemaViewer({ snapshot: viewer.snapshot, prefix: PREFIX });

    const requireDeveloper = (request: Request, response: Response, next: NextFunction): void => {
        // Or your application's own authentication middleware (a session or passport strategy) with a role check.
        if (isAuthorized(request.get('authorization'), viewer)) {
            next();
            return;
        }
        response.status(UNAUTHORIZED.status).set(UNAUTHORIZED.headers).send(UNAUTHORIZED.body);
    };

    app.use(PREFIX, requireDeveloper, (request: Request, response: Response) => {
        const bare = request.originalUrl.split('?')[0] === PREFIX;
        const result = respond(request.method, bare ? '' : request.path);
        response.status(result.status).set(result.headers).send(result.body);
    });
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen(port, host);
console.log(`Listening on http://${host}:${port}${viewer.enabled ? ` (schema viewer at ${PREFIX}/)` : ''}`);
