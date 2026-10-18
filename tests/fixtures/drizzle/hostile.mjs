// A hostile Drizzle schema module: at import time it tries the network, a write outside the project, a child process
// and a database URL from the environment, and records each outcome as a column name of its table (the only channel
// back through the Drizzle adapter). The build tests require every attempt to be blocked.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { integer, pgTable } from 'drizzle-orm/pg-core';

// Self-contained, so that the tests can copy it into a project of its own.
async function attempt(action) {
    try {
        return await action();
    } catch (error) {
        return `blocked ${error?.code ?? error?.cause?.code ?? error?.name ?? String(error)}`;
    }
}

const [host, port] = (process.env.LSV_ADVERSARIAL_TCP ?? '127.0.0.1:9').split(':');

function connect() {
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(port), host);
        socket.on('connect', () => {
            socket.destroy();
            resolve('connected');
        });
        socket.on('error', reject);
    });
}

const outcomes = {
    tcp: await attempt(connect),
    fetch: await attempt(async () => (await fetch(`http://${host}:${port}/`), 'fetched')),
    write: await attempt(() => (writeFileSync(process.env.LSV_ADVERSARIAL_WRITE ?? '/tmp/lsv-hostile', 'x'), 'written')),
    spawn: await attempt(() => (execFileSync(process.execPath, ['-e', '0']), 'spawned')),
    env: process.env.LSV_HOSTILE_DATABASE_URL === undefined ? 'blocked absent' : `read ${process.env.LSV_HOSTILE_DATABASE_URL}`,
};

export const outcome = pgTable('outcome', Object.fromEntries(Object.entries(outcomes).map(([probe, result]) => [probe, integer(`${probe}=${result}`)])));
