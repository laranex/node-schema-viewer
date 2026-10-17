// The introspection worker: reads one database's catalogs and never imports application code.
//
// Started by runner.ts as `node --permission ... worker.js --result PATH` from an empty scratch directory, with read
// access to this package and its dependencies only. The request, including the database URL, arrives on stdin; the
// URL is never in the arguments or the environment. The document goes to a result file; every error is scrubbed of
// the URL and its password before it leaves the worker.
import { readFileSync, writeFileSync } from 'node:fs';
import { defaultSchema, inspectDatabase } from './catalog.js';
import { connectionId } from '../schema/ids.js';
import type { DiagnosticModel } from '../schema/model.js';
import { openSession, privilegeProblems } from './readonly.js';
import { IntrospectionError, scrub } from './request.js';

export interface WorkerRequest {
    url: string;
    schemas: string[];
    connection: string;
    allowWritePrivileges: boolean;
    statementTimeout: number;
}

async function run(request: WorkerRequest): Promise<unknown> {
    const session = await openSession(request.url, request.statementTimeout);
    try {
        let schemas = [...request.schemas];
        if (session.dialect === 'postgresql' && schemas.length === 0) {
            const current = await defaultSchema(session);
            schemas = current === null ? [] : [current];
        }
        const problems = await privilegeProblems(session, schemas);
        const diagnostics: DiagnosticModel[] = [];
        if (problems.length > 0 && !request.allowWritePrivileges) {
            throw new IntrospectionError(
                `The database role can change the schema or data: ${problems.join('; ')}. Inspect with a read-only role ` +
                    '(see docs/database.md), or set allowWritePrivileges to inspect anyway inside read-only transactions.',
            );
        }
        if (problems.length > 0) {
            diagnostics.push({
                kind: 'write_privileges',
                category: 'inspection',
                severity: 'warning',
                certainty: 'certain',
                subject: { type: 'connection', id: connectionId(request.connection), columns: null, label: request.connection },
                message: `Inspected with a role that can change the schema or data (${problems.join('; ')}); the session was read-only.`,
            });
        }
        return await inspectDatabase(session, request.connection, schemas, diagnostics);
    } finally {
        await session.close();
    }
}

async function main(): Promise<void> {
    const index = process.argv.indexOf('--result');
    const result = index >= 0 ? process.argv[index + 1] : undefined;
    if (result === undefined) {
        throw new Error('usage: worker.js --result PATH < request.json');
    }
    let url = '';
    let outcome: Record<string, unknown>;
    try {
        const request = JSON.parse(readFileSync(0, 'utf8')) as WorkerRequest;
        url = request.url;
        outcome = { ok: true, document: await run(request) };
    } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        outcome = { ok: false, error: scrub(message, url).slice(0, 4000) };
    }
    writeFileSync(result, JSON.stringify(outcome), { mode: 0o600 });
    // Drivers may keep sockets or timers alive; the result is written.
    process.exit(0);
}

void main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
});
