# Installation

::: warning Not released yet
`node-schema-viewer` 0.1.0 has not been published to npm yet. The commands below are how it installs once it is.
:::

## Requirements

| Requirement | Version |
| --- | --- |
| Node.js | **22.13.0 or later** (`engines.node` is `>=22.13.0`); 22, 24 and 26 are tested |
| Module format | ESM; the CLI and the API run on Node.js directly, no bundler needed |
| Docker or Podman | Only for container isolation of `build` (required there on Node.js 22 and 24) |

Check your runtime with `node --version`. 22.13.0 is the lowest 22.x release that passed the compatibility probes. TypeScript schema modules (for `build`) need Node.js 22.15 or later.

## Install

Add the package to the project as a development dependency:

```bash
npm install --save-dev node-schema-viewer
npx node-schema-viewer --version
```

The package depends on an exact version of [`laranex-schema-viewer-ui`](https://laranex.github.io/schema-viewer-ui/), which provides the laranex-schema contract and the prebuilt viewer; nothing is downloaded at run time. The database drivers `pg` and `mysql2` are pure JavaScript, and SQLite uses the built-in `node:sqlite`.

Then add the configuration key to `package.json`:

```bash
npx node-schema-viewer init      # adds "node-schema-viewer": {"output": "schema-viewer.json"}
```

Keep it a development dependency: production installs (`npm ci --omit=dev`) then contain neither this package nor the viewer. To embed the viewer in your application during development, see [Embedding in your application](./embedding.md).

## Node.js versions and isolation

`serve`, `mcp`, `compare` and `check` read a saved document only; they need no isolation and work on every supported Node.js version without Docker.

Building a declared schema (`build --source declared`) imports your models in a separate extraction worker. Which isolation level it may use depends on the Node.js version running it:

| Node.js running the build | `process` isolation | `container` isolation |
| --- | --- | --- |
| 22.13+, 24 | **Refused** with an error | Yes (**required**) |
| 26+ | Yes (the default; best-effort, **not a security sandbox**) | Yes |

On Node.js 22 and 24 the Permission Model does not restrict the network, so process isolation is refused there. Nothing is ever silently downgraded: a missing Docker or Podman, a missing image, or an image with another version of this package stops the build. Use `container` for untrusted or security-sensitive projects and in CI. See [isolation and security](./security.md).

## Tested versions

CI tests supported release lines, not every patch release. Pull requests run Node.js 24 (LTS) with PostgreSQL, MySQL, MariaDB and container isolation, the 22.13.0 floor, and Node.js 26 for process isolation. Release validation runs every database engine on 22.13.0, 22, 24 and 26, container isolation on 22 and 24, and the embedding examples on 22.13.0 and 24. Node.js 26 is tested in its own job while it is the Current release and becomes a required check once it enters LTS (October 2026).

## Next steps

- [Quick start](./quick-start.md): view, ask about and check a document.
- [CLI and configuration](./cli.md): every command and option.
- [Database introspection](./database.md): read a live database's catalogs.
- [Embedding in your application](./embedding.md): the viewer as a protected, development-only page.
