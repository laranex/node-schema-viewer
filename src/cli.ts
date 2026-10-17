#!/usr/bin/env node
// Command line entry point. Commands import their modules lazily, so serve never loads the MCP SDK and mcp never
// loads the HTTP server. In mcp mode stdout carries only the protocol.
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { VERSION } from './version.js';

const USAGE = `Usage: node-schema-viewer <command> [options]

Commands:
  init [--output PATH] [--project-root DIR]
                     Add "node-schema-viewer" defaults to the project's package.json
  serve [--snapshot PATH] [--host HOST] [--port PORT]
                     Serve the viewer from a saved laranex-schema document (default 127.0.0.1:8765)
  mcp [--snapshot PATH]
                     Run read-only MCP tools over stdio for a saved laranex-schema document
  build              Not available yet

Options:
  --help, -h         Show this help
  --version, -v      Show the version

The snapshot defaults to the configured output, else schema-viewer.json in the current directory.
`;

class UsageError extends Error {}

function parse(args: string[], options: ParseArgsConfig['options']): Record<string, string | boolean | undefined> {
    try {
        const { values, positionals } = parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: true });
        if (positionals.length) {
            throw new UsageError(`Unexpected argument: ${positionals[0] ?? ''}`);
        }
        return values;
    } catch (error) {
        throw error instanceof UsageError ? error : new UsageError((error as Error).message);
    }
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
    const values = parse(args, { snapshot: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' } });
    if (values.help) {
        process.stdout.write(USAGE);
        return;
    }
    const { resolveSnapshot } = await import('./config.js');
    const { createViewerServer, displayUrl } = await import('./server.js');
    const host = (values.host as string | undefined) ?? '127.0.0.1';
    const listenPort = port(values.port as string | undefined);
    const server = createViewerServer({ snapshot: resolveSnapshot(values.snapshot as string | undefined, process.cwd()), host });
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
    const stop = () => {
        server.close();
        server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
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
    const values = parse(args, { output: { type: 'string' }, 'project-root': { type: 'string' } });
    if (values.help) {
        process.stdout.write(USAGE);
        return;
    }
    const { addConfig, DEFAULT_SNAPSHOT } = await import('./config.js');
    const path = addConfig((values['project-root'] as string | undefined) ?? process.cwd(), (values.output as string | undefined) ?? DEFAULT_SNAPSHOT);
    process.stdout.write(`Added "node-schema-viewer" to ${path}\n`);
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
            case 'build':
                process.stderr.write('Error: build is not available yet in node-schema-viewer for Node.js; serve and mcp read a saved laranex-schema document\n');
                return 1;
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
