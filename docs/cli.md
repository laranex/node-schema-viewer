# CLI and configuration

```bash
npx node-schema-viewer <command> [options]
```

Command-line options take precedence over the `"node-schema-viewer"` key of the project's `package.json` (read from the current directory), which takes precedence over built-in defaults.

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
| `output` | Document path, relative to the project root; the default snapshot of `serve`, `mcp`, `compare` and `check` |
| `comparisons` | Scope pairs `compare` computes and `check` requests, each with `baseline`, `target`, `limit` and `overrides`; see [schema comparison](./comparison.md#configure-comparisons) |
| `check` | `severity` (default `warning`) and `certainty` (default `certain`) thresholds for `check`; see [schema drift gate](./check.md#thresholds) |

Unknown keys and values are errors, and anything that looks like a database URL is rejected without being repeated in the error. A command that reads the configuration validates the whole key.

## init

```bash
npx node-schema-viewer init [--output PATH] [--project-root DIR]
```

Adds `"node-schema-viewer": { "output": "schema-viewer.json" }` to an existing `package.json`, keeping every other property, their order, the indentation and the final newline. It never replaces an existing key.

## serve

```bash
npx node-schema-viewer serve [--snapshot PATH] [--host HOST] [--port PORT]
```

| Option | Default |
| --- | --- |
| `--snapshot PATH` | Config `output`, else `schema-viewer.json`; a laranex-schema 2.x document |
| `--host HOST` | `127.0.0.1` |
| `--port PORT` | `8765` |

Serves the shared viewer and the document, re-read and validated on every request. See the [README](../README.md#viewer).

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

Exit code 0 when it could compare, 1 on an error, 2 on invalid usage.

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
| `--output FILE` | None |

Exit code 0 passed, 1 a finding meets the thresholds, 2 the check is incomplete or invalid (an invalid or unreadable document, a requested comparison not found, an incomplete comparison or database inspection, a failed inspection, an unknown migration status, invalid arguments or configuration); 2 wins over 1.

## build

Not available yet. `serve`, `mcp`, `compare` and `check` read a document written by another Laranex Schema Viewer (Laravel, Python); read-only database introspection is available as an API ([database introspection](./database.md)).

## Help and version

```bash
npx node-schema-viewer --help
npx node-schema-viewer --version
```

## Differences from python-schema-viewer

`compare` and `check` follow python-schema-viewer's commands: the same arguments, summaries, JSON output, `--write` behaviour and exit codes, checked byte for byte in `tests/parity.test.ts`. Intentional differences:

- Configuration is camelCase JSON in `package.json` (`objectType` in overrides) instead of TOML in `pyproject.toml`.
- Usage errors are worded by this CLI, not by argparse (both exit 2), and configuration errors name `package.json` keys.
- Connection names follow python-schema-viewer's pattern, with Unicode letters and digits matched as JavaScript's `\p{L}` and `\p{N}`.
- A file that cannot be read is described with the operating system's message as libuv words it (stderr only).
