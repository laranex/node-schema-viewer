# Database introspection

Node Schema Viewer can read a live database's catalogs into a [laranex-schema 2.0](https://laranex.github.io/schema-viewer-ui/contract) document with `source: "database"`. It is a port of python-schema-viewer's introspection: same ids, same normalization and the same read-only rules, checked against documents recorded from python-schema-viewer.

The catalog readers fill a normalized internal schema model (`src/schema/model.ts`) that does not use the document's field names; one serializer (`src/schema/serialize.ts`) writes it as a canonical 2.0 document, builds the links with the contract's shared graph builder, gives each diagnostic its rule-based id, and validates the result strictly. Several connections are merged as serialized documents by the same module.

> Introspection is a programmatic API for now. The `build` command, its configuration and the comparison with declared models come in a later milestone; see [Planned configuration](#planned-configuration).

## API

```ts
import { introspect, introspectAll, IntrospectionError } from 'node-schema-viewer';

const document = await introspect({
    url: process.env.APP_DATABASE_URL!,  // never from configuration or arguments
    schemas: ['public', 'billing'],      // optional; default: the connection's default schema
    connection: 'default',               // the contract connection name
    allowWritePrivileges: false,         // see "Use a read-only role"
    timeout: 120,                        // seconds for the whole inspection
    statementTimeout: 30,                // seconds per statement
});

// Several connections as one document; each is read by its own worker that receives only its own URL.
const merged = await introspectAll([
    { url: process.env.APP_DATABASE_URL!, connection: 'default' },
    { url: process.env.ANALYTICS_DATABASE_URL!, connection: 'analytics' },
    { url: 'sqlite:./data/local.db', connection: 'local' },
]);
```

Both return a laranex-schema 2.0 document that passed the contract's strict validation, or throw `IntrospectionError`. A failure is reported as such; nothing falls back to declared metadata. With `introspectAll`, one failing connection fails the whole inspection, and connection names must be distinct.

### URLs

| Database | URL | Accepted parameters |
| --- | --- | --- |
| PostgreSQL | `postgresql://user:password@host:5432/database` (or `postgres://`) | `sslmode`, `ssl`, `uselibpqcompat`, `sslnegotiation`, `host` |
| MySQL, MariaDB | `mysql://user:password@host:3306/database` (or `mariadb://`); the database is required | `ssl=true` (verified TLS) |
| SQLite | `sqlite:/absolute/path.db`, `sqlite:///absolute/path.db` or `sqlite:relative/path.db` (relative to the current directory) | none |

SQLAlchemy-style schemes such as `postgresql+psycopg://` are refused with a hint. Other parameters are refused: `options`, `statement_timeout` and the like could override the read-only session settings, and `sslrootcert`, `sslcert` and `sslkey` would make the driver read files the worker may not read. Use `NODE_EXTRA_CA_CERTS` for a private certificate authority. Errors never echo the URL.

The drivers are `pg` and `mysql2` (pure JavaScript, pinned) and the built-in `node:sqlite`.

## Supported databases

The test suite runs against PostgreSQL 17.6, MySQL 8.4.6, MariaDB 11.4.8 (Docker images, `tests/databases/compose.yaml`) and the SQLite bundled with Node.js (3.47.2 on 22.13.0, 3.51.3 on 22.23.3, 3.53.4 on 24.22.0 and 26.11.1), on Node.js 22.13.0, 22.23.3, 24.22.0 and 26.11.1. PostgreSQL 12+ is required for generated columns and 15+ for `NULLS NOT DISTINCT`; older servers may report less. MySQL before 8.0.13 and every MariaDB version have no functional key parts.

## Use a read-only role

Introspection only reads catalogs, but give it a role that can do nothing else. The worker checks the role's privileges first and stops when the role could change the schema or data, unless `allowWritePrivileges` is set. Then it still runs every statement in a read-only transaction and adds a `write_privileges` diagnostic (category `inspection`) to the document.

**PostgreSQL**: the catalogs are readable without table privileges.

```sql
CREATE ROLE schema_reader LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE app TO schema_reader;
GRANT USAGE ON SCHEMA public TO schema_reader;          -- each schema you inspect
ALTER ROLE schema_reader SET default_transaction_read_only = on;
```

The check refuses superusers and roles that can create roles, databases or schemas, that can replicate or bypass row security, that can create objects in or own an inspected schema, or that own, or can insert into, update, delete from, truncate, reference or add triggers to, any table in the inspected schemas.

**MySQL and MariaDB**: `information_schema` shows only objects the account has a privilege on, so grant `SELECT` on the database. Introspection never reads rows.

```sql
CREATE USER 'schema_reader'@'%' IDENTIFIED BY '...';
GRANT SELECT, SHOW VIEW ON app.* TO 'schema_reader'@'%';
```

The check reads `SHOW GRANTS` and refuses any privilege other than `SELECT`, `SHOW VIEW`, `USAGE`, `SHOW DATABASES`, `PROCESS` and the replication monitoring privileges, `GRANT OPTION`, and granted roles, whose privileges it cannot list. Column-level grants are refused too (as in python-schema-viewer).

**SQLite** has no roles. The file must exist and be a regular file; it is opened read-only (never created) with `PRAGMA query_only = 1`.

## How a session stays read-only

| | PostgreSQL | MySQL, MariaDB | SQLite |
| --- | --- | --- | --- |
| Session | `-c default_transaction_read_only=on -c statement_timeout=… -c lock_timeout=… -c idle_in_transaction_session_timeout=60000`, then `BEGIN`, `SET TRANSACTION READ ONLY` | `SET SESSION TRANSACTION READ ONLY`, `max_execution_time` (MySQL) or `max_statement_time` (MariaDB), `START TRANSACTION READ ONLY` | `readOnly: true`, `PRAGMA query_only = 1` |
| Verified before reading | `SHOW transaction_read_only` is `on` | `@@session.transaction_read_only` (or `tx_read_only`) is 1 | `PRAGMA query_only` is 1 |
| Afterwards | `ROLLBACK` | `ROLLBACK` | closed |

Every statement first passes an allowlist (`SELECT`, `WITH`, `SHOW`, session `SET`, read-only `PRAGMA`, `BEGIN`, `START TRANSACTION`, `ROLLBACK`); anything else is refused before it reaches the driver. Connections time out after 10 seconds, statements after `statementTimeout`, and the worker after `timeout`. No migrations, DDL, DML or row queries are ever sent.

## What is read

- **Tables and columns:** schema-qualified tables (PostgreSQL partitions are left out, the partitioned parent is kept; views are not listed) and their comments; columns with native types (`format_type`, `COLUMN_TYPE`, the declared SQLite type), `typeName`, nullability, defaults (`literal`, `expression`, `sequence`, `identity`), generated columns (`stored`, `virtual`), enum values, collations, comments, and auto-increment (including SQLite's rowid alias).
- **Keys and constraints:** composite primary keys; foreign keys across schemas with referential actions (`NO ACTION` when none is given) and deferral (PostgreSQL, SQLite; `null` on MySQL); unique constraints (MySQL and MariaDB report them as unique indexes only) and check constraints.
- **Indexes:** parts (column or expression, order, nulls order, prefix length, collation, operator class), method, uniqueness, the primary key or unique constraint each backs, partial predicates, included columns, and `dialectOptions` for PostgreSQL `NULLS NOT DISTINCT` and MySQL invisible or MariaDB ignored indexes.
- **Ownership:** `alembic_version`, `django_migrations` and `aerich` tables are marked as framework or package tables, as python-schema-viewer marks them.

Ids are python-schema-viewer's: tables `["<connection>", <schema or null for the default schema>, "<table>"]`, foreign keys `["foreign_key", <table id>, <name>, <columns>, <target id>, <target columns>]`, indexes `<table id>:index:<name>`, constraints `<table id>:constraint:<name>`. Drivers have the contract's canonical names: `postgresql`, `mysql`, `mariadb` and `sqlite`. Indexes carry `parts` and `backs` (the primary key's index has `backs.kind` `primary_key`); 2.0 has no `Index.columns` or `Index.primary`. The 2.0 arrays `comparisons`, `migrations` and `inferredAssociations` are empty: introspection does not compare scopes, read migration history or infer associations yet.

Coverage records what each database can express: MySQL and MariaDB have no partial indexes or included columns (`not_applicable`), MariaDB and MySQL before 8.0.13 have no functional key parts, SQLite has no comments or included columns, and its check constraints are parsed from the table SQL (`partial`).

A foreign key into a schema (or MySQL database) that is not inspected makes the document invalid, as in python-schema-viewer: list every schema the inspected tables reference.

## Conformance with python-schema-viewer

`tests/fixtures/conformance/database/*.json` are python-schema-viewer's laranex-schema 2.0 documents for the synthetic schemas in `tests/databases/` (PostgreSQL with and without explicit schemas, MySQL, MariaDB, SQLite, the drift schemas on every database, and a PostgreSQL + MySQL + SQLite multi-connection document), recorded read-only with `scripts/record-database-conformance.py`. `tests/introspection-conformance.test.ts` requires the Node.js documents to be equal after replacing only the `generator` (`node-schema-viewer` instead of `python-schema-viewer`) and the random MySQL database name. They are.

They are python-schema-viewer's own laranex-schema 2.0 documents (recorded from its `feat/contract-2` branch at 7339d3b), run read-only against the same throwaway databases.

Known, deliberate differences that the fixtures do not exercise:

- PostgreSQL foreign keys name the referenced table's actual schema. SQLAlchemy infers it from `pg_get_constraintdef`, which leaves out schemas on the `search_path`, so python-schema-viewer reports the default schema when a referenced table lives in another schema that is on the `search_path`.
- PostgreSQL foreign keys that partitions inherit from a partitioned parent (`conparentid <> 0`) are left out; they point at partitions, which are not listed.
- SQLite sessions use SQLite's default busy handling instead of python-schema-viewer's 5-second timeout.

## Migration status and inferred associations

laranex-schema 2.0 defines migration tracks and inferred associations. This package writes both arrays empty for now; when they are filled, they mean exactly what the contract says:

- **`diverged`** is a migration status: one current revision recorded in the version table is an ancestor of another current revision, i.e. the version table has overlapping entries. It is not branch divergence. A history with several heads (unmerged branches) is a separate fact, reported as the `migration_multiple_heads` diagnostic, and a database at every head is `up_to_date`, not `diverged`.
- **Inferred associations** are what an uncovered foreign key implies between two ORM models that declare no relationship over it. Their `confidence` (`high`, `medium`, `low`) is a heuristic about the inference and never means an ORM attribute or relationship exists; viewers show them as "inferred, no ORM attribute declared".

## Tests

SQLite tests always run. Server tests run against disposable servers when their admin URLs are set; each suite creates its own database and roles with random names and passwords, and drops them:

```bash
docker compose -f tests/databases/compose.yaml up -d
export LSV_TEST_POSTGRES_URL=postgresql://postgres:lsv-admin@127.0.0.1:55432/lsv
export LSV_TEST_MYSQL_URL=mysql://root:lsv-admin@127.0.0.1:53306/lsv
export LSV_TEST_MARIADB_URL=mysql://root:lsv-admin@127.0.0.1:53307/lsv
npm test
```

## Planned configuration

When `build` lands, database connections will be configured in the static `"node-schema-viewer"` key of `package.json`, naming only the environment variable that holds each URL, never the URL:

```json
{
  "node-schema-viewer": {
    "databases": {
      "default": { "urlEnv": "APP_DATABASE_URL", "schemas": ["public", "billing"] },
      "analytics": { "urlEnv": "ANALYTICS_DATABASE_URL" }
    }
  }
}
```

A URL in the configuration or on the command line will be refused, as will a `urlEnv` variable that the extraction worker is allowed to see. `allowWritePrivileges` will be a command-line flag only.
