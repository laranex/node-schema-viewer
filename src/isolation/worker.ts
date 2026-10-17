// The extraction worker: runs under the Permission Model in its own process (or container), imports the requested
// extractor and, through it, application code, and writes the declared document to a result file.
//
// Started as `node --permission ... worker.js --result PATH` with the request on stdin. It never receives database
// credentials (the parent filters its environment) and never opens a connection on purpose. The result goes to a
// file, not stdout, which application code can write to. Only node: built-ins and this directory's modules are
// imported here, so the worker needs no dependency of the package.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXTRACTOR_NAME, EXTRACTORS, type ExtractContext, type Extractor } from './extractor.js';
import { installTypeScriptHooks, typeScriptHooksAvailable } from './typescript.js';

interface Request {
    projectRoot: string;
    extractor: string;
    modules: string[];
    targets: string[];
    options?: Record<string, unknown>;
}

// Taken before application code can replace them. reallyExit leaves without running 'exit' listeners that
// application code registered; process.exit is the fallback where it is missing.
const reallyExit = (process as unknown as { reallyExit?: (code: number) => never }).reallyExit?.bind(process);
const exit = reallyExit ?? ((code: number) => process.exit(code));
const write = writeFileSync;
const stringify = JSON.stringify;

function resultPath(argv: string[]): string {
    const index = argv.indexOf('--result');
    const path = index >= 0 ? argv[index + 1] : undefined;
    if (path === undefined) {
        throw new Error('usage: worker.js --result PATH < request.json');
    }
    return path;
}

async function loadExtractor(name: string): Promise<Extractor> {
    let url: string;
    if (EXTRACTOR_NAME.test(name)) {
        const file = EXTRACTORS[name];
        if (file === undefined) {
            throw new Error(`Unknown extractor ${stringify(name)}`);
        }
        url = new URL(file, import.meta.url).href;
    } else if (isAbsolute(name)) {
        url = pathToFileURL(name).href;
    } else {
        throw new Error(`Unknown extractor ${stringify(name)}`);
    }
    const loaded = (await import(url)) as Partial<Extractor>;
    if (typeof loaded.extract !== 'function') {
        throw new Error(`Extractor ${stringify(name)} does not export extract()`);
    }
    return loaded as Extractor;
}

async function run(request: Request): Promise<unknown> {
    const projectRoot = resolve(request.projectRoot);
    if (typeScriptHooksAvailable()) {
        installTypeScriptHooks(projectRoot);
    }
    const require = createRequire(join(projectRoot, 'package.json'));
    const context: ExtractContext = {
        projectRoot,
        modules: request.modules,
        targets: request.targets,
        options: request.options ?? {},
        async importModule(specifier) {
            const path = /^\.\.?([/\\]|$)/.test(specifier) || isAbsolute(specifier) ? resolve(projectRoot, specifier) : require.resolve(specifier);
            return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
        },
    };
    const extractor = await loadExtractor(request.extractor);
    return await extractor.extract(context);
}

// `worker.js --probe` prints the name and version of the package the worker belongs to, read from its own
// package.json, and the Node.js version, so that a container image can be checked before it runs application code.
function probe(): void {
    let directory = dirname(fileURLToPath(import.meta.url));
    let found: { name?: unknown; version?: unknown } = {};
    for (;;) {
        try {
            found = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as typeof found;
            break;
        } catch {
            const parent = dirname(directory);
            if (parent === directory) {
                break;
            }
            directory = parent;
        }
    }
    process.stdout.write(`${stringify({ name: found.name ?? null, version: found.version ?? null, node: process.versions.node })}\n`);
}

async function main(): Promise<void> {
    if (process.argv.includes('--probe')) {
        probe();
        return;
    }
    const result = resultPath(process.argv.slice(2));
    let outcome: Record<string, unknown>;
    try {
        const request = JSON.parse(readFileSync(0, 'utf8')) as Request;
        outcome = { ok: true, document: await run(request) };
    } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        outcome = { ok: false, error: message.slice(0, 4000) };
    }
    let data: string;
    try {
        data = stringify(outcome);
    } catch (error) {
        data = stringify({ ok: false, error: `The document cannot be serialized: ${String(error)}` });
    }
    write(result, data, { mode: 0o600 });
    exit(0);
}

void main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    exit(1);
});
