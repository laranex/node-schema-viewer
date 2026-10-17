// Isolated model extraction. Building a declared schema means importing application code, and importing a module runs
// it, so the build runs that code in a separate extraction worker:
//
// - process: a separate Node.js process under the Permission Model (--permission) with an allowlisted environment,
//   private HOME and TMPDIR, read access to the project and its dependencies only, write access to scratch
//   directories only, a timeout and process-group cleanup. Best-effort: the Permission Model is not a security
//   boundary (Node.js documentation), and it blocks network access only from Node.js 26.
// - container: Docker or Podman with no network, a read-only root and project mount, all capabilities dropped and no
//   new privileges, with the same Permission Model flags applied inside.
//
// A level that cannot be established stops the build; nothing falls back to a weaker level. See docs/security.md.
export const LEVELS = ['process', 'container'] as const;
export type Level = (typeof LEVELS)[number];

// The lowest Node.js major whose Permission Model also blocks network access; process isolation needs it.
export const PROCESS_MIN_NODE_MAJOR = 26;

export class IsolationError extends Error {
    override name = 'IsolationError';
}

export interface IsolationConfig {
    level: Level;
    // Seconds.
    timeout: number;
    // Environment variables the worker may see beyond the built-in allowlist. Credential-like names are refused.
    envPassthrough: readonly string[];
    // Fixed values for the worker, such as a placeholder secret that a configuration module requires at import time.
    env: Readonly<Record<string, string>>;
    // Directories inside the project that application code may write to (process level; read-only in a container).
    allowWrites: readonly string[];
    // Extra directories the worker may read, such as packages linked from outside the project or workspace.
    allowReads: readonly string[];
    containerImage: string | null;
    // docker or podman; by default docker, then podman.
    containerRuntime: string | null;
    containerMemory: string;
    // Where this package is installed inside the image (absolute path of its directory). By default it is resolved
    // from the image's working directory, as `require.resolve('laranex-schema-viewer/package.json')` would.
    containerPackagePath: string | null;
    // Opt-in: let the container runtime pull a missing image. Off by default: every run uses --pull never.
    pullImage: boolean;
    // Opt-out: let application code use eval and new Function (blocked by default).
    allowCodeGeneration: boolean;
}

export const DEFAULT_ISOLATION: IsolationConfig = {
    level: 'process',
    timeout: 120,
    envPassthrough: [],
    env: {},
    allowWrites: [],
    allowReads: [],
    containerImage: null,
    containerRuntime: null,
    containerMemory: '1g',
    containerPackagePath: null,
    pullImage: false,
    allowCodeGeneration: false,
};

export interface ExtractRequest {
    // Absolute path of the project (the worker's working directory).
    projectRoot: string;
    // A registered extractor name (an ORM adapter), or, for tests and adapters under development, the absolute path
    // of a module inside the project that exports extract().
    extractor: string;
    // Module specifiers to import: relative to the project root, or package names resolved from it.
    modules: readonly string[];
    // Extractor-specific targets, such as exported DataSource names.
    targets: readonly string[];
    options?: Record<string, unknown>;
}

export interface ExtractResult {
    // A laranex-schema 1.x document with source "declared", strictly validated.
    document: import('laranex-schema-viewer-ui/contract').SchemaDocument;
    // How many of the parent's environment variables the worker did not get; names and values are never reported.
    withheld: number;
    // Advice for the user about how the extraction ran, such as a pull of an image not pinned by digest.
    notices: string[];
}

export function isolationConfig(overrides: Partial<IsolationConfig> = {}): IsolationConfig {
    const config = { ...DEFAULT_ISOLATION, ...overrides };
    if (!(LEVELS as readonly string[]).includes(config.level)) {
        throw new IsolationError(`Unknown isolation level ${JSON.stringify(config.level)}; choose process or container`);
    }
    if (!Number.isFinite(config.timeout) || config.timeout <= 0) {
        throw new IsolationError('timeout must be a positive number of seconds');
    }
    return config;
}

// The approved policy: process isolation only where the Permission Model also blocks the network (Node.js 26+);
// on 22 and 24 the build needs container isolation. Never downgraded silently.
export function checkPolicy(level: Level, nodeVersion: string = process.versions.node): void {
    const major = Number(nodeVersion.split('.')[0]);
    if (level === 'process' && !(major >= PROCESS_MIN_NODE_MAJOR)) {
        throw new IsolationError(
            `Process isolation needs Node.js ${PROCESS_MIN_NODE_MAJOR} or later (this is ${nodeVersion}): on earlier versions ` +
                "the Permission Model does not block network access. Use container isolation (isolation 'container' with a " +
                'containerImage), or run the build on Node.js 26+. The build does not run with weaker isolation.',
        );
    }
}

export { extract } from './runner.js';
