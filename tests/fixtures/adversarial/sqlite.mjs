// Opens a SQLite database file with node:sqlite at import time (node:sqlite ignores the Permission Model).
import { attempt } from './common.mjs';

export const outcome = {
    sqlite: await attempt(async () => {
        const { DatabaseSync } = await import('node:sqlite');
        const database = new DatabaseSync(process.env.LSV_ADVERSARIAL_SQLITE);
        database.exec('CREATE TABLE hostile (id INTEGER)');
        database.close();
        return 'written';
    }),
};
