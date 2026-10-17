# Laranex Schema Viewer for Node.js

`laranex-schema-viewer` serves the shared [Laranex Schema Viewer UI](https://github.com/laranex/schema-viewer-ui) and read-only MCP tools from a saved [laranex-schema](https://github.com/laranex/schema-viewer-ui/blob/main/docs/contract.md) 1.x document. It never connects to a database, runs migrations or executes your configuration.

> Status: 0.1.0, unreleased. Building snapshots from Node.js ORMs is not available yet; `serve` and `mcp` read a document written by another Laranex Schema Viewer (Laravel, Python) or a later milestone of this package.

Requires Node.js 22.13 or later (22, 24 and 26 are tested).

```bash
npm install --save-dev laranex-schema-viewer
npx laranex-schema-viewer init                      # adds "laranex-schema-viewer": {"output": "schema-viewer.json"} to package.json
npx laranex-schema-viewer serve                     # http://127.0.0.1:8765
npx laranex-schema-viewer mcp --snapshot /abs/path/schema-viewer.json
```

## Configuration

Static JSON in your `package.json`; JavaScript configuration files are never loaded.

```json
{
  "laranex-schema-viewer": {
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
      "command": "/absolute/path/to/node_modules/.bin/laranex-schema-viewer",
      "args": ["mcp", "--snapshot", "/absolute/path/to/schema-viewer.json"]
    }
  }
}
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
