// Registers exit hooks that would write LSV_ADVERSARIAL_WRITE when the worker leaves.
import { writeFileSync } from 'node:fs';

const write = () => writeFileSync(process.env.LSV_ADVERSARIAL_WRITE, 'exit hook ran');
process.on('exit', write);
process.on('beforeExit', write);
export const outcome = { registered: true };
