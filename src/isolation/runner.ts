// Runs the extraction worker at the requested isolation level and validates what it returns.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDocument } from 'laranex-schema-viewer-ui/contract';
import { workerEnvironment } from './env.js';
import { EXTRACTOR_NAME, EXTRACTORS } from './extractor.js';
import { checkPolicy, IsolationError, isolationConfig, type ExtractRequest, type ExtractResult, type IsolationConfig } from './index.js';

export const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const OUTPUT_TAIL = 4000;
const POSIX = process.platform !== 'win32';

export async function extract(request: ExtractRequest, overrides: Partial<IsolationConfig> = {}): Promise<ExtractResult> {
    const config = isolationConfig(overrides);
    checkPolicy(config.level);
    if (config.level === 'container') {
        const { extractInContainer } = await import('./container.js');
        return extractInContainer(request, config);
    }
    return extractInProcess(request, config);
}

// Permission Model flags shared by both levels. Never --allow-net, --allow-child-process, --allow-worker,
// --allow-addons or --allow-wasi.
export function permissionFlags(reads: readonly string[], writes: readonly string[], config: IsolationConfig): string[] {
    return [
        ...fileSystemFlags(reads, writes, 'extraction'),
        '--no-addons',
        // node:sqlite ignores the Permission Model; without the module, application code cannot open database files.
        '--no-experimental-sqlite',
        ...(config.allowCodeGeneration ? [] : ['--disallow-code-generation-from-strings']),
    ];
}

// --permission with the given read and write grants, shared by the extraction and introspection workers.
export function fileSystemFlags(reads: readonly string[], writes: readonly string[], worker: string): string[] {
    for (const path of [...reads, ...writes]) {
        if (path.includes(',')) {
            // Node.js 22 reads a comma as a list separator in these flags.
            throw new IsolationError(`Paths with commas cannot be granted to the ${worker} worker: ${path}`);
        }
    }
    return ['--permission', ...unique(reads).map((path) => `--allow-fs-read=${path}`), ...unique(writes).map((path) => `--allow-fs-write=${path}`)];
}

function unique(paths: readonly string[]): string[] {
    return [...new Set(paths)];
}

function real(path: string): string {
    return realpathSync.native(path);
}

function inside(path: string, root: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// This package's root: the nearest node-schema-viewer package.json above this module.
export function packageRoot(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        try {
            const data = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown };
            if (data.name === 'node-schema-viewer') {
                return real(directory);
            }
        } catch {
            // Not here; keep looking upwards.
        }
        const parent = dirname(directory);
        if (parent === directory) {
            throw new IsolationError('Cannot find the node-schema-viewer package directory');
        }
        directory = parent;
    }
}

// The nearest directory above the project that declares workspaces (npm, Yarn, pnpm, Lerna, Rush), or null.
export function workspaceRoot(projectRoot: string): string | null {
    let directory = dirname(projectRoot);
    for (;;) {
        if (['pnpm-workspace.yaml', 'lerna.json', 'rush.json'].some((file) => existsSync(join(directory, file)))) {
            return directory;
        }
        try {
            const data = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { workspaces?: unknown };
            if (data.workspaces !== undefined) {
                return directory;
            }
        } catch {
            // No package.json, or not JSON.
        }
        const parent = dirname(directory);
        if (parent === directory) {
            return null;
        }
        directory = parent;
    }
}

// What the worker may read: the project, its workspace, every node_modules directory module resolution can reach
// from it, this package, and configured extras.
export function readRoots(projectRoot: string, config: IsolationConfig): string[] {
    const roots = [projectRoot, packageRoot()];
    const workspace = workspaceRoot(projectRoot);
    if (workspace !== null) {
        roots.push(workspace);
    }
    for (let directory = projectRoot; ; directory = dirname(directory)) {
        const modules = join(directory, 'node_modules');
        if (existsSync(modules)) {
            roots.push(real(modules));
        }
        if (dirname(directory) === directory) {
            break;
        }
    }
    for (const entry of config.allowReads) {
        const path = resolve(projectRoot, entry);
        if (!existsSync(path)) {
            throw new IsolationError(`allowReads entry ${JSON.stringify(entry)} does not exist`);
        }
        roots.push(real(path));
    }
    return unique(roots);
}

export function allowedWrites(projectRoot: string, config: IsolationConfig): string[] {
    return config.allowWrites.map((entry) => {
        const path = resolve(projectRoot, entry);
        const target = existsSync(path) ? real(path) : path;
        if (!inside(target, projectRoot)) {
            throw new IsolationError(`allowWrites entry ${JSON.stringify(entry)} is outside the project`);
        }
        return target;
    });
}

// A registered extractor name, or the absolute path of a module inside the project.
export function checkExtractor(extractor: string, projectRoot: string): string {
    if (EXTRACTOR_NAME.test(extractor)) {
        if (!(extractor in EXTRACTORS)) {
            throw new IsolationError(`Unknown extractor ${JSON.stringify(extractor)}`);
        }
        return extractor;
    }
    if (isAbsolute(extractor) && existsSync(extractor) && inside(real(extractor), projectRoot)) {
        return real(extractor);
    }
    throw new IsolationError(`Extractor ${JSON.stringify(extractor)} must be a registered name or a module inside the project`);
}

export interface WorkerRun {
    timedOut: boolean;
    code: number | null;
    signal: NodeJS.Signals | null;
}

// Starts a worker in its own process group with output going to a log file (a pipe could be held open by a process
// the worker leaves behind), sends the request on stdin, and kills the whole group when the worker exits or the
// timeout passes.
export function runWorker(
    command: string,
    args: readonly string[],
    options: { cwd: string; env: Record<string, string>; input: string; log: string; timeoutMs: number; onTimeout?: () => void; worker?: string },
): Promise<WorkerRun> {
    const output = openSync(options.log, 'w', 0o600);
    let child: ChildProcess;
    try {
        child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['pipe', output, output],
            detached: POSIX,
            windowsHide: true,
        });
    } finally {
        closeSync(output);
    }
    return new Promise((resolvePromise, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            options.onTimeout?.();
            killGroup(child.pid);
        }, options.timeoutMs);
        child.stdin?.on('error', () => {
            // The worker exited before reading its request; its exit reports why.
        });
        child.stdin?.end(options.input);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(new IsolationError(`Cannot start the ${options.worker ?? 'extraction'} worker: ${error.message}`));
        });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            // Whatever the application left behind in the worker's process group.
            killGroup(child.pid);
            resolvePromise({ timedOut, code, signal });
        });
    });
}

export function killGroup(pid: number | undefined): void {
    if (pid === undefined) {
        return;
    }
    if (POSIX) {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            // The group is already gone.
        }
    } else {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    }
}

export function logTail(path: string): string {
    try {
        const size = statSync(path).size;
        const fd = openSync(path, 'r');
        try {
            const buffer = Buffer.alloc(Math.min(size, OUTPUT_TAIL));
            readSync(fd, buffer, 0, buffer.length, Math.max(0, size - OUTPUT_TAIL));
            const text = buffer.toString('utf8').trim();
            return text === '' ? '' : `\nWorker output (last lines):\n${text}`;
        } finally {
            closeSync(fd);
        }
    } catch {
        return '';
    }
}

// A worker's result file: a regular file (never followed through a symlink) of at most 32 MiB holding a JSON object.
// Errors are raised with `fail`, naming the worker.
export function readResultFile(path: string, log: string, worker: string, fail: (message: string) => Error): Record<string, unknown> {
    const missing = (): Error => fail(`The ${worker} worker exited without a result.${logTail(log)}`);
    let regular: boolean;
    try {
        regular = lstatSync(path).isFile();
    } catch {
        throw missing();
    }
    if (!regular) {
        throw fail(`The ${worker} worker's result is not a regular file`);
    }
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW : 0));
    } catch {
        throw missing();
    }
    let data: Buffer;
    try {
        if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_RESULT_BYTES) {
            throw fail(`The ${worker} worker's result exceeds 32 MiB or is not a regular file`);
        }
        data = Buffer.alloc(MAX_RESULT_BYTES + 1);
        let length = 0;
        while (length < data.length) {
            const read = readSync(fd, data, length, data.length - length, null);
            if (read === 0) {
                break;
            }
            length += read;
        }
        if (length > MAX_RESULT_BYTES) {
            throw fail(`The ${worker} worker's result exceeds 32 MiB`);
        }
        data = data.subarray(0, length);
    } finally {
        closeSync(fd);
    }
    let result: unknown;
    try {
        result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
        throw fail(`The ${worker} worker's result is not JSON`);
    }
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw fail(`The ${worker} worker's result is not an object`);
    }
    return result as Record<string, unknown>;
}

// The extraction worker's result: a laranex-schema document with source "declared" that passes the contract's strict
// (producer) validation.
export function readResult(path: string, log: string): ExtractResult['document'] {
    const { ok, error, document } = readResultFile(path, log, 'extraction', (message) => new IsolationError(message));
    if (ok !== true) {
        throw new IsolationError(`Extraction failed in the isolated worker: ${String(error).slice(0, 4000)}${logTail(log)}`);
    }
    let valid: ExtractResult['document'];
    try {
        valid = assertDocument(document, { strict: true });
    } catch (validation) {
        throw new IsolationError(`The extraction worker returned an invalid document: ${(validation as Error).message.slice(0, 2000)}`);
    }
    if (valid.source !== 'declared') {
        throw new IsolationError(`The extraction worker returned a ${JSON.stringify(valid.source)} document; expected "declared"`);
    }
    return valid;
}

export function scratchDirectory(prefix: string): string {
    return real(mkdtempSync(join(tmpdir(), prefix)));
}

async function extractInProcess(request: ExtractRequest, config: IsolationConfig): Promise<ExtractResult> {
    const projectRoot = real(request.projectRoot);
    const extractor = checkExtractor(request.extractor, projectRoot);
    const writes = allowedWrites(projectRoot, config);
    const reads = readRoots(projectRoot, config);
    const scratch = scratchDirectory('lsv-extract-');
    try {
        const home = join(scratch, 'home');
        const tmp = join(scratch, 'tmp');
        const out = join(scratch, 'out');
        for (const directory of [home, tmp, out]) {
            mkdirSync(directory, { mode: 0o700 });
        }
        const { env, withheld } = workerEnvironment(process.env, { passthrough: config.envPassthrough, fixed: config.env, home, tmp });
        const worker = join(dirname(fileURLToPath(import.meta.url)), 'worker.js');
        const result = join(out, 'result.json');
        const log = join(scratch, 'output.log');
        const args = [...permissionFlags([...reads, home, tmp, out], [home, tmp, out, ...writes], config), worker, '--result', result];
        const payload = JSON.stringify({ ...request, projectRoot, extractor });
        const run = await runWorker(process.execPath, args, { cwd: projectRoot, env, input: payload, log, timeoutMs: config.timeout * 1000 });
        if (run.timedOut) {
            throw new IsolationError(`Extraction did not finish within ${config.timeout} seconds; the worker and its process group were stopped`);
        }
        return { document: readResult(result, log), withheld, notices: [] };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

// Used by the container level to report a path without the host's layout.
export function containerPath(path: string, hostRoot: string, mountRoot: string): string {
    return inside(path, hostRoot) ? [mountRoot, ...relative(hostRoot, path).split(sep).filter(Boolean)].join('/') : path;
}
