// Remove build output directories portably (no shell rm).
import { rmSync } from 'node:fs';

for (const directory of process.argv.slice(2)) {
    rmSync(new URL(`../${directory}`, import.meta.url), { recursive: true, force: true });
}
