// Writes a file at import time, wherever LSV_ADVERSARIAL_WRITE points.
import { writeFileSync } from 'node:fs';
import { attempt } from './common.mjs';

export const outcome = { write: await attempt(() => (writeFileSync(process.env.LSV_ADVERSARIAL_WRITE, 'written'), 'written')) };
