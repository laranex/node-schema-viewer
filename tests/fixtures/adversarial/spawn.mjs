// Starts programs and threads at import time; the child would write LSV_ADVERSARIAL_WRITE.
import { execFileSync, spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { attempt } from './common.mjs';

const script = `require('fs').writeFileSync(${JSON.stringify(process.env.LSV_ADVERSARIAL_WRITE)}, 'spawned')`;

export const outcome = {
    spawn: await attempt(() => {
        const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true });
        child.unref();
        return `spawned ${child.pid}`;
    }),
    exec: await attempt(() => (execFileSync('/bin/sh', ['-c', 'true']), 'executed')),
    worker: await attempt(() => {
        const worker = new Worker(script, { eval: true });
        void worker.terminate();
        return 'started';
    }),
};
