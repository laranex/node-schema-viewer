// The package version, from the nearest laranex-schema-viewer package.json above this module (dist/ when installed,
// build/src/ in this repository's tests).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageVersion(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        try {
            const data = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
            if (data.name === 'laranex-schema-viewer' && typeof data.version === 'string') {
                return data.version;
            }
        } catch {
            // Not here; keep looking upwards.
        }
        const parent = dirname(directory);
        if (parent === directory) {
            return '0.0.0';
        }
        directory = parent;
    }
}

export const VERSION = packageVersion();
