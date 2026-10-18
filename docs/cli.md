# CLI and configuration

```bash
npx node-schema-viewer <command> [options]
```

Command-line options take precedence over the `"node-schema-viewer"` key of the project's `package.json` (read from the current directory, or from `build --project-root`), which takes precedence over built-in defaults.

## Configuration

Static JSON only: JavaScript configuration files are never loaded or executed.

```json
{
  "node-schema-viewer": {
    "output": "schema-viewer.json",
    "comparisons": [
      { "baseline": { "connection": "app", "schema": "tenant_template" }, "target": { "connection": "app", "schema": "*" } }
    ],
    "check": { "severity": "warning", "certainty": "certain" }
  }
}
```

| Key | Purpose |
| --- | --- |
| `output` | Document path, relative to the project root; written by `build`, the default snapshot of `serve`, `mcp`, `compare` and `check` |
| `comparisons` | Scope pairs `compare` computes and `check` requests (and a database `build` stores), each with `baseline`, `target`, `limit` and `overrides`; see [schema comparison](./comparison.md#configure-comparisons) |
| `check` | `severity` (default `warning`) and `certainty` (default `certain`) thresholds for `check`; see [schema drift gate](./check.md#thresholds) |
| `source`, `orm`, `modules`, `databases`, `databaseUrlEnv`, `databaseSchemas`, `databaseConnection`, `isolation`, `timeout`, `containerImage`, `drizzle`, and the extraction worker settings | What `build` reads and how; see [build](./build.md#configuration). Database URLs are never configured, only the names of the environment variables that hold them |

Unknown keys and values are errors, and anything that looks like a database URL is rejected without being repeated in the error. A command that reads the configuration validates the whole key.

## init

```bash
npx node-schema-viewer init [--output PATH] [--orm NAME] [--module PATH...] [--project-root DIR]
```

Adds `"node-schema-viewer": { "output": "schema-viewer.json" }` to an existing `package.json`, with `orm` and `modules` (the schema modules `build` imports) when given, keeping every other property, their order, the indentation and the final newline. It never replaces an existing key, imports nothing and detects nothing (`build` detects the ORM from the dependencies).

It also appends a commented block to the project's `.gitignore` (creating it if needed) so that schema snapshots are never committed, and prints the patterns it added:

```gitignore
# >>> node-schema-viewer: schema snapshots are sensitive, never commit them >>>
/schema-viewer.json
/schema-viewer.html
/docs/schema.json
# <<< node-schema-viewer <<<
```

The patterns are anchored to the project root: the default output and HTML export, plus `--output` when it differs and lies inside the project. A pattern the file already lists is not repeated, and when the block is already there nothing is added, so running `init` in another project copy is safe.

## build

```bash
npx node-schema-viewer build [--source declared|database] [--project-root DIR] [--module PATH...] [--orm NAME] [--output PATH]
                             [--isolation process|container] [--timeout SECONDS] [--container-image IMAGE]
                             [--database-url-env NAME] [--schema NAME...] [--database-connection NAME] [--database NAME=ENV_VAR...]
                             [--allow-write-privileges] [--compare BASELINE=TARGET...] [--compare-limit N]
```

Writes a laranex-schema 2.0 document: `declared` from your ORM schema modules (Drizzle), imported only in the isolated extraction worker, or `database` from the live catalogs, read-only, one worker per connection. Database URLs come only from the environment variables named by `--database NAME=ENV_VAR`, `--database-url-env` or the configuration. Process isolation needs Node.js 26; on 22 and 24 use `--isolation container`. Exit code 0 when the document was written, 1 on an error (nothing is written), 2 on invalid usage and for `--source combined`, which is not available yet. See [build](./build.md).

Before it extracts anything, `build` checks the output path with Git. When the path is tracked in the Git index, the build fails with exit code 1 and writes nothing: untrack the file with `git rm --cached <path>` (the commits that hold it keep it; see [scan](#scan) `--history`), ignore it, and build again. When the path is inside a Git work tree and `git check-ignore` does not report it as ignored, `build` writes it and prints a warning on stderr. Outside a Git work tree, or without Git, there is no check.

## serve

```bash
npx node-schema-viewer serve [--snapshot PATH] [--host HOST] [--port PORT] [--unsafe-allow-remote]
```

| Option | Default |
| --- | --- |
| `--snapshot PATH` | Config `output`, else `schema-viewer.json`; a laranex-schema 2.x document |
| `--host HOST` | `127.0.0.1`; a loopback host only (`127.0.0.0/8`, `::1`, `localhost`) unless `--unsafe-allow-remote` |
| `--port PORT` | `8765` |
| `--unsafe-allow-remote` | Off |

Serves the shared viewer and the document, re-read and validated on every request. See the [README](../README.md#viewer).

The viewer has no authentication and no TLS, so `serve` binds only to loopback. Another `--host` (`0.0.0.0`, a LAN address, a host name) is refused with exit code 2. To reach the viewer from another machine, keep `serve` on loopback and put an authenticated HTTPS reverse proxy or an access-controlled tunnel in front of it. In a container, the container's loopback is not reachable through a published port, so `serve` there needs `--host 0.0.0.0 --unsafe-allow-remote` (and warns); publish the port to the host's loopback only (`-p 127.0.0.1:8765:8765`), so that nothing beyond the host can reach it.

`--unsafe-allow-remote` binds a non-loopback host anyway. It is never on by default, has no configuration key, and prints a warning to stderr on every start: anyone who can reach the address can read the whole schema, and the `Host` check is not access control. It is not a secure way to share the viewer; see [SECURITY.md](../SECURITY.md#development-only-viewer).

## mcp

```bash
npx node-schema-viewer mcp --snapshot /absolute/path/to/schema-viewer.json
```

Read-only MCP tools over stdio for one pinned document; see [MCP](./mcp.md).

## compare

```bash
npx node-schema-viewer compare [BASELINE=TARGET...] [--snapshot PATH] [--limit N] [--json] [--write]
```

Compares scopes of a saved document without a database or application imports, and prints a summary (`--json`: the comparison objects in canonical JSON). `--write` stores them in the document atomically, replacing those of the same scopes and their diagnostics. See [schema comparison](./comparison.md#compare-a-saved-document).

| Option | Default |
| --- | --- |
| `BASELINE=TARGET` | Config `comparisons`; repeatable. Each scope is `CONNECTION` or `CONNECTION:SCHEMA`; a target schema `*` stands for every inspected schema |
| `--snapshot PATH` | Config `output`, else `schema-viewer.json` |
| `--limit N` | `500`, for comparisons named on the command line |
| `--json` | Off |
| `--write` | Off |

Exit code 0 when it could compare, 1 on an error (a request that cannot be resolved, such as an unknown connection, a `*` that matches no schema or a comparison named twice; an invalid document or configuration; a failed write, which leaves the document as it was), 2 on invalid usage.

## check

```bash
npx node-schema-viewer check [BASELINE=TARGET...] [--snapshot PATH] [--severity LEVEL] [--certainty LEVEL] [--limit N] [--json] [--output FILE]
```

The CI schema drift gate, a thin layer over the shared reference gate (`gateDocument`): checks a saved document's comparisons, drift and reconciliation diagnostics and migration tracks against severity and certainty thresholds, without a database or application imports, and never writes the document. It checks the comparisons named on the command line (computed in memory first), else the configured `comparisons` (which must be stored in the document), else every stored one. Prints a summary (`--json`: the `laranex-schema-gate` 1.0 report). See [schema drift gate](./check.md).

| Option | Default |
| --- | --- |
| `BASELINE=TARGET` | The configured comparisons, else every stored one; repeatable |
| `--snapshot PATH` | Config `output`, else `schema-viewer.json` |
| `--severity LEVEL` | Config `check.severity`, else `warning` (`error`, `warning`, `info`) |
| `--certainty LEVEL` | Config `check.certainty`, else `certain` (`certain`, `likely`) |
| `--limit N` | `500`, for comparisons named on the command line |
| `--json` | Off |
| `--output FILE` | None; written atomically (a failed write exits 2 and leaves an existing file as it was) |

Exit code 0 passed, 1 a finding meets the thresholds, 2 the check is incomplete or invalid (an invalid or unreadable document, a requested comparison not found, an incomplete comparison or database inspection, a failed inspection, an unknown migration status, invalid arguments or configuration); 2 wins over 1.

## scan

```bash
npx node-schema-viewer scan [--tracked] [--untracked] [--artifacts DIR]... [--history] [--allowlist FILE] [--report FILE] [--json]
```

Finds laranex-schema snapshots by content, not by file name, so that a private schema is not committed or published by accident. It is the shared scanner of `laranex-schema-viewer-ui` (its `contract/scan.mjs`, run in process, with the classifier and allowlist rules of [the contract's "Snapshot scanning"](https://github.com/laranex/schema-viewer-ui/blob/main/docs/contract.md#snapshot-scanning)): the same options, summary line, report and exit codes. It reads files and runs `git` (fixed arguments, no shell) and nothing else: no application code, no database, no network.

| Option | Scans |
| --- | --- |
| `--tracked` | Every `.json`, `.html` and `.htm` file in the Git index, read from the index: the staged bytes, and files tracked before they were ignored |
| `--untracked` | The same files Git would add: untracked and not ignored |
| `--artifacts DIR` | Every file under a build output directory, ignore rules not applied, also `.js`, `.mjs`, `.cjs` and `.map` (repeatable) |
| `--history` | Every version of a candidate file reachable from any ref; fails on a shallow clone (`fetch-depth: 0` in CI) |
| `--allowlist FILE` | A `laranex-schema-allowlist` file; default `.laranex-schema-allowlist.json` at the scan root, if there is one |
| `--report FILE` | Writes the `laranex-schema-scan` 1.0 report |
| `--json` | Prints the report instead of the summary |

Name at least one scope. Paths are relative to the scan root, the Git work tree's top level (else the current directory). The command prints one line of counts and never prints file content; the paths and reasons are only in the report.

| Exit code | Meaning |
| --- | --- |
| 0 | Clean (stale allowlist entries are warnings) |
| 1 | Confirmed exposure: a snapshot, or an allowlisted file whose content (tampered) or path (moved) changed |
| 2 | Scan failure or incomplete scan: usage, not a Git work tree, Git failed, an invalid or unreadable allowlist, history unavailable, a missing artifact directory, an unreadable file, a file over 64 MiB, a symbolic link to a directory |
| 3 | Uncertain exposure: something that looks like a snapshot but is not one (truncated JSON, a fragment without `connections`) |

Precedence is 2, 1, 3, 0: an incomplete scan cannot vouch for anything. Treat every non-zero exit as a failure.

A synthetic fixture or a document committed on purpose is listed by exact path and SHA-256 (of its bytes, CRLF read as LF) in the allowlist, an explicit review decision rather than proof that it is harmless:

```json
{ "format": "laranex-schema-allowlist", "version": "1.0",
  "entries": [{ "path": "tests/fixtures/blog.json", "sha256": "…" }] }
```

The scanner finds JSON documents (also nested ones) and documents embedded in HTML, JavaScript and source maps. It does not decode compressed or encoded payloads (such as base64+gzip offline HTML exports), and SVG, PNG, DBML, Mermaid and Markdown exports cannot be recognized by content: keep those out of the repository yourself. It guards against accidents, not adversaries; see the [limitations](../SECURITY.md#limitations) and, when a snapshot was committed or published, the [incident response](../SECURITY.md#incident-response).

### Before each commit

A plain Git hook, `.git/hooks/pre-commit` (executable), scans what is about to be committed:

```sh
#!/bin/sh
exec npx --no-install node-schema-viewer scan --tracked
```

With husky, put the same command in `.husky/pre-commit`. lint-staged passes file names, which `scan` does not take, so run it from the hook rather than as a lint-staged task.

### In CI

```yaml
- run: npx node-schema-viewer scan --tracked --untracked --artifacts dist --report "$RUNNER_TEMP/scan-report.json"
- uses: actions/upload-artifact@v7
  if: failure()
  with:
    name: scan-report
    path: ${{ runner.temp }}/scan-report.json
    if-no-files-found: ignore
    retention-days: 7
```

Scan your published output too (the build directory, an unpacked `npm pack`, a documentation site) with `--artifacts`. The report lists paths, not content, but keep it with restricted access and a short retention all the same.

## Help and version

```bash
npx node-schema-viewer --help
npx node-schema-viewer --version
```

## Differences from python-schema-viewer

`compare` and `check` follow python-schema-viewer's commands: the same arguments, summaries, JSON output, `--write` behaviour and exit codes, checked byte for byte in `tests/parity.test.ts`. `build` follows python-schema-viewer's `build` (its differences are listed in [build](./build.md#differences-from-python-schema-viewer)). Intentional differences:

- Configuration is camelCase JSON in `package.json` (`objectType` in overrides) instead of TOML in `pyproject.toml`.
- Usage errors are worded by this CLI, not by argparse (both exit 2), and configuration errors name `package.json` keys: an override error reads `PATH/package.json "node-schema-viewer" comparisons[0] overrides[1].objectType must be one of …` where python-schema-viewer writes `[[tool.laranex-schema-viewer.comparisons]] entry 1 overrides[1].object_type must be one of …`; the rest of the message is the shared validator's.
- Connection names follow python-schema-viewer's pattern, with Unicode letters and digits matched as JavaScript's `\p{L}` and `\p{N}`.
- A file that cannot be read is described with the operating system's message as libuv words it (stderr only).
