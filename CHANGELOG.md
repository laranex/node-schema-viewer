# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Package foundation: TypeScript (strict, ESM), ESLint with typescript-eslint, `node:test` suite compiled with `tsc`, MIT license. Requires Node.js 22.13 or later; tested on 22, 24 and 26.
- Static configuration under `"laranex-schema-viewer"` in the project's `package.json` (`output`), with unknown keys and database URLs rejected, and `init`, which adds the key without changing anything else.
- laranex-schema 1.x snapshots: bounded loading (32 MiB) with lenient reader validation, canonical JSON and revisions from `laranex-schema-viewer-ui`'s contract, strict validation and atomic writes for everything the package writes.
- `serve`: the shared viewer (`laranex-schema-viewer-ui` 0.1.0, used from the npm package) on `127.0.0.1:8765`, serving only manifest-listed files verified by SHA-256 at startup, `/snapshot.json` re-read and validated on every request, Host checks, GET/HEAD only, and python-schema-viewer's Content-Security-Policy.
- `mcp`: the five read-only tools of python-schema-viewer (`schema_overview`, `schema_search`, `schema_get_table`, `schema_get_model`, `schema_get_relationships`) on the official MCP TypeScript SDK v2, with the same arguments, pagination, 64 KiB limit, annotations and response text. A conformance suite compares 786 recorded python-schema-viewer responses over ten documents.

### Known issues

- Installing `laranex-schema-viewer-ui` 0.1.0 also installs its React, React DOM and `@xyflow/react` peers and dependencies (about 24 MB), which this package does not use at runtime.
- `laranex-schema-viewer-ui` 0.1.0's type declarations use extensionless relative imports, so TypeScript's `NodeNext` resolution cannot see its contract types; this package compiles with `Bundler` resolution.
- For a document of a later 1.x minor with properties 1.0 does not define, the revision differs from python-schema-viewer's: Python hashes the document without the unknown properties, this package hashes it as read. Responses are otherwise identical.
- Search folds case per code point like Python's `str.casefold`; characters added in newer Unicode versions than the Python build knows may fold differently.
- `build` is not available yet.
