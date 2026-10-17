# Read-only MCP integration

`node-schema-viewer mcp` runs read-only MCP tools over stdio, with the official MCP TypeScript SDK (v2), for one saved [laranex-schema 2.x](https://laranex.github.io/schema-viewer-ui/contract) document. The server validates and pins the document at startup: a missing, invalid or oversized file (over 32 MiB), or one of another format or version, fails startup. Restart it after the document changes. It never connects to a database, rebuilds the document or reads any other file, and stdout carries only the protocol.

Use absolute paths: MCP clients may start the server from another directory.

## Claude Code

Project `.mcp.json`:

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

## Codex

`config.toml`:

```toml
[mcp_servers.laranex_schema]
command = "/absolute/path/to/node_modules/.bin/node-schema-viewer"
args = ["mcp", "--snapshot", "/absolute/path/to/schema-viewer.json"]
```

## Tools

The six tools of python-schema-viewer, with the same arguments, annotations (`readOnlyHint`, `idempotentHint`, not destructive, closed world), descriptions and responses:

| Tool | Arguments | Result items |
| --- | --- | --- |
| `schema_overview` | — | Table summaries |
| `schema_search` | `query_text`: literal, case-insensitive substring, 1–200 characters | Search hits |
| `schema_get_table` | Exact `table` ID; `section`: `columns` (default), `indexes`, `foreign_keys`, `constraints`, `models`, `relationships`, `links`, `derived_links` or `diagnostics` | The section's objects |
| `schema_get_model` | Exact `model` ID | The relationships the model declares |
| `schema_get_relationships` | Optional `table` ID; `kind`: `orm` (default) or `foreign_key`, never mixed | Relationships, or foreign-key entries |
| `schema_compare` | `section`: `comparisons` (default) or `differences`; optional `comparison` ID, `baseline` and `target` scopes (`CONNECTION` or `CONNECTION:SCHEMA`); for differences, optional `object_type`, `change`, `severity`, `certainty` | Stored [comparisons](./comparison.md), or their differences |

Every tool also accepts `limit` (1–100, default 25), `offset` (default 0) and an optional `revision`. Follow `nextOffset` until it is null, keeping the other arguments and passing the returned `revision`. IDs are looked up, never evaluated or treated as paths. Unknown IDs and revisions return tool errors.

`schema_compare` reads the comparisons stored in the document; it never computes one. A scope argument is the connection's name, then `:` and the schema when the scope has one (`app` is the scope with a null schema, not any schema of `app`). Section `comparisons` lists each selected comparison without its differences, plus `labels` and `counts` of the listed differences by severity and certainty; section `differences` lists `{comparison, difference}` items and adds `comparisons` and `omitted` (differences the document counts but does not list, which no page returns). To store comparisons, run [`compare --write`](./comparison.md#compare-a-saved-document).

## Response format

The response format is shared by the Laranex Schema Viewer family and specified in [python-schema-viewer's MCP documentation](https://github.com/laranex/python-schema-viewer/blob/main/docs/mcp.md#response-format): the document's own contract objects as items, in python-schema-viewer's key order; an envelope with `revision`, `total`, `offset`, `limit`, `items` and `nextOffset`; a 64 KiB cap measured on compact UTF-8 JSON with 128 bytes kept for `nextOffset`; and the same error messages, checked in the same order, prefixed `Error executing tool NAME: `. Responses are two-space JSON in insertion order, as the Python SDK writes them.

## Conformance

`tests/fixtures/conformance/mcp/` holds python-schema-viewer's recordings (every tool, table, section, model, comparison and filter of the 14 shared valid fixtures, pagination, invalid arguments, and two byte-limit documents), and `tests/fixtures/conformance/mcp-text/` the exact text its MCP server sends for each call. `tests/query.test.ts` and `tests/mcp.test.ts` require all 1,801 recorded calls to match by value, through the query functions and end to end over stdio with the SDK client, and 1,633 to match by text; the other 168 are values outside a tool's input schema (`limit`, `offset` and the enumerations), which each SDK rejects in its own words, so only the error status is compared. Re-record with:

```bash
PYTHONPATH=<python-schema-viewer>/src python -B scripts/record-mcp-conformance.py <python-schema-viewer> [--check]
```
