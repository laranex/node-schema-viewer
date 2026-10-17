// Container isolation: the extraction worker runs in Docker or Podman with no network, a read-only root filesystem and
// project mount, all capabilities dropped, no new privileges and limited processes and memory. The Permission Model
// flags of the process level apply inside as well. A missing runtime, a missing image or an image with another
// version of this package stops the build. Images are never pulled unless pullImage opts in.
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
const DIGEST = /@sha256:[0-9a-f]{64}$/;
// Where the package is, resolved from the image's working directory when containerPackagePath is not set.
const LOCATE = "process.stdout.write(require('path').dirname(require.resolve('laranex-schema-viewer/package.json')))";

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

// Every run, the probes included, uses --pull never unless pullImage opts in to pulling a missing image.
export function baseArguments(config: IsolationConfig): string[] {
    const args = ['run', '--rm', '--pull', config.pullImage ? 'missing' : 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', config.containerMemory, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m'];
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
        args.push('--user', `${process.getuid()}:${process.getgid()}`);
    }
    return args;
}

// A pull is only reproducible for a digest-pinned reference.
export function pullNotice(image: string, config: IsolationConfig): string | null {
    return config.pullImage && !DIGEST.test(image)
        ? `pullImage is enabled for ${image}, which is not pinned by digest; the runtime may pull a different image than the one you tested. ` +
              'Prefer a digest-pinned reference (image@sha256:...).'
        : null;
}

function ensureImage(runtime: string, image: string, config: IsolationConfig): void {
    const inspect = spawnSync(runtime, ['image', 'inspect', image], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
    if (inspect.status !== 0 && !config.pullImage) {
        throw new IsolationError(
            `Image ${image} is not available locally, and pulling is disabled. Build it (${runtime} build -t ${image} .) or pull it ` +
                `yourself (${runtime} pull ${image}, ideally by digest), or set pullImage to let the build pull it.`,
        );
    }
}

export interface ImageProbe {
    name: unknown;
    version: unknown;
    node: unknown;
}

// Refuses an image whose worker entry point did not answer, whose Node.js is too old for the Permission Model flags,
// or whose package is not laranex-schema-viewer at exactly the host's version.
export function checkImage(image: string, probe: ImageProbe | null, detail = ''): void {
    if (probe === null) {
        throw new IsolationError(
            `The isolated worker entry point in image ${image} is missing or does not run${detail === '' ? '' : `: ${detail.trim().slice(-300)}`}`,
        );
    }
    const [major = 0, minor = 0] = String(probe.node).split('.').map(Number);
    if (major < (MIN_NODE[0] ?? 0) || (major === MIN_NODE[0] && minor < (MIN_NODE[1] ?? 0))) {
        throw new IsolationError(`Image ${image} has Node.js ${String(probe.node)}; container isolation needs Node.js 22.13 or later in the image`);
    }
    if (probe.name !== 'laranex-schema-viewer' || probe.version !== VERSION) {
        throw new IsolationError(
            `Image ${image} must have laranex-schema-viewer ${VERSION} (found: ${typeof probe.name === 'string' ? probe.name : 'nothing'}` +
                `${typeof probe.version === 'string' ? ` ${probe.version}` : ''})`,
        );
    }
}

function packageDirectory(runtime: string, image: string, config: IsolationConfig): string {
    if (config.containerPackagePath !== null) {
        if (!posix.isAbsolute(config.containerPackagePath)) {
            throw new IsolationError('containerPackagePath must be an absolute path inside the image');
        }
        return posix.normalize(config.containerPackagePath);
    }
    const located = spawnSync(runtime, [...baseArguments(config), image, 'node', '-e', LOCATE], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    const path = located.status === 0 ? located.stdout.trim() : '';
    if (!posix.isAbsolute(path)) {
        throw new IsolationError(
            `Cannot find laranex-schema-viewer from the working directory of image ${image}; install it there (npm install --prefix) ` +
                `or set containerPackagePath${located.stderr ? `: ${located.stderr.trim().slice(-300)}` : ''}`,
        );
    }
    return path;
}

// Runs the worker entry point itself, under the Permission Model, with --probe.
function probeImage(runtime: string, image: string, packageDir: string, config: IsolationConfig): void {
    const entry = posix.join(packageDir, 'dist', 'isolation', 'worker.js');
    const probe = spawnSync(runtime, [...baseArguments(config), image, 'node', '--permission', `--allow-fs-read=${packageDir}`, entry, '--probe'], {
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
    });
    let parsed: ImageProbe | null;
    try {
        parsed = probe.status === 0 ? (JSON.parse(probe.stdout.trim().split('\n').pop() ?? '') as ImageProbe) : null;
    } catch {
        parsed = null;
    }
    checkImage(image, parsed, probe.stderr);
}

export async function extractInContainer(request: ExtractRequest, config: IsolationConfig): Promise<ExtractResult> {
    const image = config.containerImage;
    if (image === null || image === '') {
        throw new IsolationError(
            `Container isolation needs containerImage: an image with Node.js and laranex-schema-viewer ${VERSION} installed`,
        );
    }
    const runtime = containerRuntime(config);
    ensureImage(runtime, image, config);
    const notice = pullNotice(image, config);
    const packageDir = packageDirectory(runtime, image, config);
    probeImage(runtime, image, packageDir, config);
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
        return { document: readResult(join(output, 'result.json'), log), withheld, notices: notice === null ? [] : [notice] };
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}
