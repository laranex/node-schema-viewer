# Schema comparison

A comparison lists how one scope's schema differs from another's: two tenant schemas of one PostgreSQL database, a primary and a replica, or the same application on PostgreSQL and MySQL. `node-schema-viewer compare` computes comparisons on a saved [laranex-schema 2.x](https://laranex.github.io/schema-viewer-ui/contract#comparisons) document with the shared algorithm (`compareScopes` from `laranex-schema-viewer-ui`, the same one python-schema-viewer and laravel-schema-viewer use, checked against the shared conformance cases) and can store them in the document's `comparisons` array. The viewer and MCP display stored comparisons; they never compute them.

`compare` reads only the document and `package.json`: it never opens a database connection, runs SQL, starts a process or imports your application. The document must already hold what is compared, which means database (or combined) metadata read by an introspection, such as one `laranex-schema-viewer build --source database` wrote. This package has no `build` yet, so comparisons are not computed during a build here.

## Scopes

A scope is a connection, by name, and optionally a schema of it, spelled `CONNECTION` or `CONNECTION:SCHEMA` on the command line:

| Scope | Tables |
| --- | --- |
| `app:tenant_a` | The tables of schema `tenant_a` of connection `app` (and unqualified tables, if `tenant_a` is the connection's default schema) |
| `app` | The connection's unqualified tables and those in its default schema (PostgreSQL `public`, the MySQL database) |
| `app:*` (target only) | One comparison per schema the connection's inspection read (its coverage `schemas`, sorted), except the baseline's own scope |

Tables match by name, so a schema name is never part of a difference: `tenant_a.orders` and `tenant_b.orders` are the same table. A pair named explicitly takes precedence over the same pair from a `*` expansion, with its own `limit` and `overrides`.

Requests are resolved with the shared `expandComparisonRequests` ([requested comparisons](https://laranex.github.io/schema-viewer-ui/contract#requested-comparisons)). Each request it cannot resolve is an error, nothing is compared, and the message is the contract's:

| Error | Message |
| --- | --- |
| A connection the document does not have | `Requested comparison app → nope names connection nope, which the document does not have.` |
| A `*` target whose connection's coverage lists no schemas | `Requested comparison app → app:* cannot be expanded: the inspection of connection app lists no schemas.` |
| A `*` target with no schema left once the baseline's own scope is out | `Requested comparison app:public → app:* matches no schema.` |
| The same request (same names and schemas) more than once | `Requested comparison app:tenant_a → app:* is listed more than once.` |

## Configure comparisons

Comparisons are configured in the static `"node-schema-viewer"` key of `package.json` (JSON only; never JavaScript), by connection and schema names, never URLs:

```json
{
  "node-schema-viewer": {
    "output": "schema-viewer.json",
    "comparisons": [
      {
        "baseline": { "connection": "app", "schema": "tenant_template" },
        "target": { "connection": "app", "schema": "*" },
        "limit": 500,
        "overrides": [
          { "objectType": "index", "change": "extra", "severity": "info" },
          { "objectType": "column", "change": "changed", "field": "comment", "severity": "warning" }
        ]
      },
      { "baseline": { "connection": "primary" }, "target": { "connection": "replica" } }
    ]
  }
}
```

| Key | Meaning |
| --- | --- |
| `baseline` | `{ "connection", "schema" }`: a connection name and an optional schema (absent or `null`: the unqualified scope) |
| `target` | The same; `"schema": "*"` compares the baseline with every schema the target connection's inspection read |
| `limit` | Differences listed in the document, default **500**; the rest are counted in `summary` and `omitted`, and the comparison is incomplete. `0` keeps only the counts |
| `overrides` | Severities for `(objectType, change)`, or for one `field` of a `changed` difference. A field override wins over a general one, and a changed difference takes its most severe field |

`objectType` is `table`, `column`, `primaryKey`, `index`, `foreignKey` or `constraint`; `change` is `missing` (in the baseline only), `extra` (in the target only) or `changed`; `severity` is `error`, `warning` or `info`. A `field` applies only to `changed`, and two overrides for one `(objectType, change, field)` are an error. The fields each object type can list are the contract's (`DIFFERENCE_FIELDS`): `comment` (table); `collation`, `comment`, `default`, `enum`, `generated`, `nullable`, `type` (column); `columns` (primary key); `included`, `method`, `name`, `parts`, `predicate`, `unique` (index); `columns`, `deferrable`, `foreignColumns`, `foreignTable`, `initially`, `name`, `onDelete`, `onUpdate` (foreign key); `columns`, `expression`, `name` (constraint).

Overrides are checked with the shared `validateSeverityOverrides`, and its messages are reported after the entry's location, for example `package.json "node-schema-viewer" comparisons[0] overrides[1].field must be one of comment for objectType table` ([severity](https://laranex.github.io/schema-viewer-ui/contract#severity) lists them). Unknown keys, values and fields are errors, as are a baseline compared with itself, a `*` baseline, a negative or fractional limit, and anything that looks like a URL (a `scheme://` value, a schema with `@` or `//`, or a key such as `url` or `databaseUrl`); the error never repeats the value. These are python-schema-viewer's comparison rules, spelled in this package's camelCase JSON instead of its `pyproject.toml` TOML.

Default severities (the contract's):

| Object | missing / extra | changed |
| --- | --- | --- |
| table | error | info (`comment`) |
| column | error | warning; `comment`: info |
| primaryKey | error | error |
| index, foreignKey, constraint | warning | warning |

## Compare a saved document

```bash
npx node-schema-viewer compare 'app:tenant_template=app:*'
npx node-schema-viewer compare --snapshot /path/to/schema-viewer.json primary=replica --json
npx node-schema-viewer compare --write
```

| Option | Default | Purpose |
| --- | --- | --- |
| `BASELINE=TARGET` | The configured comparisons | Scopes to compare; repeatable. Replaces the configured comparisons, with the default severities |
| `--snapshot PATH` | Config `output`, else `schema-viewer.json` | The document to read |
| `--limit N` | `500` | Differences listed per comparison named on the command line (an error without one) |
| `--json` | Off | Print the comparison objects as canonical laranex-schema JSON instead of the summary |
| `--write` | Off | Store the comparisons in the document, strictly validated and atomically, replacing those of the same scopes (and their diagnostics) and keeping the others |

The summary has one line per comparison and one per listed difference, as python-schema-viewer prints it:

```text
app:tenant_template -> app:tenant_initech (complete): 3 missing, 2 extra, 5 changed
  error   certain missing table      tenant_template.audit_log
  warning certain changed column     tenant_template.orders.total  type "numeric(10,2)" -> "numeric(12,2)"
  warning likely  changed constraint tenant_template.orders.orders_total_check  expression "total >= 0::numeric" -> "total > 0::numeric"
```

`--write` rewrites only laranex-schema 2.0 documents, so nothing a newer 2.x minor added is lost, and prints `Stored N comparisons in PATH` (on stderr with `--json`). Comparisons are stored with the shared `storeComparisons`: an incomplete comparison gets a `comparison_incomplete` diagnostic (category `inspection`, severity `warning`, built by `comparisonDiagnostics`) that says why, for example `Comparison app:tenant_template=app:tenant_initech is incomplete: 9 of 10 differences are left out by the limit of 1` or `Comparison app:tenant_b=app:tenant_a is incomplete: the baseline app:tenant_b is not completely covered (checkConstraints unavailable); the target app:tenant_a is not completely covered (checkConstraints unavailable)`: how many differences the limit left out, then each side's [coverage gaps](https://laranex.github.io/schema-viewer-ui/contract#coverage-gaps). A complete comparison gets none. Storing the comparisons a document already holds leaves it unchanged.

`compare` exits 0 when it could compare, 1 on an error (any request error above, an unreadable or invalid document, invalid configuration, a document that cannot be written) and 2 on invalid usage. Writes are atomic: a failed write leaves the document as it was (see [security](./security.md#the-snapshot-only-commands-and-the-workers)). To fail CI on differences, use the [`check` drift gate](./check.md).

## Reading the result

Each comparison has `baseline`, `target`, a `summary` counting every difference found (`missing`, `extra`, `changed`), `omitted` (left out by the limit), `complete`, and its `differences` sorted by object type, key and change. Each difference has an `objectType`, a `change`, a `key` both sides share, `baseline` and `target` references with readable labels, the differing `fields` with both values, a `severity` and a `certainty`:

- **certain**: missing and extra entities, and changed fields compared exactly: same-driver types, nullability, primary keys, index uniqueness and parts, foreign keys and referential actions.
- **likely**: a changed field compared as normalized text, which can be wrong: types across drivers, defaults, generated expressions, index predicates, check expressions and expression index parts.

`complete` is false when differences were omitted, or when either side's coverage of a compared feature is not complete or did not read the scope's schema. It is never a passing result. See python-schema-viewer's [comparison accuracy notes](https://github.com/laranex/python-schema-viewer/blob/main/docs/comparison.md#accuracy-and-limits) for what cross-driver comparisons report.

## Conformance

`tests/contract.test.ts` runs the shared comparison, requested-comparison, coverage-gap, override, comparison-diagnostic and store conformance cases through `compareScopes`, `expandComparisonRequests`, `coverageGaps`/`scopeCovered`, `validateSeverityOverrides`, `comparisonDiagnostics` and `storeComparisons`, which `compare` and `check` call directly. `tests/parity.test.ts` runs `compare` (summary, `--json`, `--write`, configured comparisons with overrides) on four documents python-schema-viewer built from synthetic databases (tenant schemas, mixed drivers, an omitted comparison, tables named like schemas; `tests/fixtures/conformance/python-intel/`) and requires python-schema-viewer's exact output and written bytes, recorded with:

```bash
PYTHONPATH=<python-schema-viewer>/src python -B scripts/record-python-intel-conformance.py <python-schema-viewer> [--check]
```
