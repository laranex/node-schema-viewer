// Project defaults from the "node-schema-viewer" key of the project's package.json. Static JSON only: configuration
// files are never executed, unknown keys are rejected, and database URLs never belong in configuration.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateSeverityOverrides, WILDCARD, type Certainty, type SeverityOverride, type Severity } from 'laranex-schema-viewer-ui/contract';
import { writeAtomically } from './snapshot.js';

export const SECTION = 'node-schema-viewer';
export const DEFAULT_SNAPSHOT = 'schema-viewer.json';
const KEYS = new Set(['output', 'comparisons', 'check']);
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

export interface ProjectConfig {
    // Absolute path, resolved against the project root.
    output: string | null;
    comparisons: ComparisonConfig[];
    check: CheckConfig;
}

export const spellScope = (scope: ScopeConfig): string => (scope.schema === null ? scope.connection : `${scope.connection}:${scope.schema}`);
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
            throw new ConfigError(`${at} compares ${spellScope(baseline)} with itself`);
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
        throw new ConfigError(`A comparison compares two different scopes, not ${spellScope(baseline)} with itself`);
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

export interface Section {
    output?: string;
    comparisons: ComparisonConfig[];
    check: CheckConfig;
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
    return { ...(output === undefined ? {} : { output }), comparisons: comparisonsConfig(comparisons, where), check: checkConfig(check, where) };
}

export function loadConfig(projectRoot: string): ProjectConfig {
    const found = readPackageJson(projectRoot);
    if (found === null || !(SECTION in found.data)) {
        return { output: null, comparisons: [], check: { severity: null, certainty: null } };
    }
    const section = validateSection(found.data[SECTION], `${found.path} "${SECTION}"`);
    return { output: section.output === undefined ? null : resolve(projectRoot, section.output), comparisons: section.comparisons, check: section.check };
}

// Explicit path, else the configured output, else schema-viewer.json in the project root.
export function resolveSnapshot(snapshot: string | undefined, projectRoot: string): string {
    if (snapshot !== undefined) {
        return resolve(snapshot);
    }
    return loadConfig(projectRoot).output ?? resolve(projectRoot, DEFAULT_SNAPSHOT);
}

// Add the key to an existing package.json, keeping every other property, their order, the indentation and the final
// newline. Refuses to replace an existing key.
export function addConfig(projectRoot: string, output: string = DEFAULT_SNAPSHOT): string {
    validateSection({ output });
    const section = { output };
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
