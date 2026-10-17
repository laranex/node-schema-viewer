// Project defaults from the "node-schema-viewer" key of the project's package.json. Static JSON only: configuration
// files are never executed, unknown keys are rejected, and database URLs never belong in configuration.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomically } from './snapshot.js';

export const SECTION = 'node-schema-viewer';
export const DEFAULT_SNAPSHOT = 'schema-viewer.json';
const KEYS = new Set(['output']);
const URL_KEYS = /^(?:url|database_?url|databaseUrl|connection_?url|connectionUrl|dsn)$/i;
const URL_VALUE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;

export class ConfigError extends Error {
    override name = 'ConfigError';
}

export interface ProjectConfig {
    // Absolute path, resolved against the project root.
    output: string | null;
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

export function validateSection(section: unknown, where = `package.json "${SECTION}"`): { output?: string } {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
        throw new ConfigError(`${where} must be an object`);
    }
    rejectUrls(section, where);
    const unknown = Object.keys(section).filter((key) => !KEYS.has(key)).sort();
    if (unknown.length) {
        throw new ConfigError(`Unknown ${where} keys: ${unknown.join(', ')}`);
    }
    const output = (section as Record<string, unknown>).output;
    if (output !== undefined && (typeof output !== 'string' || output === '')) {
        throw new ConfigError(`${where} output must be a non-empty string path`);
    }
    return output === undefined ? {} : { output };
}

export function loadConfig(projectRoot: string): ProjectConfig {
    const found = readPackageJson(projectRoot);
    if (found === null || !(SECTION in found.data)) {
        return { output: null };
    }
    const section = validateSection(found.data[SECTION], `${found.path} "${SECTION}"`);
    return { output: section.output === undefined ? null : resolve(projectRoot, section.output) };
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
    const section = validateSection({ output });
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
