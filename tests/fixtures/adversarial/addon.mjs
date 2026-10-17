// Loads a native addon at import time: an addon would run outside every Node.js check.
import { attempt } from './common.mjs';

export const outcome = {
    dlopen: await attempt(() => (process.dlopen({ exports: {} }, process.env.LSV_ADVERSARIAL_ADDON), 'loaded')),
};
