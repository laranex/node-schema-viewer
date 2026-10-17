// Looks for credentials: in the environment, under HOME, and in a file outside the project (LSV_ADVERSARIAL_READ).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { attempt } from './common.mjs';

const names = ['DATABASE_URL', 'MIKRO_ORM_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'LSV_ADVERSARIAL_SECRET', 'NODE_OPTIONS'];

export const outcome = {
    env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])),
    home: homedir(),
    pgpass: existsSync(join(homedir(), '.pgpass')),
    read: await attempt(() => readFileSync(process.env.LSV_ADVERSARIAL_READ, 'utf8')),
};
