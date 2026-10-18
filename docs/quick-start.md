# Quick start

This walk-through views, queries and checks a saved laranex-schema 2.0 document. Building a document from Node.js ORMs is [in development](./orm-support.md), so start from a document that another Laranex producer wrote, or read one from a database with the [introspection API](#read-a-database-instead).

## 1. Install and configure

```bash
npm install --save-dev node-schema-viewer
npx node-schema-viewer init
```

`init` adds `"node-schema-viewer": { "output": "schema-viewer.json" }` to your `package.json`, keeping everything else as it was. `output` is the default document of every command.

## 2. Get a document

Put a laranex-schema 2.0 document at `schema-viewer.json`, for example one written by [Python Schema Viewer](https://laranex.github.io/python-schema-viewer/) or Laravel Schema Viewer:

```bash
laranex-schema-viewer build --output schema-viewer.json      # python-schema-viewer
```

A 1.x document is refused with one clear error; rebuild it with a producer that writes 2.0.

## 3. Open the viewer

```bash
npx node-schema-viewer serve        # http://127.0.0.1:8765
```

The server binds to loopback by default, serves only the viewer files its manifest lists, and re-reads and validates the document on every request, so a rebuilt document shows up on reload. See [CLI](./cli.md#serve).

## 4. Connect an agent

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

Save this as `.mcp.json` for Claude Code; Codex and other clients are in [MCP](./mcp.md). Use absolute paths.

## 5. Compare and gate drift

When the document holds database metadata (from a `build --source database` of another producer, or the introspection API), compare its scopes and fail CI on drift:

```bash
npx node-schema-viewer compare 'app:tenant_template=app:*'    # differences between tenant schemas
npx node-schema-viewer check --output gate-report.json         # exit 0 passed, 1 drift, 2 incomplete or invalid
```

See [schema comparison](./comparison.md) and the [drift gate](./check.md), with a GitHub Actions example.

## Read a database instead

The read-only introspection API reads PostgreSQL, MySQL, MariaDB and SQLite catalogs into a strictly validated 2.0 document, which `writeDocument` saves atomically:

```ts
import { introspect, writeDocument } from 'node-schema-viewer';

const document = await introspect({ url: process.env.APP_DATABASE_URL!, connection: 'app' });
writeDocument(document, 'schema-viewer.json');
```

Give it a read-only role; see [database introspection](./database.md) and [security](./security.md#database-inspection).
