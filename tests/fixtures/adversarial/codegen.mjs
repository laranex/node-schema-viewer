// Generates code from strings at import time.
import { attempt } from './common.mjs';

export const outcome = {
    eval: await attempt(() => String((0, eval)('1 + 1'))),
    function: await attempt(() => String(new Function('return 2')())),
};
