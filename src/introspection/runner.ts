// Runs the introspection worker, one per connection, and validates the document it returns. A port of
// python-schema-viewer's introspection/runner.py (introspect, introspect_all, merge) on the isolation helpers that
// the extraction worker uses (process group, log file, bounded result file).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDocument, buildGraph, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { introspectionEnvironment } from '../isolation/env.js';
import { fileSystemFlags, packageRoot, readResultFile, runWorker, scratchDirectory } from '../isolation/runner.js';
import { codePoints } from './statements.js';
import { IntrospectionError, parseUrl, scrub, type DatabaseRequest } from './request.js';
import type { WorkerRequest } from './worker.js';

// The packages the worker loads, with their dependencies. The UI package is granted alone: its contract module
// imports nothing else.
const DRIVERS = ['pg', 'mysql2'];
const CONTRACT = 'laranex-schema-viewer-ui';

export interface Invocation {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    // Sent on stdin: the only place the URL travels.
    input: string;
}

export interface RunnerOptions {
    // Sees every worker invocation before it starts (tests check what each worker receives).
    observe?: (invocation: Invocation) => void;
}

interface Normalized extends WorkerRequest {
    timeout: number;
}

function normalize(request: DatabaseRequest): Normalized {
    const timeout = request.timeout ?? 120;
    const statementTimeout = request.statementTimeout ?? 30;
    for (const [name, value] of [['timeout', timeout], ['statementTimeout', statementTimeout]] as const) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new IntrospectionError(`${name} must be a positive number of seconds`);
        }
    }
    const connection = request.connection ?? 'default';
    if (typeof connection !== 'string' || connection === '') {
        throw new IntrospectionError('connection must be a non-empty name');
    }
    let url = request.url;
    const parsed = parseUrl(url);
    if (parsed.dialect === 'sqlite') {
        url = sqliteUrl(parsed.path ?? '');
    }
    return {
        url,
        schemas: [...(request.schemas ?? [])],
        connection,
        allowWritePrivileges: request.allowWritePrivileges === true,
        statementTimeout,
        timeout,
    };
}

// An existing regular file, by its real path: the worker opens it read-only and never creates it.
function sqliteUrl(path: string): string {
    const absolute = resolve(path);
    let real: string;
    try {
        real = realpathSync.native(absolute);
    } catch {
        throw new IntrospectionError(`The SQLite database ${absolute} does not exist; nothing was created`);
    }
    if (!statSync(real).isFile()) {
        throw new IntrospectionError(`The SQLite database ${absolute} is not a regular file`);
    }
    return pathToFileURL(real).href.replace(/^file:/, 'sqlite:');
}

// node_modules lookup as Node.js resolves a bare specifier from `from`.
function findPackage(name: string, from: string): string | null {
    for (let directory = from; ; directory = dirname(directory)) {
        const candidate = join(directory, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) {
            return candidate;
        }
        if (dirname(directory) === directory) {
            return null;
        }
    }
}

let roots: string[] | null = null;

// What the worker may read: this package and the directories of the packages it loads, never the project.
export function readRoots(): string[] {
    if (roots !== null) {
        return roots;
    }
    const root = packageRoot();
    const found = new Set<string>([root]);
    const add = (path: string): void => {
        found.add(path);
        found.add(realpathSync.native(path));
    };
    const contract = findPackage(CONTRACT, root);
    if (contract === null) {
        throw new IntrospectionError(`Cannot find ${CONTRACT}, a dependency of node-schema-viewer`);
    }
    add(contract);
    const pending = DRIVERS.map((name) => ({ name, from: root, required: true }));
    const seen = new Set<string>();
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const directory = findPackage(next.name, next.from);
        if (directory === null) {
            if (next.required) {
                throw new IntrospectionError(`Cannot find ${next.name}, a dependency of node-schema-viewer`);
            }
            continue;
        }
        const real = realpathSync.native(directory);
        if (seen.has(real)) {
            continue;
        }
        seen.add(real);
        add(directory);
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
        };
        for (const name of Object.keys(manifest.dependencies ?? {})) {
            pending.push({ name, from: real, required: !(name in (manifest.optionalDependencies ?? {})) });
        }
        for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
            pending.push({ name, from: real, required: false });
        }
    }
    roots = [...found];
    return roots;
}

// The worker's command line, environment and stdin. The Permission Model applies on every Node.js version; the
// network is granted where it is restricted (Node.js 25+), as the drivers need it.
export function buildInvocation(scratch: string, request: WorkerRequest, worker = join(dirname(fileURLToPath(import.meta.url)), 'worker.js')): Invocation {
    const home = join(scratch, 'home');
    const tmp = join(scratch, 'tmp');
    const out = join(scratch, 'out');
    const cwd = join(scratch, 'work');
    const net = process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : [];
    const args = [
        ...fileSystemFlags([...readRoots(), home, tmp, out, cwd], [home, tmp, out], 'introspection'),
        ...net,
        '--no-addons',
        '--disallow-code-generation-from-strings',
        worker,
        '--result',
        join(out, 'result.json'),
    ];
    const env = introspectionEnvironment(process.env, { home, tmp });
    return { command: process.execPath, args, cwd, env, input: JSON.stringify(request) };
}

// One connection as a laranex-schema 1.0 document (source: database), or IntrospectionError. Never falls back to
// declared metadata.
export async function introspect(request: DatabaseRequest, options: RunnerOptions = {}): Promise<SchemaDocument> {
    const normalized = normalize(request);
    const { timeout, ...payload } = normalized;
    const fail = (message: string): IntrospectionError => new IntrospectionError(scrub(scrub(message, payload.url), request.url));
    const scratch = scratchDirectory('lsv-introspect-');
    try {
        for (const name of ['home', 'tmp', 'out', 'work']) {
            mkdirSync(join(scratch, name), { mode: 0o700 });
        }
        const invocation = buildInvocation(scratch, payload);
        options.observe?.(invocation);
        const log = join(scratch, 'output.log');
        const run = await runWorker(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            env: invocation.env,
            input: invocation.input,
            log,
            timeoutMs: timeout * 1000,
            worker: 'introspection',
        });
        if (run.timedOut) {
            throw new IntrospectionError(`Database introspection did not finish within ${String(timeout)} seconds and was stopped`);
        }
        const result = readResultFile(join(scratch, 'out', 'result.json'), log, 'introspection', fail);
        if (result.ok !== true) {
            throw fail(String(result.error).slice(0, 4000));
        }
        let document: SchemaDocument;
        try {
            document = assertDocument(result.document, { strict: true });
        } catch (validation) {
            throw fail(`The introspection worker returned an invalid document: ${(validation as Error).message.slice(0, 2000)}`);
        }
        if (document.source !== 'database') {
            throw new IntrospectionError(`The introspection worker returned a ${JSON.stringify(document.source)} document; expected "database"`);
        }
        return document;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

// Several connections as one database document. Each connection is read by its own worker, which receives only that
// connection's URL; one failure fails the whole inspection.
export async function introspectAll(requests: readonly DatabaseRequest[], options: RunnerOptions = {}): Promise<SchemaDocument> {
    const names = requests.map((r) => r.connection ?? 'default');
    if (names.length === 0 || new Set(names).size !== names.length) {
        throw new IntrospectionError('Inspect at least one connection, each under a distinct name');
    }
    const documents: SchemaDocument[] = [];
    for (const request of requests) {
        documents.push(await introspect(request, options));
    }
    return merge(documents);
}

// Database documents with distinct connection names as one document.
export function merge(documents: readonly SchemaDocument[]): SchemaDocument {
    const [first] = documents;
    if (first === undefined) {
        throw new IntrospectionError('Nothing to merge');
    }
    const diagnostics = documents.flatMap((d) => d.diagnostics);
    const key = (d: SchemaDocument['diagnostics'][number]): string[] => [d.category, d.kind, d.subject.type, d.subject.id ?? '', d.message];
    diagnostics.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        for (let i = 0; i < x.length; i += 1) {
            const order = codePoints(x[i] ?? '', y[i] ?? '');
            if (order !== 0) {
                return order;
            }
        }
        return 0;
    });
    const document: SchemaDocument = {
        ...first,
        connections: documents.flatMap((d) => d.connections).sort((a, b) => codePoints(a.name, b.name)),
        diagnostics,
        links: [],
        derivedLinks: [],
    };
    return assertDocument({ ...document, ...buildGraph(document) }, { strict: true });
}
