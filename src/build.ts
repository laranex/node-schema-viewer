// The build: declared metadata extracted by an ORM adapter in the isolated extraction worker, or the live catalogs read
// by the introspection worker (one per connection), written atomically as one strictly valid laranex-schema 2.0
// document. A port of python-schema-viewer's cli.run_build. Database URLs are read here, in the parent, from the
// environment variables the configuration names, and travel only to the introspection worker, on stdin; the
// extraction worker never receives them. Combined builds (reconciliation) come in a later milestone.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { storeComparisons, type SchemaDocument } from 'laranex-schema-viewer-ui/contract';
import { CompareError, compute } from './compare.js';
import {
    comparisonOption,
    ConfigError,
    DEFAULT_COMPARISON_LIMIT,
    DEFAULT_SNAPSHOT,
    GLOB,
    loadConfig,
    moduleEntries,
    ORMS,
    type BuildConfig,
    type ComparisonConfig,
    type DatabaseConfig,
    type ISOLATION_LEVELS,
    type SOURCES,
} from './config.js';
import { checkOutputPath } from './gitignore.js';
import { writeDocument } from './snapshot.js';

export const DATABASE_URL_ENV = 'LARANEX_SCHEMA_DATABASE_URL';
// Python's IsolationConfig.timeout.
const DEFAULT_TIMEOUT = 120;
const CONNECTION_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Never searched by a glob: dependencies and hidden directories.
const SKIPPED = new Set(['node_modules']);

// A build that cannot run as asked (exit 2), such as a source that is not available yet.
export class BuildUsageError extends Error {
    override name = 'BuildUsageError';
}

export interface BuildOptions {
    projectRoot: string;
    modules: string[];
    orm?: string;
    output?: string;
    isolation?: (typeof ISOLATION_LEVELS)[number];
    timeout?: number;
    containerImage?: string;
    source?: (typeof SOURCES)[number];
    databaseUrlEnv?: string;
    schemas: string[];
    databaseConnection?: string;
    // NAME=ENV_VAR
    databases: string[];
    allowWritePrivileges: boolean;
    // BASELINE=TARGET
    compare: string[];
    compareLimit?: number;
}

export interface BuildReport {
    document: SchemaDocument;
    output: string;
}

type Log = (line: string) => void;

// `--database NAME=ENV_VAR` as (name, variable). Never echoes the value: a URL passed by mistake would end up in the
// error output.
export function databaseOption(value: string): [string, string] {
    const separator = value.indexOf('=');
    const name = value.slice(0, separator);
    const urlEnv = value.slice(separator + 1);
    if (separator < 0 || !CONNECTION_NAME.test(name) || !ENV_NAME.test(urlEnv)) {
        throw new ConfigError('--database takes NAME=ENV_VAR: the connection name and the environment variable holding its URL; URLs are never accepted as arguments');
    }
    return [name, urlEnv];
}

// The named connections to inspect, or [] for the single-database options. Never both.
function databaseConnections(options: BuildOptions, config: BuildConfig): DatabaseConfig[] {
    const single = ([['--database-url-env', options.databaseUrlEnv], ['--schema', options.schemas.length > 0], ['--database-connection', options.databaseConnection]] as const)
        .filter(([, value]) => value !== undefined && value !== false)
        .map(([option]) => option);
    const singleConfig = ([['databaseUrlEnv', config.databaseUrlEnv], ['databaseSchemas', config.databaseSchemas.length > 0 || null], ['databaseConnection', config.databaseConnection]] as const)
        .filter(([, value]) => value !== null)
        .map(([key]) => key);
    if (options.databases.length > 0 && single.length > 0) {
        throw new ConfigError(`--database cannot be combined with ${single.join(', ')}; give each connection as NAME=ENV_VAR and its schemas under databases.NAME in package.json`);
    }
    if (options.databases.length > 0 && singleConfig.length > 0) {
        throw new ConfigError(`--database cannot be combined with ${singleConfig.join(', ')} in package.json; configure the connections under databases.NAME`);
    }
    // An entry without urlEnv only declares a connection's schema modules.
    const configured = config.databases.filter((d) => d.urlEnv !== null);
    if (configured.length > 0 && single.length > 0) {
        throw new ConfigError(`${single.join(', ')} cannot be combined with databases in package.json; select connections with --database NAME=ENV_VAR`);
    }
    if (options.databases.length === 0) {
        return configured;
    }
    const selected = new Map<string, DatabaseConfig>();
    for (const value of options.databases) {
        const [name, urlEnv] = databaseOption(value);
        if (selected.has(name)) {
            throw new ConfigError(`--database names connection ${name} more than once`);
        }
        const known = config.databases.find((d) => d.name === name);
        selected.set(name, { name, urlEnv, schemas: known?.schemas ?? [], driver: known?.driver ?? null, modules: known?.modules ?? [] });
    }
    return [...selected.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

// Comparisons named on the command line (with the limit), or else the configured ones.
function comparisonSpecs(options: BuildOptions, configured: ComparisonConfig[]): ComparisonConfig[] {
    if (options.compareLimit !== undefined && options.compareLimit < 0) {
        throw new ConfigError('The comparison limit must be a nonnegative integer');
    }
    if (options.compare.length === 0) {
        if (options.compareLimit !== undefined) {
            throw new ConfigError('A comparison limit applies to comparisons named on the command line; configure limit per comparisons entry of "node-schema-viewer" in package.json');
        }
        return configured;
    }
    return options.compare.map((value) => comparisonOption(value, options.compareLimit ?? DEFAULT_COMPARISON_LIMIT));
}

function readJson(path: string): Record<string, unknown> | null {
    try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

// The ORM the project depends on, from its package.json alone: nothing is imported to find it.
function detectOrm(projectRoot: string, log: Log): string {
    const manifest = readJson(join(projectRoot, 'package.json')) ?? {};
    const declared = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((key) => {
        const value = manifest[key];
        return typeof value === 'object' && value !== null ? Object.keys(value) : [];
    }));
    const found = Object.entries(ORMS).filter(([, pkg]) => declared.has(pkg));
    const names = Object.keys(ORMS).join(', ');
    if (found.length > 1) {
        throw new ConfigError(`The project depends on several ORMs (${found.map(([orm]) => orm).join(', ')}); choose one with --orm or orm in package.json`);
    }
    const [only] = found;
    if (only === undefined) {
        throw new ConfigError(`No supported ORM (${names}) is a dependency in package.json; choose one with --orm or orm in package.json`);
    }
    log(`Detected ORM ${only[0]} (${only[1]} in package.json)`);
    return only[0];
}

function inside(path: string, root: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function posixRelative(path: string, root: string): string {
    return `./${relative(root, path).split(sep).join('/')}`;
}

function globPattern(pattern: string): RegExp {
    let source = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const c = pattern[i] ?? '';
        if (c === '*' && pattern[i + 1] === '*') {
            const slash = pattern[i + 2] === '/';
            source += slash ? '(?:[^/]*/)*' : '.*';
            i += slash ? 2 : 1;
        } else if (c === '*') {
            source += '[^/]*';
        } else if (c === '?') {
            source += '[^/]';
        } else {
            source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

// The project files a glob pattern matches (`*`, `**` and `?`), without following symlinked directories and outside
// node_modules and hidden directories, in code point order.
function expandGlob(projectRoot: string, pattern: string): string[] {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalized.split('/');
    const fixed = segments.slice(0, segments.findIndex((s) => GLOB.test(s)));
    const start = resolve(projectRoot, ...fixed);
    const matcher = globPattern(normalized);
    const found: string[] = [];
    const walk = (directory: string): void => {
        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) {
                    walk(path);
                }
            } else if (entry.isFile() && matcher.test(relative(projectRoot, path).split(sep).join('/'))) {
                found.push(posixRelative(path, projectRoot));
            }
        }
    };
    walk(start);
    return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Each entry as the worker imports it: a project file as ./relative/path, a glob as the files it matches, or a
// package name the project resolves (only its package.json files are read here; nothing is imported).
export function resolveModules(projectRoot: string, entries: readonly string[], where: string): string[] {
    const require = createRequire(join(projectRoot, 'package.json'));
    const resolved: string[] = [];
    for (const entry of entries) {
        if (GLOB.test(entry)) {
            const matches = expandGlob(projectRoot, entry);
            if (matches.length === 0) {
                throw new ConfigError(`${where}: the glob pattern ${entry} matches no file in the project`);
            }
            resolved.push(...matches);
            continue;
        }
        const path = resolve(projectRoot, entry);
        let file = false;
        try {
            file = statSync(path).isFile();
        } catch {
            // Not a project file; perhaps a package.
        }
        if (file && inside(path, projectRoot)) {
            resolved.push(posixRelative(path, projectRoot));
            continue;
        }
        try {
            require.resolve(entry);
        } catch {
            throw new ConfigError(`${where}: ${entry} is neither a file in the project nor a package the project resolves`);
        }
        resolved.push(entry);
    }
    return [...new Set(resolved)];
}

function tables(document: SchemaDocument): number {
    return document.connections.reduce((n, c) => n + c.tables.length, 0);
}

function url(variable: string, connection: string | null): string {
    const value = process.env[variable];
    if (value === undefined || value === '') {
        throw new ConfigError(
            connection === null
                ? `Set ${variable} to a read-only database URL (see docs/database.md); URLs are never read from arguments or configuration`
                : `Set ${variable} to a read-only database URL for connection ${connection} (see docs/database.md); URLs are never read from arguments or configuration`,
        );
    }
    return value;
}

export async function build(options: BuildOptions, log: Log, warn: Log): Promise<BuildReport> {
    const projectRoot = resolve(options.projectRoot);
    const project = loadConfig(projectRoot);
    const config = project.build;
    const source = options.source ?? config.source ?? 'declared';
    if (source === 'combined') {
        throw new BuildUsageError('--source combined is not available yet in node-schema-viewer: build with --source declared or --source database');
    }
    const output = options.output ?? project.output ?? DEFAULT_SNAPSHOT;
    checkOutputPath(output, warn);
    const timeout = options.timeout ?? config.timeout ?? DEFAULT_TIMEOUT;
    const databases = databaseConnections(options, config);
    const comparisons = comparisonSpecs(options, project.comparisons);
    if (options.compare.length > 0 && source === 'declared') {
        throw new ConfigError('--compare compares inspected databases; build with --source database, or run `node-schema-viewer compare` on a saved document');
    }
    const urlEnv = options.databaseUrlEnv ?? config.databaseUrlEnv ?? DATABASE_URL_ENV;
    const inspected = source === 'database' ? databases : [];
    for (const variable of databases.length > 0 ? databases.map((d) => d.urlEnv ?? '') : [urlEnv]) {
        if (config.envPassthrough.includes(variable) || variable in config.env) {
            throw new ConfigError(`${variable} holds a database URL and must not be passed to the extraction worker`);
        }
    }
    const urls = new Map<string, string>();
    let single: string | null = null;
    if (source === 'database') {
        for (const database of inspected) {
            urls.set(database.name, url(database.urlEnv ?? '', database.name));
        }
        if (inspected.length === 0) {
            single = url(urlEnv, null);
        }
    }

    let document: SchemaDocument;
    if (source === 'declared') {
        document = await declared(options, config, projectRoot, timeout, log, warn);
    } else {
        const { introspect, introspectAll } = await import('./introspection/index.js');
        if (inspected.length > 0) {
            document = await introspectAll(inspected.map((d) => ({
                url: urls.get(d.name) ?? '',
                schemas: d.schemas,
                connection: d.name,
                allowWritePrivileges: options.allowWritePrivileges,
                timeout,
            })));
            for (const connection of document.connections) {
                log(`Inspected connection ${connection.name} read-only (${String(connection.driver)})`);
            }
        } else {
            document = await introspect({
                url: single ?? '',
                schemas: options.schemas.length > 0 ? options.schemas : config.databaseSchemas,
                connection: options.databaseConnection ?? config.databaseConnection ?? 'default',
                allowWritePrivileges: options.allowWritePrivileges,
                timeout,
            });
            log(`Inspected the database read-only (${String(document.connections[0]?.driver)})`);
        }
    }
    if (comparisons.length > 0 && source === 'declared') {
        log(`Skipped ${String(comparisons.length)} configured comparisons: they compare inspected databases (--source database)`);
    } else if (comparisons.length > 0) {
        const { comparisons: computed, errors } = compute(document, comparisons);
        if (errors.length > 0) {
            throw new CompareError(errors.map((e) => e.message).join('\n'));
        }
        document = storeComparisons(document, computed);
        const incomplete = document.comparisons.filter((c) => !c.complete).length;
        log(`Compared ${String(document.comparisons.length)} scope pairs${incomplete > 0 ? ` (${String(incomplete)} incomplete)` : ''}`);
    }
    writeDocument(document, output);
    const counts = new Map<string, number>();
    for (const d of document.diagnostics) {
        counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
    }
    const summary = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([category, n]) => `${String(n)} ${category}`).join(', ') || 'no';
    log(
        `Saved laranex-schema 2.0 (${document.source}): ${String(tables(document))} tables, ${String(document.models.length)} models, ` +
            `${String(document.relationships.length)} ORM relationships, ${summary} diagnostics, to ${output}`,
    );
    return { document, output };
}

// The declared connections: --module for one connection (default), else the configured modules (default), else the
// modules of each databases entry under its name.
function declaredConnections(options: BuildOptions, config: BuildConfig, projectRoot: string): { name: string; driver: string | null; modules: string[] }[] {
    if (options.modules.length > 0) {
        return [{ name: 'default', driver: null, modules: resolveModules(projectRoot, moduleEntries(options.modules, '--module'), '--module') }];
    }
    if (config.modules.length > 0) {
        return [{ name: 'default', driver: null, modules: resolveModules(projectRoot, config.modules, 'package.json "node-schema-viewer" modules') }];
    }
    const connections = config.databases
        .filter((d) => d.modules.length > 0)
        .map((d) => ({ name: d.name, driver: d.driver, modules: resolveModules(projectRoot, d.modules, `package.json "node-schema-viewer" databases.${d.name} modules`) }));
    if (connections.length === 0) {
        throw new ConfigError('Supply at least one --module, or set modules in "node-schema-viewer" of package.json (or modules per databases entry)');
    }
    const all = connections.flatMap((c) => c.modules);
    if (new Set(all).size !== all.length) {
        throw new ConfigError('A schema module belongs to more than one connection; list each module under one databases entry');
    }
    return connections;
}

async function declared(options: BuildOptions, config: BuildConfig, projectRoot: string, timeout: number, log: Log, warn: Log): Promise<SchemaDocument> {
    const orm = options.orm ?? config.orm ?? detectOrm(projectRoot, log);
    if (!(orm in ORMS)) {
        throw new ConfigError(`Unsupported ORM ${JSON.stringify(orm)}; choose one of ${Object.keys(ORMS).join(', ')}`);
    }
    const connections = declaredConnections(options, config, projectRoot);
    const { extract } = await import('./isolation/index.js');
    const level = options.isolation ?? config.isolation ?? 'process';
    const result = await extract(
        {
            projectRoot,
            extractor: orm,
            modules: connections.flatMap((c) => c.modules),
            targets: [],
            options: { connections, casing: config.casing },
        },
        {
            level,
            timeout,
            envPassthrough: config.envPassthrough,
            env: config.env,
            allowWrites: config.allowWrites,
            allowReads: config.allowReads,
            allowCodeGeneration: config.allowCodeGeneration,
            containerImage: options.containerImage ?? config.containerImage,
            containerRuntime: config.containerRuntime,
            ...(config.containerMemory === null ? {} : { containerMemory: config.containerMemory }),
            containerPackagePath: config.containerPackagePath,
            pullImage: config.pullImage,
        },
    );
    log(`Extracted with ${level} isolation; ${String(result.withheld)} environment variables withheld`);
    for (const notice of result.notices) {
        warn(`Notice: ${notice}`);
    }
    return result.document;
}
