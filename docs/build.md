# Build

```bash
npx node-schema-viewer build [--source declared|database] [options]
```

`build` writes one [laranex-schema 2.0](https://github.com/laranex/schema-viewer-ui/blob/main/docs/contract.md) document in canonical JSON (sorted keys, two-space indentation, no timestamps). It validates the document strictly, then writes it atomically: a temporary file is renamed over the output, so a failed build leaves the previous file in place. It is a port of python-schema-viewer's `build`, with the same sources, options, messages and exit codes where they apply.

| `--source` | Reads | Where | Writes |
| --- | --- | --- | --- |
| `declared` (default) | Your ORM schema modules | The isolated [extraction worker](./security.md) | Declared provenance and coverage, models and ORM relationships |
| `database` | The database catalogs | One read-only [introspection worker](./database.md) per connection | Database provenance and coverage |
| `combined` | Not available yet | | `build --source combined` exits 2 |

Supported ORM: [Drizzle ORM](#drizzle-orm). TypeORM, MikroORM and Sequelize follow. Prisma has its own viewer and is not supported.

## Quick start

```bash
npm install --save-dev node-schema-viewer
npx node-schema-viewer init --module src/db/schema.ts
npx node-schema-viewer build                  # declared, from src/db/schema.ts
npx node-schema-viewer serve

export APP_DATABASE_URL='postgresql://schema_reader:...@db.internal/app'
npx node-schema-viewer build --source database --database default=APP_DATABASE_URL --output schema-database.json
```

On Node.js 22 and 24 a declared build needs container isolation (see [Isolation](#isolation)).

## Configuration

Static JSON in the `"node-schema-viewer"` key of `package.json` (never executed). Command-line options take precedence over it, and it takes precedence over the defaults.

```json
{
  "node-schema-viewer": {
    "output": "schema-viewer.json",
    "orm": "drizzle",
    "databases": {
      "app": { "driver": "postgresql", "modules": ["src/db/app/*.ts"], "urlEnv": "APP_DATABASE_URL", "schemas": ["public", "billing"] },
      "analytics": { "driver": "mariadb", "modules": ["src/db/analytics.ts"], "urlEnv": "ANALYTICS_DATABASE_URL" }
    },
    "isolation": "container",
    "containerImage": "my-app-schema@sha256:…",
    "timeout": 120,
    "drizzle": { "casing": "snake_case" }
  }
}
```

With one database, `modules` at the top level is enough; its tables belong to the connection `default`:

```json
{ "node-schema-viewer": { "modules": ["src/db/schema.ts"], "output": "schema-viewer.json" } }
```

| Key | Option | Default | Purpose |
| --- | --- | --- | --- |
| `source` | `--source` | `declared` | `declared` or `database` (`combined` is not available yet) |
| `orm` | `--orm` | Detected | `drizzle`; when unset, the one supported ORM listed in `package.json` dependencies (nothing is imported to find it) |
| `modules` | `--module` (repeatable) | none | Schema modules of the connection `default`: paths relative to the project root, glob patterns (`*`, `**`, `?`; `node_modules` and hidden directories are not searched), or package names the project resolves. `--module` replaces every configured module |
| `databases.NAME` | `--database NAME=ENV_VAR` (repeatable) | none | One connection: `driver` (`postgresql`, `mysql`, `mariadb`, `sqlite`), `modules` (its schema modules), `urlEnv` (the environment variable holding its URL), `schemas` (to inspect; default: the connection's default schema). An entry without `urlEnv` only declares schema modules. `--database` selects the connections to inspect and replaces the configured `urlEnv`; `schemas` still come from the entry |
| `databaseUrlEnv` | `--database-url-env` | `LARANEX_SCHEMA_DATABASE_URL` | The variable holding the URL of a single database |
| `databaseSchemas` | `--schema` (repeatable) | the default schema | Schemas of a single database |
| `databaseConnection` | `--database-connection` | `default` | Connection name of a single database |
| `output` | `--output` | `schema-viewer.json` | Document path (configured: relative to the project root; option: to the working directory) |
| `isolation` | `--isolation` | `process` | `process` (Node.js 26+) or `container` |
| `containerImage` | `--container-image` | none | Required for `container` |
| `timeout` | `--timeout` | `120` | Seconds for extraction, and for each database inspection |
| `envPassthrough`, `env`, `allowWrites`, `allowReads`, `allowCodeGeneration`, `containerRuntime`, `containerMemory`, `containerPackagePath`, `pullImage` | | | Extraction worker settings; see [security](./security.md#configuration) |
| `drizzle.casing` | | none | `snake_case` or `camelCase`: the casing your `drizzle({ casing })` applies to columns declared without a name |
| `comparisons` | `--compare BASELINE=TARGET`, `--compare-limit N` | none | Compared and stored by database builds; see [schema comparison](./comparison.md) |
| | `--allow-write-privileges` | off | Inspect with a role that could change the database, in read-only sessions |
| | `--project-root DIR` | working directory | Where `package.json` and the schema modules are |

Rules, as in python-schema-viewer:

- URLs never come from configuration or arguments, only from the environment variables named by `urlEnv`, `--database` or `databaseUrlEnv`. They are read by the `build` process itself and sent to the introspection worker on stdin; the extraction worker never sees them. A `url` key, a value that looks like a URL, or a URL variable listed in `envPassthrough` or `env` stops the build, and errors never repeat the value.
- `databases` cannot be combined with `databaseUrlEnv`, `databaseSchemas` or `databaseConnection`, nor `--database` with `--database-url-env`, `--schema` or `--database-connection`; the build says which options conflict. Top-level `modules` cannot be combined with `modules` in `databases` entries, and a module belongs to one connection.
- Connections are inspected one after the other, each in its own worker with only its own URL. If one fails, nothing is written.
- `--compare` needs `--source database`; a declared build skips configured comparisons and says so.
- Unknown keys and values are errors.

## Output and exit codes

```text
Detected ORM drizzle (drizzle-orm in package.json)
Extracted with process isolation; 41 environment variables withheld
Saved laranex-schema 2.0 (declared): 8 tables, 8 models, 10 ORM relationships, 1 extraction diagnostics, to schema-viewer.json
```

A database build prints `Inspected connection NAME read-only (DRIVER)` per connection (`Inspected the database read-only (DRIVER)` for a single database), and `Compared N scope pairs` when it stores comparisons. Notices, such as a pulled image that is not pinned by digest, go to stderr.

Exit code 0 when the document was written; 1 on an error (configuration, a module that fails to import, a refused isolation level, an inspection that fails; nothing is written); 2 on invalid usage, and for `--source combined`.

## Isolation

Declared builds import your schema modules, which runs their code, so the Drizzle adapter runs only inside the extraction worker. See [build security](./security.md) for what each level guarantees.

| Node.js running `build` | `--isolation process` | `--isolation container` |
| --- | --- | --- |
| 22.13+, 24 | Refused: process isolation needs Node.js 26 | Required |
| 26+ | Default | Available |

Nothing falls back to a weaker level: a missing Docker or Podman, a missing image or an image with another version of this package stops the build. The image needs Node.js 22.13+ and `node-schema-viewer` at the same version; it does not need Drizzle or any ORM, which are loaded from your project (mounted read-only). Database builds do not import application code and need no extraction worker.

## Drizzle ORM

Tested with `drizzle-orm` 0.36.4, 0.38.4, 0.40.1, 0.44.7 and 0.45.4 (the latest stable release; the test schemas give identical documents on all of them), on `pg-core`, `mysql-core` and `sqlite-core`. It is an optional peer dependency (`>=0.36.0 <1.0.0`): the adapter loads `drizzle-orm` from your project, the same package your schema modules import, never a copy of its own. Earlier versions lack `drizzle-orm/casing` and are refused. Drizzle 1.0 (beta and release candidates) replaces `relations()` with `defineRelations()` (relations v2, with `through` for many-to-many) and is refused until it is supported.

The adapter imports each configured module and reads its exports through Drizzle's metadata API: `is(value, Table)`, each dialect's `getTableConfig()`, `getTableName()`, `getSQLType()`, the dialect's SQL rendering (inline parameters, unqualified column names), and `extractTablesRelationalConfig()` with `normalizeRelation()` for `relations()`. A CommonJS module's exports are read too, and TypeScript modules load through the worker's TypeScript hook (Node.js 22.15+ in the worker).

### What is extracted

| Drizzle | Document |
| --- | --- |
| Each exported table | A table (schema from `pgSchema()` or `mysqlSchema()`, else unqualified) and a model named by its export, as Drizzle's relational queries know it. Its `source` is null: Drizzle does not record where a table is declared |
| Columns | `type` as `getSQLType()` returns it (`varchar(255)`, `timestamp with time zone`, an enum's name); nullability; `timezone` for PostgreSQL timestamps and times; enums (`pgEnum` with its name, `mysqlEnum`); `text({ enum })` values as `extensions.drizzle.enumValues` (no database type) |
| Defaults | `.default(sql…)`, `defaultNow()`, `defaultRandom()` as SQL; strings, numbers, booleans and `null` as SQL literals; `$defaultFn()` as an ORM default (the function's name, never called); `$onUpdate()` as `extensions.drizzle.onUpdate` |
| Identity, serial, generated | `generatedAlwaysAsIdentity()` / `generatedByDefaultAsIdentity()` as an identity default (sequence options in `extensions.drizzle.identity`); `serial` types, MySQL `autoincrement()` and SQLite `autoIncrement` as auto-increment; a SQLite `INTEGER PRIMARY KEY` leaves it to the database (`null`); `generatedAlwaysAs()` with its storage |
| Primary keys | Column `primaryKey()` or composite `primaryKey()` |
| Foreign keys | `references()` and `foreignKey()`, composite and across schemas, with Drizzle's name (`getName()`) and actions in SQL spelling. Drizzle states `NO ACTION` for PostgreSQL when none is given; MySQL and SQLite actions it does not declare are null |
| Unique constraints | Column `unique()` and table `unique()`, with PostgreSQL `nullsNotDistinct()` in `extensions.drizzle` |
| Indexes | `index()` / `uniqueIndex()`: columns and SQL expressions, PostgreSQL order, nulls order (PostgreSQL's defaults are left out, as in the database document; Drizzle's `desc()` keeps NULLS LAST) and operator classes, methods (`using()`), predicates (`where()`), and PostgreSQL `concurrently`, `only`, `with` and MySQL `algorithm`, `lock` in `dialectOptions` |
| Checks | `check()` with its SQL |
| `relations()` | ORM relationships, separate from foreign keys: `one` (many-to-one, or one-to-one when its columns are a key of the table, or the field-less side of a one-to-one) and `many` (one-to-many), keyed like foreign keys, with their inverse, `relationName` in `extensions.drizzle`, and `readOnly` true (Drizzle never writes through relations). A relation across connections is kept as a relationship |

Foreign keys that no relation covers become inferred associations (the contract's shared `inferAssociations`). Coverage: `comments` and `includedColumns` are `not_applicable` (Drizzle declares neither), MySQL `indexPredicates` too; a feature is `partial` when something in it could not be represented.

### Reported as diagnostics, never guessed

`extraction` diagnostics with kind `unsupported_metadata`, `unresolved_foreign_key` or `unresolved_relationship`:

- views and materialized views (`pgView`, `mysqlView`, `sqliteView`), sequences (`pgSequence`), row-level security (`enableRLS()`, `pgPolicy()`);
- a default Drizzle converts in JavaScript (objects, arrays, `Date`), kept in `extensions.drizzle.default`, not as SQL; a MySQL string default with a backslash;
- SQL with a `sql.placeholder()`, which has no value in a schema;
- a foreign key or relation to a table the selected modules do not export, or a relation Drizzle cannot resolve (a `many()` without its `one()`);
- a foreign key to a table of another connection: a constraint lives in one database, so it names the table in its own connection, as that database would resolve it;
- `relations()` exported in a connection that does not export their table.

Comments, collations and table notes are not part of Drizzle's API and stay null. Names Drizzle generates (`users_email_unique`, `posts_author_id_users_id_fk`) are `getName()`'s, from the columns' keys; drizzle-kit renames them for a configured casing, which `drizzle.casing` does not.

### Connections

With `modules` at the top level, every table belongs to the connection `default`. With `databases.NAME.modules`, each connection gets the tables its own modules export. A connection's tables must share a dialect; `driver` must match it (`pg-core` → `postgresql`, `mysql-core` → `mysql` or `mariadb`, `sqlite-core` → `sqlite`) and defaults to it, except that `mysql-core` does not tell MySQL from MariaDB, so its driver stays null unless configured. The build stops when a table is exported in two connections, when two tables of one connection have the same name or export name, or when a connection's modules export no tables.

## Differences from python-schema-viewer

- Configuration is camelCase JSON in `package.json`; connections are `databases.NAME` with `urlEnv`, and their schema modules are listed there, because Drizzle tables have no metadata object that groups them.
- `--module` takes file paths, globs or package names instead of Python module names; there is no `--recursive` (use a glob), `--target` or `--settings`, and nothing detects schema modules. `init --module PATH --orm NAME` writes them.
- The ORM is detected from `package.json` dependencies, not from what imported modules declare.
- `combined` builds are not available yet.
- Declared documents carry the inferred associations the contract's shared algorithm computes.
