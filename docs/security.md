# Build security

Building a declared schema means importing your models, and importing a module runs its code. Laranex Schema Viewer for Node.js runs that code in a separate **extraction worker** and limits what reaches it. This page separates what is guaranteed from what is only best-effort. Keep the two apart when deciding where to run a build.

`serve` and `mcp` read a saved snapshot only. They never import application code or connect to a database, need no isolation, and keep working on Node.js 22.13+ without Docker.

> The `build` command is not available yet. The isolation layer described here (`src/isolation/`) is in place and tested, so that the ORM adapters can be added on top of it.

## Threat model

The imported code is your application: entities, schema files, data source and configuration modules, and everything they import, including decorators and ORM hooks. Usually it is trusted but careless: an import that opens a database connection, runs migrations, writes a log file, calls a service or reads `DATABASE_URL`. Sometimes it is a dependency or a pull request nobody has reviewed.

The build protects:

- databases, which must not receive connections, DDL, DML or queries from the extraction step;
- credentials, which must not reach application code;
- the project and the machine, which should not change because a schema was extracted;
- the network, which should not be reached during extraction.

## Isolation levels and Node.js versions

| Node.js running the build | `process` | `container` |
| --- | --- | --- |
| 22.13+, 24 | **Refused** with an error | Yes (required) |
| 26+ | Yes (default; best-effort, **not a security sandbox**) | Yes |

On Node.js 22 and 24 the Permission Model does not restrict the network, so process isolation would let application code reach your databases and services. The build refuses it there and names container isolation as the way forward. Nothing ever falls back to a weaker level: a missing Docker or Podman, a missing image, or an image with a different version of this package stops the build.

**Use `container` for untrusted or security-sensitive projects**, in CI, and for code you have not reviewed. `process` suits your own code on a developer machine.

| | `process` (Node.js 26+) | `container` |
| --- | --- | --- |
| Separate process, timeout, cleanup | Yes; the worker's process group is killed | Yes; the container is killed and removed |
| Environment | Allowlist only | Allowlist only |
| Network | Blocked by the Permission Model | None (`--network none`), plus the Permission Model inside |
| Child processes, worker threads, native addons, WASI, inspector | Blocked by the Permission Model | Blocked by the Permission Model |
| Reading files | The project, its workspace, `node_modules`, this package, `allowReads` | Only what is mounted: the project (read-only) and the image |
| Writing files | Private scratch directories and `allowWrites` inside the project | `/tmp` (128 MB tmpfs) and a disposable output directory; the project and root filesystem are read-only |
| `node:sqlite` | Disabled (`--no-experimental-sqlite`) | Disabled |
| `eval`, `new Function` | Blocked unless `allowCodeGeneration` | Same |
| Privileges | Your user | Your uid and gid, all capabilities dropped, no new privileges, 256 processes, `containerMemory` (default 1 GB) |

## Guaranteed protections

Enforced outside the worker's JavaScript, by the operating system, the container runtime or the parent process. Application code cannot undo them from inside the worker.

**Both levels**

- **Credentials in the environment are withheld.** The worker's environment is an allowlist: `PATH`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TERM`, `NODE_ENV` and the Windows system variables, plus a private `HOME` and `TMPDIR`. `NODE_ENV` is allowed because configuration modules commonly branch on it at import time. It is handled predictably: passed only when the build's own environment sets it, passed unchanged, and only when it is a plain token of at most 32 letters, digits, dots, underscores or hyphens (`production`, `test`); any other value stops the build with an error instead of being dropped or altered. The same rule applies to a `NODE_ENV` in `env`. No other application variable is passed by default. Every other variable (`DATABASE_URL`, `MIKRO_ORM_*`, `TYPEORM_*`, `PG*`, `AWS_*`, tokens) is left out unless named in `envPassthrough`. Names that look like credentials or connection settings (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*AUTH*`, `*_KEY`, `*_URL`, `*_URI`, `*_DSN`, `DATABASE_URL`, `MIKRO_ORM_*`, `TYPEORM_*`, `PG*`, `MYSQL_*`, `AWS_*`, `AZURE_*`, `GOOGLE_*`, `npm_config_*`) are refused there, as are `NODE_OPTIONS` and `NODE_PATH`, which could load code before the worker starts or widen module resolution. Give settings that need a value a placeholder in `env`; `env` cannot set `NODE_OPTIONS` or `NODE_PATH`, or hold a URL with a password. The build reports how many variables it withheld, never their names or values.
- **The result is checked.** The worker returns the document through a result file in its own output directory, never stdout. The parent refuses a symlink, more than 32 MiB, invalid JSON, or a document that fails the laranex-schema contract's strict (producer) validation or is not `source: "declared"`.
- **Time is bounded.** A worker that does not finish within `timeout` seconds (default 120) is stopped.
- **The worker's output goes to a log file**, not a pipe, so a process left behind cannot stall the build; its tail is shown when extraction fails.

**`process`**

- **The worker's process group is killed** when it finishes, fails or times out (`taskkill /T /F` on Windows). The worker cannot start processes in the first place (see below), so this is a second line.

**`container`**

- **No network:** the container has only a loopback interface. The tests check this with Node.js 24 in the image, whose Permission Model does not restrict the network, so the refusal comes from the container (`ENETUNREACH`, `EAI_AGAIN`).
- **The project is mounted read-only**, and so is the image's root filesystem. Only a 128 MB `/tmp` and a disposable output directory are writable. Directories in `allowWrites` stay read-only (`EROFS`). A package inside an npm, Yarn, pnpm, Lerna or Rush workspace is mounted with its workspace root, so that linked packages resolve; `allowReads` directories outside it are mounted read-only at their host paths.
- **Nothing outlives the build:** the container runs with `--rm`, is killed and removed on timeout, and takes every process in it along.
- **Reduced privileges:** `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 256`, `--memory`, and your uid and gid.
- **The image is checked before use:** it must provide Node.js 22.13+ and `laranex-schema-viewer` at exactly the host's version, installed globally (found through the `laranex-schema-viewer` executable on its `PATH`).

## Best-effort safeguards

The Node.js [Permission Model](https://nodejs.org/api/permissions.html) restricts what the worker's process can do. Node.js documents it as a seat belt for trusted code, **not a security boundary against malicious code**. The worker runs:

```text
node --permission
     --allow-fs-read=<project> --allow-fs-read=<workspace root> --allow-fs-read=<each reachable node_modules>
     --allow-fs-read=<this package> --allow-fs-read=<allowReads ...> --allow-fs-read=<scratch>
     --allow-fs-write=<scratch: home, tmp, out> --allow-fs-write=<allowWrites inside the project ...>
     --no-addons --no-experimental-sqlite --disallow-code-generation-from-strings
     <package>/dist/isolation/worker.js --result <out>/result.json
```

with the project root as its working directory. It never passes `--allow-net`, `--allow-child-process`, `--allow-worker`, `--allow-addons` or `--allow-wasi`. Within that:

- **Files:** reads outside the listed directories and writes outside the scratch directories and `allowWrites` fail with `ERR_ACCESS_DENIED`. `allowWrites` entries must be inside the project.
- **Network (Node.js 26+):** TCP, UDP, `fetch` and DNS lookups fail with `ERR_ACCESS_DENIED`.
- **Processes and threads:** `child_process`, `worker_threads`, native addons (`process.dlopen`), WASI and the inspector are refused.
- **`node:sqlite`**, which does not honour the Permission Model on any version, is removed with `--no-experimental-sqlite`, so application code cannot open or create database files with it.
- **Code generation:** `eval` and `new Function` throw `EvalError` unless `allowCodeGeneration` opts out.
- **Exit hooks:** the worker leaves with `process.reallyExit` (taken before application code loads), so `exit` and `beforeExit` listeners the application registered do not run.
- **Home directory:** `HOME` is an empty private directory, so tools that look for `~/.pgpass`, `~/.aws` or `~/.npmrc` find nothing, and the real home directory is not readable by path.

TypeScript model files are compiled in the worker by a synchronous `module.registerHooks` hook (Node.js 22.15+ in the worker; on 22.13 and 22.14 only JavaScript models load) using the project's own `typescript` package (5.x or 6.x; TypeScript 7 has no JavaScript API). It transpiles each file on its own, honouring `target`, decorator and JSX settings of the project's `tsconfig.json`, and uses legacy decorators with metadata when the project does not choose. `module.register` is never used: its loader thread is refused under the Permission Model.

## Limitations

- **The Permission Model is not a security boundary** (Node.js documentation). Bugs in Node.js, or APIs it does not cover, can get past it. Process isolation reduces accidents; it does not contain an attacker. Use `container` for that.
- **Network:** only Node.js 26+ blocks it under the Permission Model, which is why process isolation is refused on 22 and 24.
- **Symlinks:** a symlink inside a readable or writable directory (the project, `node_modules`, `allowWrites`) leads wherever it points, and the Permission Model does not check the target. The test suite demonstrates this; it is not blocked at the process level. In a container, only mounted paths exist.
- **Open file descriptors bypass the checks:** the worker inherits its stdin and the log file; anything opened before the permission checks, or passed in, is usable.
- **Signals:** `process.kill(pid, …)` and `process._debugProcess(pid)` are not restricted, so application code can signal, or activate the inspector of, other processes of your user at the process level. A container has its own process namespace.
- **Everything readable is readable:** the whole project, including a `.env` file, the workspace, `node_modules`, and `allowReads`. Keep credentials out of the project tree, or use `container` and leave them out of the mount and the image.
- **`vm` still compiles strings:** `--disallow-code-generation-from-strings` covers `eval` and `new Function` in the main context, not `node:vm`.
- **No CPU or memory limit at the process level**, only the timeout. The container level adds `--memory` and `--pids-limit`.
- **A hostile worker can choose its own result:** it can write any document to the result file, which only affects the schema of the project it belongs to, and the document is still validated.
- **The container is only as strong as the runtime and the image:** use an image with your runtime and this package, and no credentials. Rootless Docker or Podman adds a layer. Environment values passed to the container (allowlisted only) appear on the container runtime's command line.
- **Windows:** the process level stops the worker's tree with `taskkill /T /F`. Neither level has been tested on Windows.

## Validation

`tests/isolation.test.ts` exercises hostile model modules (`tests/fixtures/adversarial/`) through a test-only extractor. On Node.js 26 at the `process` level it checks import-time writes outside the allowed directories, writes to `allowWrites`, TCP to a local listener, `fetch`, DNS and UDP, `child_process` and `worker_threads`, `process.dlopen`, `node:sqlite`, `eval` and `new Function` with and without the opt-out, credentials in the environment, under `HOME` and in a file outside the project, timeouts (the worker's pid is dead afterwards), exit hooks, the symlink limitation, TypeScript decorators, failing modules and invalid, non-declared and oversized results. On Node.js 22 and 24 it checks that process isolation is refused before any worker runs. Process-group cleanup is tested by driving the runner with a worker that is allowed to start a child, because a worker under the Permission Model cannot; the child must die with the group, on timeout and after a normal exit.

Container tests run only with `LSV_TEST_CONTAINER_IMAGE` (see `tests/containers/README.md`). They have passed on Docker 29.8 (Docker Desktop on macOS, arm64) with an image built from `tests/containers/Dockerfile` (Node.js 24), from hosts running Node.js 22.13.0, 22.23.3, 24.22.0 and 26.11.1: parity with the process level, no network past the Permission Model, a read-only project (`EROFS`) for an `allowWrites` directory, withheld credentials, container removal on timeout, and refusal of images without this package or that do not exist. They have not run on Podman, rootless Docker, or a Linux or Windows host. The memory, process-count and capability limits are passed to the runtime but not tested.

## Configuration

The isolation settings (`IsolationConfig` in `src/isolation/index.ts`; exposed by `build` when it lands):

| Setting | Default | Meaning |
| --- | --- | --- |
| `level` | `process` | `process` (Node.js 26+) or `container` |
| `timeout` | `120` | Seconds |
| `envPassthrough` | `[]` | Extra variables the worker may see; credentials and loader settings are refused |
| `env` | `{}` | Fixed placeholder values, such as `{"SECRET_KEY": "schema-viewer-placeholder"}` |
| `allowWrites` | `[]` | Project directories application code may write to (process level; read-only in a container) |
| `allowReads` | `[]` | Extra directories to read, such as packages linked from outside the project or workspace |
| `allowCodeGeneration` | `false` | Allow `eval` and `new Function` |
| `containerImage` | none | Required for `container` |
| `containerRuntime` | `docker`, then `podman` | |
| `containerMemory` | `1g` | |

A container image needs Node.js 22.13+ (22.15+ for TypeScript models) and the same `laranex-schema-viewer` version as the host, installed globally. Your project, with its `node_modules`, is mounted read-only; native addons are refused, so only JavaScript dependencies load.

```dockerfile
FROM node:24-slim
RUN npm install --global laranex-schema-viewer@0.1.0
```
