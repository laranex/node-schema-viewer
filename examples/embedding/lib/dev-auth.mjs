// Development-only switch and HTTP Basic Auth for the embedded Schema Viewer. No dependencies beyond node:crypto, so
// it can run in front of the viewer (Express, Fastify, NestJS) and in a Next.js proxy.
import { createHash, timingSafeEqual } from 'node:crypto';

export const PREFIX = '/dev/schema-viewer';
const MIN_PASSWORD_LENGTH = 16;

// The viewer is off unless SCHEMA_VIEWER_ENABLED=1, and always off when NODE_ENV=production. When it is on, the
// credentials and the snapshot path are required; the error names the missing variables, never their values.
export function devViewerConfig(env = process.env) {
    if (env.NODE_ENV === 'production' || env.SCHEMA_VIEWER_ENABLED !== '1') {
        return { enabled: false };
    }
    const missing = ['SCHEMA_VIEWER_USER', 'SCHEMA_VIEWER_PASSWORD', 'SCHEMA_VIEWER_SNAPSHOT'].filter((name) => !env[name]);
    if (missing.length > 0) {
        throw new Error(`The development schema viewer is enabled but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`);
    }
    if (env.SCHEMA_VIEWER_PASSWORD.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`SCHEMA_VIEWER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    return { enabled: true, user: env.SCHEMA_VIEWER_USER, password: env.SCHEMA_VIEWER_PASSWORD, snapshot: env.SCHEMA_VIEWER_SNAPSHOT };
}

const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

// Compares SHA-256 digests with timingSafeEqual, so neither the length nor the content of a guess changes the timing.
// Both comparisons always run.
export function isAuthorized(header, { user, password }) {
    const match = /^Basic[ ]+([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
    if (!match) {
        return false;
    }
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) {
        return false;
    }
    const userOk = timingSafeEqual(digest(decoded.slice(0, colon)), digest(user));
    const passwordOk = timingSafeEqual(digest(decoded.slice(colon + 1)), digest(password));
    return userOk && passwordOk;
}

// The 401 every framework sends: a challenge and a generic body, nothing about the schema.
export const UNAUTHORIZED = {
    status: 401,
    headers: {
        'WWW-Authenticate': 'Basic realm="Schema Viewer (development)", charset="UTF-8"',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
    },
    body: 'Authentication required\n',
};
