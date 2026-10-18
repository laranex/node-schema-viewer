#!/usr/bin/env node
// Command line entry point. Commands import their modules lazily, so serve never loads the MCP SDK and mcp never
// loads the HTTP server. In mcp mode stdout carries only the protocol.
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { GateThresholds } from 'laranex-schema-viewer-ui/contract';
import { VERSION } from './version.js';

const USAGE = `Usage: node-schema-viewer <command> [options]

Commands:
  init [--output PATH] [--orm NAME] [--module PATH...] [--project-root DIR]
                     Add "node-schema-viewer" defaults to the project's package.json
  build [--source declared|database] [--project-root DIR] [--module PATH...] [--orm NAME] [--output PATH]
        [--isolation process|container] [--timeout SECONDS] [--container-image IMAGE]
        [--database-url-env NAME] [--schema NAME...] [--database-connection NAME] [--database NAME=ENV_VAR...]
        [--allow-write-privileges] [--compare BASELINE=TARGET...] [--compare-limit N]
                     Save the schema as a laranex-schema 2.0 document: declared (ORM schema modules, imported
                     only in the isolated extraction worker) or database (live catalogs, read-only); database
                     URLs are read from the named environment variables only
  serve [--snapshot PATH] [--host HOST] [--port PORT] [--unsafe-allow-remote]
                     Serve the viewer from a saved laranex-schema document (default 127.0.0.1:8765). Only
                     loopback hosts unless --unsafe-allow-remote: no authentication, no TLS
  mcp [--snapshot PATH]
                     Run read-only MCP tools over stdio for a saved laranex-schema document
  compare [BASELINE=TARGET...] [--snapshot PATH] [--limit N] [--json] [--write]
                     Compare scopes of a saved document, without a database; each scope is CONNECTION or
                     CONNECTION:SCHEMA (target schema * for every inspected schema); default: the configured
                     comparisons. --write stores them in the document
  check [BASELINE=TARGET...] [--snapshot PATH] [--severity error|warning|info] [--certainty certain|likely]
        [--limit N] [--json] [--output FILE]
                     Schema drift gate for CI: exit 0 passed, 1 a finding meets the thresholds, 2 the check could
                     not be completed (invalid document or arguments, a requested comparison not found, an
                     incomplete comparison or inspection)

Options:
  --help, -h         Show this help
  --version, -v      Show the version

The snapshot defaults to the configured output, else schema-viewer.json in the current directory.
`;

class UsageError extends Error {}

type Values = Record<string, string | boolean | undefined>;

function parseWithPositionals(args: string[], options: ParseArgsConfig['options']): { values: Values; positionals: string[] } {
    try {
        return parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: true });
    } catch (error) {
        throw new UsageError((error as Error).message);
    }
}

function parse(args: string[], options: ParseArgsConfig['options']): Values {
    const { values, positionals } = parseWithPositionals(args, options);
    if (positionals.length) {
        throw new UsageError(`Unexpected argument: ${positionals[0] ?? ''}`);
    }
    return values;
}

// An integer as Python's int() reads a command-line value; nonnegativity is checked where the limit is used.
function integer(value: string | undefined, option: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!/^\s*[+-]?\d+\s*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new UsageError(`${option} must be an integer`);
    }
    return Number(value);
}

function choice<T extends string>(value: string | undefined, option: string, allowed: readonly T[]): T | undefined {
    if (value !== undefined && !(allowed as readonly string[]).includes(value)) {
        throw new UsageError(`${option} must be one of ${allowed.join(', ')}`);
    }
    return value as T | undefined;
}

function port(value: string | undefined): number {
    if (value === undefined) {
        return 8765;
    }
    const number = Number(value);
    if (!/^\d+$/.test(value) || number > 65535) {
        throw new UsageError(`--port must be an integer from 0 to 65535`);
    }
    return number;
}

async function serve(args: string[]): Promise<void> {
    const values = parse(args, {
        snapshot: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        'unsafe-allow-remote': { type: 'boolean' },
    });
    if (values.help) {
        process.stdout.write(USAGE);
        return;
    }
    const { resolveSnapshot } = await import('./config.js');
    const { createViewerServer, displayUrl, isLoopbackHost } = await import('./server.js');
    const host = (values.host as string | undefined) ?? '127.0.0.1';
    const listenPort = port(values.port as string | undefined);
    const remote = !isLoopbackHost(host);
    if (remote && !values['unsafe-allow-remote']) {
        throw new UsageError(
            `--host ${host} is not a loopback address (127.0.0.0/8, ::1, localhost). The viewer has no authentication and no TLS: ` +
                'keep it on loopback behind an authenticated HTTPS reverse proxy or tunnel, or pass --unsafe-allow-remote to bind it anyway',
        );
    }
    const server = createViewerServer({ snapshot: resolveSnapshot(values.snapshot as string | undefined, process.cwd()), host });
    if (remote) {
        process.stderr.write(
            `Warning: --unsafe-allow-remote: serving on ${host}, which is not loopback, with no authentication and no TLS. ` +
                'Anyone who can reach this address can read the schema; Host checking is not access control. ' +
                'Use an authenticated HTTPS reverse proxy with the server on loopback instead.\n',
        );
    }
    // Registered before listening: the kernel accepts connections once the socket listens, so a client may stop the
    // server right after the ready line, before this process runs again.
    const stop = () => {
        server.close();
        server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : 0;
    process.stdout.write(`Laranex Schema Viewer: ${displayUrl(host, bound)}\n`);
}

async function mcp(args: string[]): Promise<void> {
    // Anything a dependency logs must not corrupt the JSON-RPC stream on stdout.
    const toStderr = (...data: unknown[]) => {
        console.error(...data);
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
    const values = parse(args, { snapshot: { type: 'string' } });
    if (values.help) {
        process.stderr.write(USAGE);
        return;
    }
    const { resolveSnapshot } = await import('./config.js');
    const { runStdio } = await import('./mcp.js');
    runStdio(resolveSnapshot(values.snapshot as string | undefined, process.cwd()));
}

async function init(args: string[]): Promise<void> {
    const { values } = parseWithPositionals(args, { output: { type: 'string' }, 'project-root': { type: 'string' }, orm: { type: 'string' }, module: { type: 'string', multiple: true } });
    if (values.help) {
        process.stdout.write(USAGE);
        return;
    }
    const { addConfig, DEFAULT_SNAPSHOT } = await import('./config.js');
    const path = addConfig((values['project-root'] as string | undefined) ?? process.cwd(), (values.output as string | undefined) ?? DEFAULT_SNAPSHOT, {
        orm: values.orm as string | undefined,
        modules: (values.module as string[] | undefined) ?? [],
    });
    process.stdout.write(`Added "node-schema-viewer" to ${path}. Next: node-schema-viewer build\n`);
}

function positive(value: string | undefined, option: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const number = Number(value);
    if (!/^\s*\d+(\.\d+)?\s*$/.test(value) || !(number > 0)) {
        throw new UsageError(`${option} must be a positive number of seconds`);
    }
    return number;
}

// Extract declared metadata in the isolated worker, or inspect the database in its own worker.
async function build(args: string[]): Promise<number> {
    const { values, positionals } = parseWithPositionals(args, {
        'project-root': { type: 'string' },
        module: { type: 'string', multiple: true },
        orm: { type: 'string' },
        output: { type: 'string' },
        isolation: { type: 'string' },
        timeout: { type: 'string' },
        'container-image': { type: 'string' },
        source: { type: 'string' },
        'database-url-env': { type: 'string' },
        schema: { type: 'string', multiple: true },
        'database-connection': { type: 'string' },
        database: { type: 'string', multiple: true },
        'allow-write-privileges': { type: 'boolean' },
        compare: { type: 'string', multiple: true },
        'compare-limit': { type: 'string' },
    });
    if (values.help) {
        process.stdout.write(USAGE);
        return 0;
    }
    if (positionals.length) {
        throw new UsageError(`Unexpected argument: ${positionals[0] ?? ''}`);
    }
    const { ISOLATION_LEVELS, SOURCES } = await import('./config.js');
    const { build: run, BuildUsageError } = await import('./build.js');
    const option = (name: string): string | undefined => values[name] as string | undefined;
    const list = (name: string): string[] => (values[name] as string[] | undefined) ?? [];
    const isolation = choice(option('isolation'), '--isolation', ISOLATION_LEVELS);
    const source = choice(option('source'), '--source', SOURCES);
    const timeout = positive(option('timeout'), '--timeout');
    const compareLimit = integer(option('compare-limit'), '--compare-limit');
    const options: import('./build.js').BuildOptions = {
        projectRoot: option('project-root') ?? process.cwd(),
        modules: list('module'),
        schemas: list('schema'),
        databases: list('database'),
        compare: list('compare'),
        allowWritePrivileges: values['allow-write-privileges'] === true,
    };
    const optional = {
        orm: option('orm'),
        output: option('output'),
        isolation,
        timeout,
        containerImage: option('container-image'),
        source,
        databaseUrlEnv: option('database-url-env'),
        databaseConnection: option('database-connection'),
        compareLimit,
    };
    for (const [key, value] of Object.entries(optional)) {
        if (value !== undefined) {
            Object.assign(options, { [key]: value });
        }
    }
    try {
        await run(
            options,
            (line) => process.stdout.write(`${line}\n`),
            (line) => process.stderr.write(`${line}\n`),
        );
    } catch (error) {
        if (error instanceof BuildUsageError) {
            process.stderr.write(`Error: ${error.message}\n`);
            return 2;
        }
        throw error;
    }
    return 0;
}

// Comparisons named on the command line (with limit), or else the configured ones.
async function comparisonSpecs(options: string[], limit: number | undefined, configured: import('./config.js').ComparisonConfig[]) {
    const { comparisonOption, ConfigError, DEFAULT_COMPARISON_LIMIT } = await import('./config.js');
    if (limit !== undefined && limit < 0) {
        throw new ConfigError('The comparison limit must be a nonnegative integer');
    }
    if (!options.length) {
        if (limit !== undefined) {
            throw new ConfigError(
                'A comparison limit applies to comparisons named on the command line; configure limit per comparisons entry of "node-schema-viewer" in package.json',
            );
        }
        return configured;
    }
    return options.map((option) => comparisonOption(option, limit ?? DEFAULT_COMPARISON_LIMIT));
}

// Compare scopes of a saved document. Reads only the document (and package.json): no database, no imports.
async function compare(args: string[]): Promise<void> {
    const { values, positionals } = parseWithPositionals(args, { snapshot: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' }, write: { type: 'boolean' } });
    if (values.help) {
        process.stdout.write(USAGE);
        return;
    }
    const limit = integer(values.limit as string | undefined, '--limit');
    const { DEFAULT_SNAPSHOT, loadConfig } = await import('./config.js');
    const { CompareError, compute, describe } = await import('./compare.js');
    const { canonicalJson, storeComparisons, VERSION } = await import('laranex-schema-viewer-ui/contract');
    const { loadDocument, writeDocument } = await import('./snapshot.js');
    const config = loadConfig(process.cwd());
    const specs = await comparisonSpecs(positionals, limit, config.comparisons);
    if (!specs.length) {
        throw new Error('Name comparisons as BASELINE=TARGET, or configure comparisons under "node-schema-viewer" in package.json');
    }
    // As given, like python-schema-viewer prints it: the explicit path, else the configured (absolute) output.
    const path = (values.snapshot as string | undefined) ?? config.output ?? DEFAULT_SNAPSHOT;
    const document = loadDocument(path);
    if (values.write && document.version !== VERSION) {
        throw new Error(`${path} is laranex-schema ${document.version}; --write rewrites only ${VERSION} documents, so nothing a newer version added is lost`);
    }
    // Every request the shared expansion cannot resolve is a configuration error, and then nothing is compared.
    const { comparisons, errors } = compute(document, specs);
    if (errors.length) {
        throw new CompareError(errors.map((e) => e.message).join('\n'));
    }
    process.stdout.write(values.json ? canonicalJson(comparisons) : `${describe(document, comparisons)}\n`);
    if (values.write) {
        writeDocument(storeComparisons(document, comparisons), path);
        (values.json ? process.stderr : process.stdout).write(`Stored ${String(comparisons.length)} comparisons in ${path}\n`);
    }
}

// The drift gate. Returns its exit code: 0 passed, 1 qualifying findings, 2 for anything that kept the check from
// completing, including invalid arguments, configuration and documents. Never 0 or 1 on a failure.
async function check(args: string[]): Promise<number> {
    try {
        const { values, positionals } = parseWithPositionals(args, {
            snapshot: { type: 'string' },
            severity: { type: 'string' },
            certainty: { type: 'string' },
            limit: { type: 'string' },
            json: { type: 'boolean' },
            output: { type: 'string' },
        });
        if (values.help) {
            process.stdout.write(USAGE);
            return 0;
        }
        const { CERTAINTIES, loadConfig, resolveSnapshot, SEVERITIES } = await import('./config.js');
        const severity = choice(values.severity as string | undefined, '--severity', SEVERITIES);
        const certainty = choice(values.certainty as string | undefined, '--certainty', CERTAINTIES);
        const limit = integer(values.limit as string | undefined, '--limit');
        const { run, summary } = await import('./check.js');
        const { canonicalJson } = await import('laranex-schema-viewer-ui/contract');
        const { writeAtomically } = await import('./snapshot.js');
        const config = loadConfig(process.cwd());
        // Flags over configuration; the gate supplies the shared defaults for what neither sets.
        const thresholds: Partial<GateThresholds> = {};
        const chosenSeverity = severity ?? config.check.severity;
        const chosenCertainty = certainty ?? config.check.certainty;
        if (chosenSeverity !== null) {
            thresholds.severity = chosenSeverity;
        }
        if (chosenCertainty !== null) {
            thresholds.certainty = chosenCertainty;
        }
        if (limit !== undefined && !positionals.length) {
            throw new Error('--limit applies to comparisons named on the command line');
        }
        const adHoc = positionals.length ? await comparisonSpecs(positionals, limit, []) : [];
        const paths = await import('node:path');
        // Relative to the working directory when inside it: the path appears in notes on stderr.
        let path = resolveSnapshot(values.snapshot as string | undefined, process.cwd());
        const inside = paths.relative(process.cwd(), path);
        if (inside && !inside.startsWith('..') && !paths.isAbsolute(inside)) {
            path = inside;
        }
        const { report, notes } = run(path, thresholds, config.comparisons, adHoc);
        const text = canonicalJson(report);
        if (values.output !== undefined) {
            writeAtomically(Buffer.from(text, 'utf8'), values.output as string);
        }
        for (const note of notes) {
            process.stderr.write(`${note}\n`);
        }
        process.stdout.write(values.json ? text : `${summary(report)}\n`);
        return report.exitCode;
    } catch (error) {
        process.stderr.write(error instanceof UsageError ? `Error: ${error.message}\n\n${USAGE}` : `Error: ${(error as Error).message || String(error)}\n`);
        return 2;
    }
}

async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    try {
        switch (command) {
            case 'init':
                await init(rest);
                break;
            case 'serve':
                await serve(rest);
                break;
            case 'mcp':
                await mcp(rest);
                break;
            case 'compare':
                await compare(rest);
                break;
            case 'check':
                return await check(rest);
            case 'build':
                return await build(rest);
            case '--version':
            case '-v':
                process.stdout.write(`${VERSION}\n`);
                break;
            case '--help':
            case '-h':
                process.stdout.write(USAGE);
                break;
            case undefined:
                process.stderr.write(USAGE);
                return 2;
            default:
                throw new UsageError(`Unknown command: ${command}`);
        }
    } catch (error) {
        if (error instanceof UsageError) {
            process.stderr.write(`Error: ${error.message}\n\n${USAGE}`);
            return 2;
        }
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        return 1;
    }
    return 0;
}

const code = await main(process.argv.slice(2));
if (code !== 0) {
    process.exitCode = code;
}
