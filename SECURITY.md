# Security policy

This is the security policy of `node-schema-viewer`, the Node.js package of the Laranex Schema Viewer family. The
policy shared by every package (embedding, authentication, staging, production exclusion) is
[Schema Viewer UI: Security](https://laranex.github.io/schema-viewer-ui/security.html); this file covers what is
specific to this package. The details are in [docs/security.md](docs/security.md).

## Supported versions

No version has been released yet: 0.1.0 is unreleased and nothing is published to npm, so no release is supported.
Security fixes are made on the `main` branch. Once releases exist, during the 0.x development phase only the latest
released version receives security fixes, with no backports to older 0.x releases or to prereleases.

## Reporting a vulnerability

Do not report a suspected vulnerability in a public issue, pull request or discussion, and do not attach a real schema
snapshot to any report.

Report it privately through
[GitHub private vulnerability reporting](https://github.com/laranex/node-schema-viewer/security/advisories/new), with
the affected commit, reproduction steps using synthetic data, and the impact you observed. Please allow time for a fix
before public disclosure.

In scope are, for example: reading files other than the viewer's and the snapshot through `serve`, bypasses of its
loopback, `Host` or bounds checks, script injection from schema strings into the viewer, MCP behaviour beyond read-only
queries of the pinned document, application code or credentials escaping the extraction worker's guaranteed
protections, writes through the introspection worker, and `scan` missing a supported format it is specified to detect.

## Security model

| Concern | The package enforces | You (the application or repository owner) must |
| --- | --- | --- |
| Built-in viewer (`serve`) | Binds to loopback; refuses another `--host` (exit 2) unless `--unsafe-allow-remote`, which warns on every start; checks `Host`; serves only the files the viewer's manifest lists (SHA-256 verified) and the validated snapshot; `GET`/`HEAD` only; `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a strict Content-Security-Policy on every response, errors included | Keep it on loopback, for yourself only. For anyone or anything else, keep it on loopback behind an authenticated HTTPS reverse proxy or an access-controlled tunnel |
| Embedded viewer ([embedding](docs/embedding.md)) | Nothing: no authentication, middleware or mount helper. `loadViewer`, `loadDocument` and `POLICY` are building blocks; the examples' `lib/` helpers are examples, not part of the package | Authenticate the page, every viewer file, the snapshot and downloads on the server; register the routes only in development; keep the viewer and the snapshot out of production installs and builds |
| MCP (`mcp`) | stdio only, read-only, one document validated and pinned at startup; bounded responses (64 KiB); no database, network, process or other file | Never expose it over a network; any bridge to HTTP must add its own authentication |
| Build isolation (`build --source declared`) | Application code runs only in the extraction worker. `process` isolation on Node.js 26 only, best-effort and not a sandbox; refused on 22 and 24, where `container` (no network, read-only project) is required; never downgraded to a weaker level; environment allowlist without credentials; result validated | Use `container` for code you have not reviewed and in CI; keep credentials out of the project and the image |
| Database introspection (`build --source database`) | A separate worker per connection, which never imports application code; the URL only from a named environment variable, sent on stdin, scrubbed from errors; database-enforced, verified read-only sessions; write-privileged roles refused unless `allowWritePrivileges` | Use a read-only role; never put URLs in configuration or arguments |
| Snapshots in Git | `scan` (shared scanner); `init`'s `.gitignore` block; `build` fails on an output path Git tracks and warns about one Git does not ignore; the published npm package ships no fixtures or snapshots | Run `scan` before each commit and in CI, failing on every non-zero exit; review every allowlist change |
| Exports and reports | Nothing: the viewer's downloads are made in the browser, and `check --output` writes where you tell it | Store, share and retain exported files and gate reports responsibly |

## Schema snapshots are sensitive

A laranex-schema snapshot describes your whole schema: tables, columns, keys, indexes, ORM models and comparisons.
Treat as just as sensitive every export of a private schema (JSON, offline HTML, DBML, Mermaid, Markdown, SVG, PNG)
and every `laranex-schema-gate` report from `check`, which names connections, schemas, tables and columns. Keep gate
reports as CI artifacts only where people with access to the repository can read them, with a short retention.

Never commit a snapshot, even to a private repository: it stays in the Git history.

## Protecting the page alone is insufficient

The schema document, every viewer asset and every delivery path need the same server-side protection: the page, its
assets, `snapshot.json` or an inline document, downloads, an `<iframe>` or other embedding, caches and CDNs, and object
storage. A static file server, CDN or bucket that serves one of them without the check bypasses it.

- Send `Cache-Control: no-store` on every sensitive response, errors (`401`, `404`, `503`) included.
- Use HTTPS for anything beyond localhost.
- Authentication is enforced only by the server or the integrating application, never by the browser UI. Client-side
  route guards, hidden links and obscure URLs are not access controls.

## Development-only viewer

The viewer is a development tool. Never expose it, or a snapshot, in production. Authentication is mandatory, even in
local development.

The one exception is `serve`: a loopback-only viewer with no authentication, for a single developer on their own
machine. Never share it. `--unsafe-allow-remote` is unsafe, as its name says: it binds a non-loopback address with no
authentication and no TLS. Reach the viewer from elsewhere only through an authenticated HTTPS reverse proxy or an
access-controlled tunnel, with `serve` still on loopback. In a container, publish the port to the host's loopback only
(`-p 127.0.0.1:8765:8765`). An application that embeds the viewer, including in shared development, staging or UAT,
must authenticate it as [Embedding in your application](docs/embedding.md) describes.

## MCP

`mcp` runs over local stdio only and is read-only; there is no remote transport. It reads only the document it pinned at
startup and never connects to a database, opens a socket, starts a process or reads another file. Responses carry the
document's own objects and add no file system paths, environment values or credentials of the server's own. Any HTTP
bridge you put in front of it must add its own authentication. See [docs/mcp.md](docs/mcp.md).

## Git protection

`node-schema-viewer scan` ([CLI reference](docs/cli.md#scan)) is the shared scanner of `laranex-schema-viewer-ui`
(`contract/scan.mjs`, run in process). It finds laranex-schema snapshots by content in the Git index (staged bytes, and
files tracked before they were ignored), untracked files, build output directories (`--artifacts DIR`) and, with
`--history`, every reachable version.

- **Exit codes:** 0 clean, 1 confirmed exposure, 2 scan failure or incomplete scan, 3 uncertain exposure; precedence
  2, 1, 3, 0. CI must fail on any non-zero exit.
- **Allowlist:** `.laranex-schema-allowlist.json` lists a file committed on purpose by exact path and SHA-256. An entry
  is an explicit review decision, not proof that the content is harmless.
- **`.gitignore`:** `init` appends a commented block with `/schema-viewer.json`, `/schema-viewer.html` and the
  configured output. `build` fails with exit 1 and writes nothing when its output path is tracked in the index, and
  warns when the path is in a work tree and not ignored.
- **Pre-commit:** run `scan --tracked` from a Git hook; see [Before each commit](docs/cli.md#before-each-commit) and
  [In CI](docs/cli.md#in-ci).

## Limitations

- `scan` detects by the content of supported formats and by file extension: `.json`, `.html` and `.htm` in the Git
  scopes, and also `.js`, `.mjs`, `.cjs` and `.map` with `--artifacts`.
- Compressed or encoded payloads, such as base64+gzip offline HTML exports, are not decoded or scanned.
- Renamed files with another extension, HTML-entity-escaped documents, and SVG, PNG, DBML, Mermaid and Markdown exports
  cannot be recognized by content.
- The scanner guards against accidents, not adversaries.
- Process isolation is best-effort, not a sandbox: the Node.js Permission Model is not a security boundary. Symlinks
  inside granted directories, inherited file descriptors, signals to other processes of your user and `node:vm` are not
  restricted at the process level, and everything readable (including a `.env` in the project) is readable. Use
  `container` for untrusted code.
- The introspection worker can reach any host on every Node.js version (the drivers need the network); it runs only
  this package's code and its drivers. `node:sqlite` ignores the Permission Model; SQLite safety rests on the path
  check, `readOnly` and `PRAGMA query_only`.
- The container level is only as strong as the container runtime and the image. Neither isolation level has been
  tested on Windows, and container isolation not on Podman or rootless Docker.

The full list is in [docs/security.md](docs/security.md#limitations).

## Incident response

When a snapshot or export reached Git or was published:

1. Untrack it with `git rm --cached <path>`, add the ignore rule, and commit.
2. Treat anything already pushed or shared as disclosed. Find every copy with
   `npx node-schema-viewer scan --history` (in a full clone).
3. Rewrite history (for example with `git filter-repo`) only with the repository owner's approval, and coordinate the
   force-push and fresh clones with everyone who has one.
4. Purge CI artifacts, caches, CDN and GitHub Pages copies and forks where possible.
5. Rotate anything the schema revealed, such as secrets in column defaults or comments. Rotation is the fix; rewriting
   history is cleanup.

## Responsibility boundary

The package is responsible for safe defaults, protection of the snapshots it generates, scanner checks for the
supported formats, and secure behaviour when serving the viewer. Once you deliberately download or export a standalone
file, storing, sharing and distributing it is the repository owner's responsibility.

## Disclaimer

The software is licensed under the MIT License, and the disclaimer in [LICENSE](LICENSE) applies. Nothing in this
policy changes it or adds a warranty.
