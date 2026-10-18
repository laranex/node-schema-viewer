// Project defaults from the "node-schema-viewer" key of the project's package.json. Static JSON only: configuration
// files are never executed, unknown keys are rejected, and database URLs never belong in configuration.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spellScope, validateSeverityOverrides, WILDCARD, type Certainty, type SeverityOverride, type Severity } from 'laranex-schema-viewer-ui/contract';
import { EXTRACTORS } from './isolation/extractor.js';
import { writeAtomically } from './snapshot.js';

export const SECTION = 'node-schema-viewer';
export const DEFAULT_SNAPSHOT = 'schema-viewer.json';
// The build's sources: declared (ORM metadata), database (live catalogs), combined (both, reconciled).
export const SOURCES = ['declared', 'database', 'combined'] as const;
export const ISOLATION_LEVELS = ['process', 'container'] as const;
export const DRIVERS = ['postgresql', 'mysql', 'mariadb', 'sqlite'] as const;
export const CASINGS = ['snake_case', 'camelCase'] as const;
// The registered ORM adapters (src/isolation/extractor.ts) and the npm package each one reads.
export const ORMS: Readonly<Record<string, string>> = { drizzle: 'drizzle-orm' };
const BUILD_KEYS = [
    'source', 'orm', 'modules', 'databaseUrlEnv', 'databaseSchemas', 'databaseConnection', 'databases', 'isolation', 'timeout',
    'envPassthrough', 'env', 'allowWrites', 'allowReads', 'allowCodeGeneration', 'containerImage', 'containerRuntime', 'containerMemory',
    'containerPackagePath', 'pullImage', 'drizzle',
];
const SINGLE_DATABASE_KEYS = ['databaseUrlEnv', 'databaseSchemas', 'databaseConnection'];
const KEYS = new Set(['output', 'comparisons', 'check', ...BUILD_KEYS]);
// An environment variable name, as python-schema-viewer's ENV_NAME.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Characters that make a modules entry a glob pattern.
export const GLOB = /[*?]/;
const URL_KEYS = /^(?:url|database_?url|databaseUrl|connection_?url|connectionUrl|dsn)$/i;
const URL_VALUE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;

// Differences listed per comparison; the rest are counted as omitted. Keeps a document with many tenant comparisons
// well inside the 32 MiB snapshot limit.
export const DEFAULT_COMPARISON_LIMIT = 500;
export const SEVERITIES = ['error', 'warning', 'info'] as const;
export const CERTAINTIES = ['certain', 'likely'] as const;
// Python's [A-Za-z0-9_][\w.-]*, whose \w also matches Unicode letters and digits.
const CONNECTION_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
export const COMPARISON_FORMAT = 'A comparison is BASELINE=TARGET, each scope a connection name, optionally with :SCHEMA (the target\'s schema may be *)';

export class ConfigError extends Error {
    override name = 'ConfigError';
}

// A comparison side: a connection by name and a schema, null for the unqualified scope, or "*" (targets only) for
// every schema the connection's inspection read.
export interface ScopeConfig {
    connection: string;
    schema: string | null;
}

export interface ComparisonConfig {
    baseline: ScopeConfig;
    target: ScopeConfig;
    limit: number;
    // A severity for (objectType, change), or for one field of a changed difference; field null for a general one.
    overrides: SeverityOverride[];
}

// The thresholds a finding must meet to fail check; null for the shared default.
export interface CheckConfig {
    severity: Severity | null;
    certainty: Certainty | null;
}

// One named database connection: its driver, the schema modules that declare its tables, the variable holding its URL
// (never the URL itself) and the schemas to inspect.
export interface DatabaseConfig {
    name: string;
    urlEnv: string | null;
    schemas: string[];
    driver: (typeof DRIVERS)[number] | null;
    modules: string[];
}

// What build reads; null and empty for what the configuration leaves to options and defaults.
export interface BuildConfig {
    source: (typeof SOURCES)[number] | null;
    orm: string | null;
    modules: string[];
    databaseUrlEnv: string | null;
    databaseSchemas: string[];
    databaseConnection: string | null;
    // By name, in name order.
    databases: DatabaseConfig[];
    isolation: (typeof ISOLATION_LEVELS)[number] | null;
    timeout: number | null;
    envPassthrough: string[];
    env: Record<string, string>;
    allowWrites: string[];
    allowReads: string[];
    allowCodeGeneration: boolean;
    containerImage: string | null;
    containerRuntime: string | null;
    containerMemory: string | null;
    containerPackagePath: string | null;
    pullImage: boolean;
    casing: (typeof CASINGS)[number] | null;
}

export interface ProjectConfig {
    // Absolute path, resolved against the project root.
    output: string | null;
    comparisons: ComparisonConfig[];
    check: CheckConfig;
    build: BuildConfig;
}

export const EMPTY_BUILD: BuildConfig = {
    source: null, orm: null, modules: [], databaseUrlEnv: null, databaseSchemas: [], databaseConnection: null, databases: [], isolation: null,
    timeout: null, envPassthrough: [], env: {}, allowWrites: [], allowReads: [], allowCodeGeneration: false, containerImage: null,
    containerRuntime: null, containerMemory: null, containerPackagePath: null, pullImage: false, casing: null,
};

const sameScope = (a: ScopeConfig, b: ScopeConfig): boolean => a.connection === b.connection && a.schema === b.schema;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value);

function unknownKeys(value: Record<string, unknown>, known: readonly string[], where: string): void {
    const unknown = Object.keys(value).filter((key) => !known.includes(key)).sort();
    if (unknown.length) {
        throw new ConfigError(`Unknown ${where} keys: ${unknown.join(', ')}`);
    }
}

function scopeConfig(value: unknown, where: string, wildcard: boolean): ScopeConfig {
    if (!isObject(value)) {
        throw new ConfigError(`${where} must be an object: { "connection": "NAME", "schema": "SCHEMA" }`);
    }
    unknownKeys(value, ['connection', 'schema'], where);
    const { connection, schema = null } = value;
    if (typeof connection !== 'string' || !CONNECTION_NAME.test(connection)) {
        throw new ConfigError(`${where} needs connection, a connection name`);
    }
    if (schema !== null && (typeof schema !== 'string' || schema === '' || schema.includes('@') || schema.includes('//'))) {
        throw new ConfigError(`${where} schema must be a schema name (never a URL)`);
    }
    if (schema === WILDCARD && !wildcard) {
        throw new ConfigError(`${where} schema cannot be "*"; only a target expands to every inspected schema`);
    }
    return { connection, schema };
}

// Checked with the shared validateSeverityOverrides; its messages are kept and prefixed with the comparison's location.
function overridesConfig(value: unknown, at: string): SeverityOverride[] {
    const errors = validateSeverityOverrides(value);
    if (errors.length) {
        throw new ConfigError(errors.map((error) => `${at} ${error}`).join('; '));
    }
    return (value as SeverityOverride[]).map(({ objectType, change, field = null, severity }) => ({ objectType, change, field, severity }));
}

function comparisonsConfig(value: unknown, where: string): ComparisonConfig[] {
    if (!Array.isArray(value) || !value.every(isObject)) {
        throw new ConfigError(`${where} comparisons must be an array of objects`);
    }
    return value.map((entry, n) => {
        const at = `${where} comparisons[${n}]`;
        unknownKeys(entry, ['baseline', 'target', 'limit', 'overrides'], at);
        const baseline = scopeConfig(entry.baseline, `${at} baseline`, false);
        const target = scopeConfig(entry.target, `${at} target`, true);
        if (sameScope(baseline, target)) {
            throw new ConfigError(`${at} compares ${spellScope(baseline.connection, baseline.schema)} with itself`);
        }
        const { limit = DEFAULT_COMPARISON_LIMIT, overrides = [] } = entry;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
            throw new ConfigError(`${at} limit must be a nonnegative integer`);
        }
        return { baseline, target, limit, overrides: overridesConfig(overrides, at) };
    });
}

function checkConfig(value: unknown, where: string): CheckConfig {
    const at = `${where} check`;
    if (!isObject(value)) {
        throw new ConfigError(`${at} must be an object`);
    }
    unknownKeys(value, ['severity', 'certainty'], at);
    const { severity = null, certainty = null } = value;
    if (severity !== null && !oneOf(severity, SEVERITIES)) {
        throw new ConfigError(`${at} severity must be one of ${SEVERITIES.join(', ')}`);
    }
    if (certainty !== null && !oneOf(certainty, CERTAINTIES)) {
        throw new ConfigError(`${at} certainty must be one of ${CERTAINTIES.join(', ')}`);
    }
    return { severity, certainty };
}

// BASELINE=TARGET from the command line, each scope CONNECTION or CONNECTION:SCHEMA; the target schema may be "*".
// Never echoes the value: a URL passed by mistake would end up in the error output.
export function comparisonOption(value: string, limit: number = DEFAULT_COMPARISON_LIMIT): ComparisonConfig {
    const separator = value.indexOf('=');
    if (separator < 0) {
        throw new ConfigError(COMPARISON_FORMAT);
    }
    const baseline = scopeOption(value.slice(0, separator), false);
    const target = scopeOption(value.slice(separator + 1), true);
    if (sameScope(baseline, target)) {
        throw new ConfigError(`A comparison compares two different scopes, not ${spellScope(baseline.connection, baseline.schema)} with itself`);
    }
    return { baseline, target, limit, overrides: [] };
}

function scopeOption(text: string, wildcard: boolean): ScopeConfig {
    const separator = text.indexOf(':');
    const connection = separator < 0 ? text : text.slice(0, separator);
    const schema = separator < 0 ? '' : text.slice(separator + 1);
    if (!CONNECTION_NAME.test(connection) || (separator >= 0 && schema === '')) {
        throw new ConfigError(COMPARISON_FORMAT);
    }
    if (schema.includes('@') || schema.includes('//')) {
        throw new ConfigError(`${COMPARISON_FORMAT}; database URLs are never accepted as arguments`);
    }
    if (schema === WILDCARD && !wildcard) {
        throw new ConfigError('Only a comparison target\'s schema can be "*"');
    }
    return { connection, schema: separator < 0 ? null : schema };
}

function readPackageJson(projectRoot: string): { path: string; text: string; data: Record<string, unknown> } | null {
    const path = join(projectRoot, 'package.json');
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw new ConfigError(`Cannot read ${path}: ${(error as Error).message}`);
    }
    if (Buffer.byteLength(text) > MAX_PACKAGE_JSON_BYTES) {
        throw new ConfigError(`${path} is larger than 4 MiB`);
    }
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new ConfigError(`${path} must contain a JSON object`);
    }
    return { path, text, data: data as Record<string, unknown> };
}

// Never echo a value that looks like a URL: it could carry credentials.
function rejectUrls(value: unknown, where: string): void {
    if (typeof value === 'string' && URL_VALUE.test(value)) {
        throw new ConfigError(`${where} must not contain a URL; database URLs are never read from configuration`);
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => {
            rejectUrls(item, `${where}[${i}]`);
        });
    } else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
            if (URL_KEYS.test(key)) {
                throw new ConfigError(`${where} must not contain a database URL (${key}); database URLs are never read from configuration`);
            }
            rejectUrls(item, `${where}.${key}`);
        }
    }
}

function stringList(value: unknown, at: string, nonEmpty = false): string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && (!nonEmpty || item !== ''))) {
        throw new ConfigError(`${at} must be a list of ${nonEmpty ? 'non-empty ' : ''}strings`);
    }
    return value as string[];
}

function optionalString(value: unknown, at: string): string | null {
    if (value === undefined) {
        return null;
    }
    if (typeof value !== 'string' || value === '') {
        throw new ConfigError(`${at} must be a non-empty string`);
    }
    return value;
}

function choiceOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T | null {
    if (value === undefined) {
        return null;
    }
    if (!oneOf(value, allowed)) {
        throw new ConfigError(`${at} must be one of ${allowed.join(', ')}`);
    }
    return value;
}

function flag(value: unknown, at: string): boolean {
    if (value !== undefined && typeof value !== 'boolean') {
        throw new ConfigError(`${at} must be true or false`);
    }
    return value === true;
}

function envName(value: unknown, at: string): string {
    if (typeof value !== 'string' || !ENV_NAME.test(value)) {
        throw new ConfigError(`${at} must be the name of the environment variable holding the URL (letters, digits and _), never the URL`);
    }
    return value;
}

// Schema modules: paths or glob patterns relative to the project root, or package names; never outside the project.
export function moduleEntries(value: unknown, at: string): string[] {
    const entries = stringList(value, at, true);
    entries.forEach((entry, i) => {
        if (isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.replace(/\\/g, '/').split('/').includes('..')) {
            throw new ConfigError(`${at}[${String(i)}] must be a path or glob pattern relative to the project root, or a package name`);
        }
    });
    return entries;
}

function databasesConfig(value: unknown, where: string): DatabaseConfig[] {
    const at = `${where} databases`;
    if (!isObject(value) || !Object.values(value).every(isObject)) {
        throw new ConfigError(`${at} must be an object with one object per connection, such as { "default": { "urlEnv": "DATABASE_URL" } }`);
    }
    return Object.keys(value)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((name) => {
            const entry = value[name] as Record<string, unknown>;
            const here = `${at}.${name}`;
            if (!CONNECTION_NAME.test(name)) {
                throw new ConfigError(`${at}: connection names use letters, digits, '_', '.' and '-'`);
            }
            unknownKeys(entry, ['urlEnv', 'schemas', 'driver', 'modules'], here);
            return {
                name,
                urlEnv: entry.urlEnv === undefined ? null : envName(entry.urlEnv, `${here} urlEnv`),
                schemas: entry.schemas === undefined ? [] : stringList(entry.schemas, `${here} schemas`, true),
                driver: choiceOf(entry.driver, DRIVERS, `${here} driver`),
                modules: entry.modules === undefined ? [] : moduleEntries(entry.modules, `${here} modules`),
            };
        });
}

function buildConfig(section: Record<string, unknown>, where: string): BuildConfig {
    const at = (key: string): string => `${where} ${key}`;
    const orms = Object.keys(EXTRACTORS);
    const databases = section.databases === undefined ? [] : databasesConfig(section.databases, where);
    const single = SINGLE_DATABASE_KEYS.filter((key) => key in section);
    if (databases.length > 0 && single.length > 0) {
        throw new ConfigError(`${where} sets both databases and ${single.join(', ')}; configure every connection under databases`);
    }
    if (section.modules !== undefined && databases.some((d) => d.modules.length > 0)) {
        throw new ConfigError(`${where} sets modules both at the top level and per databases entry; list each connection's modules under databases`);
    }
    const listed = databases.flatMap((d) => d.modules);
    if (new Set(listed).size !== listed.length) {
        throw new ConfigError(`${where} databases list a module under more than one connection`);
    }
    const timeout = section.timeout;
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
        throw new ConfigError(`${at('timeout')} must be a positive number of seconds`);
    }
    const env = section.env ?? {};
    if (!isObject(env) || !Object.values(env).every((v) => typeof v === 'string')) {
        throw new ConfigError(`${at('env')} must be an object of string values`);
    }
    const drizzle = section.drizzle ?? {};
    if (!isObject(drizzle)) {
        throw new ConfigError(`${at('drizzle')} must be an object`);
    }
    unknownKeys(drizzle, ['casing'], at('drizzle'));
    return {
        source: choiceOf(section.source, SOURCES, at('source')),
        orm: choiceOf(section.orm, orms, at('orm')),
        modules: section.modules === undefined ? [] : moduleEntries(section.modules, at('modules')),
        databaseUrlEnv: section.databaseUrlEnv === undefined ? null : envName(section.databaseUrlEnv, at('databaseUrlEnv')),
        databaseSchemas: section.databaseSchemas === undefined ? [] : stringList(section.databaseSchemas, at('databaseSchemas'), true),
        databaseConnection: section.databaseConnection === undefined ? null : connectionName(section.databaseConnection, at('databaseConnection')),
        databases,
        isolation: choiceOf(section.isolation, ISOLATION_LEVELS, at('isolation')),
        timeout: timeout === undefined ? null : timeout,
        envPassthrough: section.envPassthrough === undefined ? [] : stringList(section.envPassthrough, at('envPassthrough'), true),
        env: env as Record<string, string>,
        allowWrites: section.allowWrites === undefined ? [] : stringList(section.allowWrites, at('allowWrites'), true),
        allowReads: section.allowReads === undefined ? [] : stringList(section.allowReads, at('allowReads'), true),
        allowCodeGeneration: flag(section.allowCodeGeneration, at('allowCodeGeneration')),
        containerImage: optionalString(section.containerImage, at('containerImage')),
        containerRuntime: optionalString(section.containerRuntime, at('containerRuntime')),
        containerMemory: optionalString(section.containerMemory, at('containerMemory')),
        containerPackagePath: optionalString(section.containerPackagePath, at('containerPackagePath')),
        pullImage: flag(section.pullImage, at('pullImage')),
        casing: choiceOf(drizzle.casing, CASINGS, `${at('drizzle')} casing`),
    };
}

function connectionName(value: unknown, at: string): string {
    if (typeof value !== 'string' || !CONNECTION_NAME.test(value)) {
        throw new ConfigError(`${at} must be a connection name (letters, digits, '_', '.' and '-')`);
    }
    return value;
}

export interface Section {
    output?: string;
    comparisons: ComparisonConfig[];
    check: CheckConfig;
    build: BuildConfig;
}

export function validateSection(section: unknown, where = `package.json "${SECTION}"`): Section {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
        throw new ConfigError(`${where} must be an object`);
    }
    rejectUrls(section, where);
    const unknown = Object.keys(section).filter((key) => !KEYS.has(key)).sort();
    if (unknown.length) {
        throw new ConfigError(`Unknown ${where} keys: ${unknown.join(', ')}`);
    }
    const { output, comparisons = [], check = {} } = section as Record<string, unknown>;
    if (output !== undefined && (typeof output !== 'string' || output === '')) {
        throw new ConfigError(`${where} output must be a non-empty string path`);
    }
    return {
        ...(output === undefined ? {} : { output }),
        comparisons: comparisonsConfig(comparisons, where),
        check: checkConfig(check, where),
        build: buildConfig(section as Record<string, unknown>, where),
    };
}

export function loadConfig(projectRoot: string): ProjectConfig {
    const found = readPackageJson(projectRoot);
    if (found === null || !(SECTION in found.data)) {
        return { output: null, comparisons: [], check: { severity: null, certainty: null }, build: EMPTY_BUILD };
    }
    const section = validateSection(found.data[SECTION], `${found.path} "${SECTION}"`);
    return {
        output: section.output === undefined ? null : resolve(projectRoot, section.output),
        comparisons: section.comparisons,
        check: section.check,
        build: section.build,
    };
}

// Explicit path, else the configured output, else schema-viewer.json in the project root.
export function resolveSnapshot(snapshot: string | undefined, projectRoot: string): string {
    if (snapshot !== undefined) {
        return resolve(snapshot);
    }
    return loadConfig(projectRoot).output ?? resolve(projectRoot, DEFAULT_SNAPSHOT);
}

// Add the key to an existing package.json with the build defaults given (orm, schema modules) and the output, keeping
// every other property, their order, the indentation and the final newline. Refuses to replace an existing key.
export function addConfig(projectRoot: string, output: string = DEFAULT_SNAPSHOT, defaults: { orm?: string | undefined; modules?: string[] } = {}): string {
    const section = {
        ...(defaults.orm === undefined ? {} : { orm: defaults.orm }),
        ...(defaults.modules === undefined || defaults.modules.length === 0 ? {} : { modules: defaults.modules }),
        output,
    };
    validateSection(section);
    const found = readPackageJson(projectRoot);
    if (found === null) {
        throw new ConfigError(`No package.json in ${resolve(projectRoot)}; run npm init first`);
    }
    if (SECTION in found.data) {
        throw new ConfigError(`${found.path} already contains "${SECTION}"`);
    }
    const indent = /^[{[]\r?\n([ \t]+)\S/.exec(found.text)?.[1] ?? '  ';
    const newline = found.text.includes('\r\n') ? '\r\n' : '\n';
    let text = JSON.stringify({ ...found.data, [SECTION]: section }, null, indent);
    if (newline !== '\n') {
        text = text.replaceAll('\n', newline);
    }
    if (/\r?\n$/.test(found.text)) {
        text += newline;
    }
    writeAtomically(Buffer.from(text, 'utf8'), found.path, MAX_PACKAGE_JSON_BYTES);
    loadConfig(projectRoot);
    return found.path;
}
