# Laranex Schema Viewer for Node.js

`node-schema-viewer` serves the shared [Laranex Schema Viewer UI](https://github.com/laranex/schema-viewer-ui) and read-only MCP tools from a saved [laranex-schema](https://github.com/laranex/schema-viewer-ui/blob/main/docs/contract.md) 2.x document, compares its schemas (`compare`) and gates schema drift in CI (`check`). `serve`, `mcp`, `compare` and `check` never connect to a database, run migrations, start processes or execute your configuration.

> Status: 0.1.1, the first release. `build` writes documents from Drizzle ORM schemas (`--source declared`) or live databases (`--source database`); TypeORM, MikroORM, Sequelize and `combined` builds follow.

Requires Node.js 22.13 or later (22, 24 and 26 are tested).

Only laranex-schema 2.x is read, and everything this package writes is a strictly validated, canonical 2.0 document. A 1.x snapshot is refused with one clear error; nothing converts it, so rebuild it with a producer that writes 2.0.

`build` imports your schema modules only in an isolated extraction worker (process isolation on Node.js 26, a container on 22 and 24; never weaker) and reads databases read-only in a separate worker per connection, with URLs taken only from environment variables. Read-only database introspection (PostgreSQL, MySQL, MariaDB, SQLite) is also an API (`introspect`, `introspectAll`). See [docs/build.md](docs/build.md), [docs/database.md](docs/database.md) and [docs/security.md](docs/security.md).

```bash
npm install --save-dev node-schema-viewer
npx node-schema-viewer init --module src/db/schema.ts   # adds "node-schema-viewer" to package.json
npx node-schema-viewer build                     # declared, from the Drizzle schema (Node.js 26; --isolation container on 22/24)
APP_DATABASE_URL=... npx node-schema-viewer build --source database --database default=APP_DATABASE_URL
npx node-schema-viewer serve                     # http://127.0.0.1:8765
npx node-schema-viewer mcp --snapshot /abs/path/schema-viewer.json
npx node-schema-viewer compare 'app:tenant_template=app:*'   # differences between tenant schemas
npx node-schema-viewer check --output gate-report.json        # CI drift gate: exit 0, 1 or 2
```

Documentation site: <https://laranex.github.io/node-schema-viewer/> (built from `docs/` by `.gh-page/`, with a synthetic live demo). Documentation: [CLI and configuration](docs/cli.md), [build](docs/build.md), [schema comparison](docs/comparison.md), [schema drift gate in CI](docs/check.md), [MCP](docs/mcp.md), [database introspection](docs/database.md), [security](docs/security.md).

## Security notice

- The viewer is a development-only tool: never expose it or a snapshot in production. `serve` is loopback-only, for a single developer on their own machine; an embedded viewer needs your application's authentication, even locally.
- Schema snapshots and every export (JSON, offline HTML, DBML, Mermaid, Markdown, SVG, PNG) and gate report describe your schema: never commit them, even to a private repository.
- Protecting the page alone is insufficient: protect the page, every viewer file, the snapshot and every download on the server, with `Cache-Control: no-store`.
- Run `npx node-schema-viewer scan --tracked --untracked` before each commit and in CI, and fail on every non-zero exit ([scan](docs/cli.md#scan)).
- Policy and vulnerability reporting: [SECURITY.md](SECURITY.md); the shared policy: [Schema Viewer UI: Security](https://laranex.github.io/schema-viewer-ui/security.html).

## Configuration

Static JSON in your `package.json`; JavaScript configuration files are never loaded.

```json
{
  "node-schema-viewer": {
    "output": "schema-viewer.json",
    "modules": ["src/db/schema.ts"],
    "databases": { "default": { "urlEnv": "APP_DATABASE_URL", "schemas": ["public", "billing"] } },
    "comparisons": [
      { "baseline": { "connection": "app", "schema": "tenant_template" }, "target": { "connection": "app", "schema": "*" } }
    ],
    "check": { "severity": "warning", "certainty": "certain" }
  }
}
```

`output` is relative to the project root and is the default snapshot of every command. `modules` are the schema modules `build` imports, and `databases` names each connection and the environment variable holding its URL, never the URL ([build](docs/build.md#configuration)). `comparisons` names scope pairs by connection and schema for `compare` and `check` ([schema comparison](docs/comparison.md#configure-comparisons)), and `check` sets the gate's thresholds ([drift gate](docs/check.md#thresholds)). Unknown keys and anything that looks like a database URL are rejected.

## Viewer

`serve [--snapshot PATH] [--host HOST] [--port PORT] [--unsafe-allow-remote]` binds to `127.0.0.1:8765` by default, refuses a host that is not loopback unless `--unsafe-allow-remote` (no authentication, no TLS; see [CLI](docs/cli.md#serve)), and serves only the files the viewer build's manifest lists (each verified by SHA-256 at startup) plus `/snapshot.json`, re-read and validated on every request (503 while invalid). Requests must name this host or loopback in `Host`; responses carry a strict Content-Security-Policy, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

## Embedding in your application

The viewer is a development-only tool: never expose it or a snapshot in production, and require authentication even in local development. The one exception is `serve`, a standalone loopback-only viewer with no authentication, for a single developer on their own machine (never share it; anything beyond that machine goes through an authenticated HTTPS reverse proxy or an access-controlled tunnel); to show the viewer inside an existing Express, Fastify, NestJS or Next.js application instead, behind your sign-in or HTTP Basic Auth, follow [docs/embedding.md](docs/embedding.md). Its examples live in [examples/embedding](examples/embedding) and are tested with `npm run test:examples`. The shared policy and the guide for React, Vue, Angular and FastAPI frontends are in the [Schema Viewer UI documentation](https://laranex.github.io/schema-viewer-ui/embedding.html).

## Schema comparison

`compare [BASELINE=TARGET...] [--snapshot PATH] [--limit N] [--json] [--write]` compares scopes of a saved document (`CONNECTION` or `CONNECTION:SCHEMA`; a target `app:*` stands for every inspected schema) with the shared laranex-schema producer algorithms (request expansion, `compareScopes`, override validation, `storeComparisons`), prints a summary or the comparison objects, and with `--write` stores them in the document, strictly validated and atomically. It reads only the document and `package.json`. See [docs/comparison.md](docs/comparison.md).

## Drift gate

`check [BASELINE=TARGET...] [--severity LEVEL] [--certainty LEVEL] [--json] [--output FILE]` checks a saved document's comparisons, drift and reconciliation diagnostics and migration tracks with the shared reference gate and exits 0 (passed), 1 (a finding meets the thresholds) or 2 (the check is incomplete or invalid). `--json` prints the `laranex-schema-gate` 1.0 report, byte-identical to python-schema-viewer's. See [docs/check.md](docs/check.md), with a GitHub Actions example.

## MCP

`mcp [--snapshot PATH]` runs six read-only tools over stdio with the official MCP TypeScript SDK: `schema_overview`, `schema_search`, `schema_get_table`, `schema_get_model`, `schema_get_relationships` and `schema_compare` (stored comparisons and their differences; never computed). See [docs/mcp.md](docs/mcp.md). The response format is the one shared by the Laranex Schema Viewer family and specified in [python-schema-viewer's MCP documentation](https://github.com/laranex/python-schema-viewer/blob/main/docs/mcp.md#response-format): the document's own laranex-schema 2.0 objects as items, an envelope with `revision`, `total`, `offset`, `limit`, `items` and `nextOffset` (`limit` 1–100), a 64 KiB cap measured on compact UTF-8 JSON, the `links`, `derived_links` and `diagnostics` table sections, and the same error messages. A conformance suite compares every call python-schema-viewer recorded, by value and by the exact text its MCP server sends. Use absolute paths in client configuration:

```json
{
  "mcpServers": {
    "laranex_schema": {
      "type": "stdio",
      "command": "/absolute/path/to/node_modules/.bin/node-schema-viewer",
      "args": ["mcp", "--snapshot", "/absolute/path/to/schema-viewer.json"]
    }
  }
}
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
