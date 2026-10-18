# Troubleshooting and limitations

## The CLI does not start on an older Node.js

The package needs Node.js 22.13.0 or later (`engines.node` is `>=22.13.0`). Check with `node --version` and upgrade; 22, 24 and 26 are tested. See [installation](./installation.md).

## `build` refuses process isolation

On Node.js 22 and 24, `isolation: "process"` is refused because the Permission Model does not restrict the network there. Use `"isolation": "container"` with a local image, or run the build on Node.js 26. Nothing falls back to a weaker level; see [isolation](./build.md#isolation).

## `build --source combined` is not available yet

Combined builds (reconciling a declared and a database document) are not available yet and exit with code 2. Build `declared` and `database` documents separately in the meantime; see [build](./build.md).

## Unsupported laranex-schema version

`Unsupported laranex-schema version "1.0"; this reader supports 2.x` means the document is a 1.x snapshot. Nothing converts it: rebuild it with a producer that writes laranex-schema 2.0.

## `Snapshot not found` or `exceeds the 32 MiB limit`

Every command reads `--snapshot`, else the configured `output`, else `schema-viewer.json` in the current directory. Run the command from the project root or pass an absolute path. Documents are limited to 32 MiB.

## The viewer shows "Snapshot unavailable or invalid"

`serve` re-reads and validates the document on every request and answers 503 while it is missing or invalid, for example while another tool is still writing it. Fix or rebuild the document and reload; the server does not need a restart.

## The viewer answers "Host not allowed"

Requests must name the host `serve` listens on, or a loopback name, in their `Host` header. Open the URL that `serve` prints. The viewer has no authentication and no TLS: to reach it from another machine, keep `serve` on loopback behind an authenticated HTTPS reverse proxy or an access-controlled tunnel. See [CLI](./cli.md#serve).

## `serve` refuses a host: "is not a loopback address"

`serve` binds only to `127.0.0.0/8`, `::1` and `localhost`. Use one of them and put an authenticated HTTPS reverse proxy or tunnel in front of it. `--unsafe-allow-remote` binds another address without authentication or TLS and warns on every start; in a container, use it with the port published to the host's loopback only (`-p 127.0.0.1:8765:8765`). See [CLI](./cli.md#serve).

## The MCP server does not start, or shows an old schema

The MCP server validates and pins the document at startup; a missing, invalid or oversized file fails startup. Use absolute paths in the client configuration, since clients may start the server from another directory, and restart the server after the document changes. See [MCP](./mcp.md).

## `compare` or `check` reports a request error

`Requested comparison A → B names connection X, which the document does not have`, `… cannot be expanded`, `… matches no schema` and `… is listed more than once` come from the shared request expansion: check the connection and schema names against the document. Comparisons need database (or combined) metadata in the document. See [schema comparison](./comparison.md#scopes).

## `check` exits 2

Exit 2 means the check is incomplete or invalid: an invalid or unreadable document, a requested comparison that is not stored, an incomplete comparison or inspection, a failed inspection, an unknown migration status, or invalid arguments or configuration. With configured comparisons, store them first with `compare --write`, or name them on the command line. See [the drift gate](./check.md).

## Configuration errors

The `"node-schema-viewer"` key of `package.json` is static JSON and validated as a whole: unknown keys and values are errors, and anything that looks like a database URL is rejected without being repeated. JavaScript configuration files are never loaded. See [CLI and configuration](./cli.md#configuration).

## Database introspection fails

- **The role has write privileges:** introspection stops unless `allowWritePrivileges` is set. Use a [read-only role](./database.md#use-a-read-only-role).
- **A URL parameter is refused:** only the parameters listed under [URLs](./database.md#urls) are accepted; use `NODE_EXTRA_CA_CERTS` for a private certificate authority.
- **A foreign key points into a schema that is not inspected:** list every schema the inspected tables reference.

Errors never echo the URL or its password.

## Limitations

- `build` supports Drizzle only so far; TypeORM, MikroORM and Sequelize v6 are planned, and `--source combined` is not available yet. See [supported ORMs](./orm-support.md).
- Database documents leave `comparisons` (until `compare --write`), `migrations` and `inferredAssociations` empty.
- Process isolation is best-effort and refused on Node.js 22 and 24; see [isolation and security](./security.md#limitations).
