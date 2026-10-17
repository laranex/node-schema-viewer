// Container isolation: the extraction worker runs in Docker or Podman with no network, a read-only root filesystem and
// project mount, all capabilities dropped, no new privileges and limited processes and memory. The Permission Model
// flags of the process level apply inside as well. A missing runtime, a missing image or an image with another
// version of this package stops the build.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { VERSION } from '../version.js';
import { workerEnvironment } from './env.js';
import { IsolationError, type ExtractRequest, type ExtractResult, type IsolationConfig } from './index.js';
import { allowedWrites, checkExtractor, containerPath, permissionFlags, readResult, runWorker, scratchDirectory, workspaceRoot } from './runner.js';

const MOUNT = '/project';
const MIN_NODE = [22, 13];

// Prints what the image provides: its Node.js version and where (and which version of) this package is installed,
// found through the laranex-schema-viewer executable on PATH.
const PROBE = `
const fs = require('fs'), path = require('path');
let root = null, version = null;
for (const dir of (process.env.PATH || '').split(':')) {
    try { root = path.dirname(path.dirname(fs.realpathSync(path.join(dir, 'laranex-schema-viewer')))); break; } catch {}
}
try { const data = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); if (data.name === 'laranex-schema-viewer') version = data.version; } catch {}
console.log(JSON.stringify({ node: process.versions.node, root, version }));
`;

export function containerRuntime(config: IsolationConfig): string {
    const candidates = config.containerRuntime !== null ? [config.containerRuntime] : ['docker', 'podman'];
    for (const name of candidates) {
        const probe = spawnSync(name, ['info'], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
        if (probe.error === undefined && probe.status === 0) {
            return name;
        }
    }
    throw new IsolationError(
        `Container isolation needs a running ${candidates.join(' or ')}; none is available. The build stops instead of running with weaker isolation.`,
    );
}

export function baseArguments(config: IsolationConfig): string[] {
    const args = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '256', '--memory', config.containerMemory, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m'];
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
        args.push('--user', `${process.getuid()}:${process.getgid()}`);
    }
    return args;
}

export interface ImageProbe {
    node: string;
    root: string | null;
    version: string | null;
}

// Refuses an image whose Node.js is too old for the Permission Model flags, or whose laranex-schema-viewer is
// missing or another version.
export function checkImage(image: string, probe: ImageProbe | null, detail = ''): string {
    if (probe === null) {
        throw new IsolationError(`Cannot run image ${image} to check it${detail === '' ? '' : `: ${detail.slice(-300)}`}`);
    }
    const [major = 0, minor = 0] = probe.node.split('.').map(Number);
    if (major < (MIN_NODE[0] ?? 0) || (major === MIN_NODE[0] && minor < (MIN_NODE[1] ?? 0))) {
        throw new IsolationError(`Image ${image} has Node.js ${probe.node}; container isolation needs Node.js 22.13 or later in the image`);
    }
    if (probe.root === null || probe.version !== VERSION) {
        throw new IsolationError(
            `Image ${image} must have laranex-schema-viewer ${VERSION} installed globally (found: ${probe.version ?? 'nothing'})`,
        );
    }
    return probe.root;
}

function probeImage(runtime: string, image: string, config: IsolationConfig): string {
    const probe = spawnSync(runtime, [...baseArguments(config), image, 'node', '-e', PROBE], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    let parsed: ImageProbe | null;
    try {
        parsed = probe.status === 0 ? (JSON.parse(probe.stdout.trim().split('\n').pop() ?? '') as ImageProbe) : null;
    } catch {
        parsed = null;
    }
    return checkImage(image, parsed, probe.stderr);
}

export async function extractInContainer(request: ExtractRequest, config: IsolationConfig): Promise<ExtractResult> {
    const image = config.containerImage;
    if (image === null || image === '') {
        throw new IsolationError(
            `Container isolation needs containerImage: an image with the project's runtime and laranex-schema-viewer ${VERSION} installed`,
        );
    }
    const runtime = containerRuntime(config);
    const packageDir = probeImage(runtime, image, config);
    const projectRoot = realpathSync.native(request.projectRoot);
    // A workspace package is mounted with its workspace, so that linked packages and hoisted dependencies resolve.
    const tree = workspaceRoot(projectRoot) ?? projectRoot;
    const map = (path: string): string => containerPath(path, tree, MOUNT);
    const extractor = checkExtractor(request.extractor, projectRoot);
    const writes = allowedWrites(projectRoot, config).map(map);
    // Extra read directories outside the mounted tree keep their host path, so absolute symlinks into them resolve.
    const extras = config.allowReads.map((entry) => {
        const path = resolve(projectRoot, entry);
        if (!existsSync(path)) {
            throw new IsolationError(`allowReads entry ${JSON.stringify(entry)} does not exist`);
        }
        return realpathSync.native(path);
    });
    const mounts = extras.filter((path) => map(path) === path);
    if (mounts.length > 0 && process.platform === 'win32') {
        throw new IsolationError('allowReads outside the project cannot be mounted into a container on Windows');
    }
    const out = scratchDirectory('lsv-container-');
    const name = `lsv-extract-${randomBytes(6).toString('hex')}`;
    try {
        const output = join(out, 'out');
        mkdirSync(output, { mode: 0o700 });
        const { env, withheld } = workerEnvironment(process.env, {
            passthrough: config.envPassthrough,
            fixed: config.env,
            home: '/tmp',
            tmp: '/tmp',
            // The host's PATH means nothing inside the image.
            keepPath: false,
        });
        const reads = [MOUNT, packageDir, posix.dirname(packageDir), ...extras.map(map), '/tmp', '/out'];
        const flags = permissionFlags(reads, ['/tmp', '/out', ...writes], config);
        const args = [
            ...baseArguments(config),
            '--name', name, '-i',
            '-v', `${tree}:${MOUNT}:ro`,
            ...mounts.flatMap((path) => ['-v', `${path}:${path}:ro`]),
            '-v', `${output}:/out:rw`,
            '-w', map(projectRoot),
            ...Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
            image,
            'node', ...flags, posix.join(packageDir, 'dist', 'isolation', 'worker.js'), '--result', '/out/result.json',
        ];
        const payload = JSON.stringify({ ...request, projectRoot: map(projectRoot), extractor: map(extractor), modules: request.modules.map((m) => map(m)) });
        const log = join(out, 'output.log');
        const run = await runWorker(runtime, args, {
            cwd: projectRoot,
            env: { ...process.env } as Record<string, string>,
            input: payload,
            log,
            timeoutMs: config.timeout * 1000,
            onTimeout: () => {
                spawnSync(runtime, ['kill', name], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
            },
        });
        if (run.timedOut) {
            spawnSync(runtime, ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
            throw new IsolationError(`Extraction did not finish within ${config.timeout} seconds; the container was stopped and removed`);
        }
        return { document: readResult(join(output, 'result.json'), log), withheld };
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}
