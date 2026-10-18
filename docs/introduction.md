---
aside: false
---

<PackageIntroduction />

## One contract, one viewer, your stack

Laranex Schema Viewer for Node.js (npm package `node-schema-viewer`) serves the shared [Laranex Schema Viewer UI](https://laranex.github.io/schema-viewer-ui/) and read-only MCP tools from a saved [laranex-schema 2.0](https://laranex.github.io/schema-viewer-ui/contract) document, compares the document's schemas, and gates schema drift in CI. It is part of the Laranex Schema Viewer family with [Laravel Schema Viewer](https://github.com/laranex/laravel-schema-viewer) and [Python Schema Viewer](https://laranex.github.io/python-schema-viewer/): every member writes the same JSON document and shows it with the same viewer; see [architecture](./architecture.md).

::: warning Status
Version 0.1.0 is not released yet. Building a document from Node.js ORMs (`build`) is in development; see [supported ORMs](./orm-support.md). Today the commands read a document written by another Laranex Schema Viewer (Laravel, Python), or one that the [database introspection API](./database.md) produced.
:::

## What you can do today

- **View** a laranex-schema 2.x document in the shared interactive ERD with `serve`, re-read and validated on every request.
- **Ask** with six read-only [MCP tools](./mcp.md) for Codex, Claude Code and other MCP clients.
- **Compare** scopes of a document, such as tenant schemas or a primary and a replica, with [`compare`](./comparison.md).
- **Gate** drift in CI with [`check`](./check.md): exit 0, 1 or 2 and a `laranex-schema-gate` 1.0 report.
- **Read** PostgreSQL, MySQL, MariaDB and SQLite catalogs into a document with the read-only [introspection API](./database.md).

## How it works

1. **Produce** a laranex-schema 2.0 document: another Laranex producer's `build`, or `introspect()` here.
2. **Inspect** it in the viewer: `npx node-schema-viewer serve`.
3. **Ask** about it through MCP, and **check** it in CI.

`serve`, `mcp`, `compare` and `check` never connect to a database, run migrations, start processes or execute your configuration. Only laranex-schema 2.x is read and only canonical, strictly validated 2.0 is written; a 1.x document is refused with one clear error.

<LiveDemo />
