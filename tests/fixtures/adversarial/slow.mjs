// Records its process id in LSV_ADVERSARIAL_PID, then never finishes importing.
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.LSV_ADVERSARIAL_PID, String(process.pid));
setInterval(() => undefined, 1000);
await new Promise(() => undefined);
