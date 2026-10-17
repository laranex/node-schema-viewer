# Laranex Schema Viewer for Node.js

`node-schema-viewer` serves the shared [Laranex Schema Viewer UI](https://github.com/laranex/schema-viewer-ui) and read-only MCP tools from a saved [laranex-schema](https://github.com/laranex/schema-viewer-ui/blob/main/docs/contract.md) 1.x document. `serve` and `mcp` never connect to a database, run migrations or execute your configuration.

> Status: 0.1.0, unreleased. Building snapshots from Node.js ORMs is not available yet; `serve` and `mcp` read a document written by another Laranex Schema Viewer (Laravel, Python) or a later milestone of this package.

Requires Node.js 22.13 or later (22, 24 and 26 are tested).

Read-only database introspection (PostgreSQL, MySQL, MariaDB, SQLite) is available as an API (`introspect`, `introspectAll`) for the upcoming `build`; see [docs/database.md](docs/database.md) and [docs/security.md](docs/security.md#database-inspection).

```bash
npm install --save-dev node-schema-viewer
npx node-schema-viewer init                      # adds "node-schema-viewer": {"output": "schema-viewer.json"} to package.json
npx node-schema-viewer serve                     # http://127.0.0.1:8765
npx node-schema-viewer mcp --snapshot /abs/path/schema-viewer.json
```

## Configuration

Static JSON in your `package.json`; JavaScript configuration files are never loaded.

```json
{
  "node-schema-viewer": {
    "output": "schema-viewer.json"
  }
}
```

`output` is relative to the project root and is the default snapshot for `serve` and `mcp`. Unknown keys and anything that looks like a database URL are rejected.

## Viewer

`serve [--snapshot PATH] [--host HOST] [--port PORT]` binds to `127.0.0.1:8765` by default and serves only the files the viewer build's manifest lists (each verified by SHA-256 at startup) plus `/snapshot.json`, re-read and validated on every request (503 while invalid). Requests must name this host or loopback in `Host`; responses carry a strict Content-Security-Policy, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

## MCP

`mcp [--snapshot PATH]` runs five read-only tools over stdio with the official MCP TypeScript SDK: `schema_overview`, `schema_search`, `schema_get_table`, `schema_get_model` and `schema_get_relationships`. Arguments, pagination (`limit` 1–100, `offset`, `revision`, `next_offset`), the 64 KiB response limit and the response fields are the same as python-schema-viewer's ([its MCP documentation](https://github.com/laranex/python-schema-viewer/blob/main/docs/mcp.md)); a recorded conformance suite checks it. Use absolute paths in client configuration:

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
