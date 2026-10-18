# Architecture

**One JSON contract → one shared UI → multiple frameworks.**

```text
Laravel (Eloquent)  ─┐
Python (SQLAlchemy,  ├─▶  laranex-schema 2.0 JSON  ─▶  shared viewer · MCP tools · compare · check
 Django, …)          │      (laranex-schema-viewer-ui: contract, validator, shared algorithms, viewer)
Node.js (this) ──────┘
```

Every Laranex Schema Viewer writes the same [laranex-schema](https://laranex.github.io/schema-viewer-ui/contract) document and shows it with the same viewer. The npm package [`laranex-schema-viewer-ui`](https://laranex.github.io/schema-viewer-ui/) provides both: the contract (JSON Schema, validator, canonical JSON, revisions, graph builder, ids, the shared comparison, request-expansion and gate algorithms, and conformance fixtures) and the prebuilt viewer, whose manifest declares the contract major it reads. This package depends on one exact version of it and never duplicates the contract or vendors the viewer.

## Layers

| Layer | Modules | Reads | Never |
| --- | --- | --- | --- |
| Snapshot | `src/snapshot.ts` | One document, at most 32 MiB; 2.x leniently | Writes anything but strictly validated, canonical 2.0, atomically |
| Configuration | `src/config.ts` | The `"node-schema-viewer"` key of `package.json` (static JSON) | Loads JavaScript configuration or database URLs |
| Viewer server | `src/server.ts` | The viewer files the manifest lists (SHA-256 verified) and the document per request | Serves files the manifest does not list |
| MCP | `src/query.ts`, `src/mcp.ts` | The document, pinned at startup | Writes, computes comparisons, connects to databases |
| Comparison and gate | `src/compare.ts`, `src/check.ts` | The document and `package.json` | Reimplements the shared algorithms; connects to databases |
| Producer model | `src/schema/` | — | Lets extractors write document fields directly |
| Database introspection | `src/introspection/` | Database catalogs, in verified read-only sessions | Imports application code; runs DDL, DML or row queries |
| Isolation | `src/isolation/` | Your models, in a separate worker (for the upcoming `build`) | Falls back to a weaker isolation level |

## The producer layering

Extractors fill a normalized internal schema model (`src/schema/model.ts`) that is independent of the document's field names: the catalog readers now, the ORM adapters later. One serializer (`src/schema/serialize.ts`) is the only module that knows the document. It writes canonical 2.0, builds the links with the contract's shared graph builder, gives diagnostics their rule-based ids, validates strictly, and merges documents of several connections.

## Parity with the family

The MCP responses are python-schema-viewer's, by value and by exact text, checked against its recordings; `compare` and `check` output is checked byte for byte against python-schema-viewer's on shared documents; database introspection is checked against python-schema-viewer's own documents for the same synthetic databases. See [MCP](./mcp.md#conformance), [CLI](./cli.md#differences-from-python-schema-viewer) and [database introspection](./database.md#conformance-with-python-schema-viewer).
