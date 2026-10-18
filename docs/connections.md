# Multiple connections

A laranex-schema document is multi-connection: `connections` holds every database connection the producer read, each with its own name, driver, default schema, coverage and tables, in any mix of PostgreSQL, MySQL, MariaDB and SQLite. A single-connection document is simply a document with one entry. See [Connections and tables](https://laranex.github.io/schema-viewer-ui/contract#connections-and-tables) in the contract.

## Read several databases into one document

`introspectAll` reads each connection in its own worker, which receives only its own URL, and merges the results into one strictly validated 2.0 document:

```ts
import { introspectAll, writeDocument } from 'node-schema-viewer';

const document = await introspectAll([
    { url: process.env.APP_DATABASE_URL!, connection: 'default' },
    { url: process.env.ANALYTICS_DATABASE_URL!, connection: 'analytics' },
    { url: 'sqlite:./data/local.db', connection: 'local' },
]);
writeDocument(document, 'schema-viewer.json');
```

Connection names must be distinct, and one failing connection fails the whole inspection; nothing falls back to partial or declared metadata. See [database introspection](./database.md).

## Ids and names

Table ids are qualified by connection, `["<connection>", <schema or null>, "<table>"]`, so `users` in two connections are two tables. A foreign key never crosses connections, because a constraint lives in one database; an ORM relationship may.

## In the viewer

By default every connection is laid out in its own labelled frame (name, driver, table count, diagnostics). Pick one in the header's connection menu, step through them with <kbd>[</kbd> and <kbd>]</kbd>, or open `#connection=<id>`. With more than one connection, every table label names its connection. See the [viewer guide](https://laranex.github.io/schema-viewer-ui/viewer#several-connections) and try the three-connection document in the [live demo](./demo.md).

## In MCP

The MCP tools address tables by their exact ids, which include the connection, and `schema_compare` takes scopes by connection name (`CONNECTION` or `CONNECTION:SCHEMA`). See [MCP](./mcp.md).

## Comparing connections

A comparison scope is a connection, optionally with one of its schemas. Compare two connections, such as a primary and a replica or the same application on PostgreSQL and MySQL:

```bash
npx node-schema-viewer compare primary=replica
npx node-schema-viewer check primary=replica --severity error
```

See [schema comparison](./comparison.md#scopes).

## Configuring connections for `build`

When `build` lands, database connections will be configured in `package.json` by the environment variable that holds each URL, never the URL itself; see [planned configuration](./database.md#planned-configuration).
