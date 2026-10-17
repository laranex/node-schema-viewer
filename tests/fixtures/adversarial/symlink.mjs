// Reads through LSV_ADVERSARIAL_LINK, a symlink inside a readable directory that points outside it.
import { readFileSync } from 'node:fs';
import { attempt } from './common.mjs';

export const outcome = { read: await attempt(() => readFileSync(process.env.LSV_ADVERSARIAL_LINK, 'utf8')) };
