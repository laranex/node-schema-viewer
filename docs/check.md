# Schema drift gate in CI

`node-schema-viewer check` fails a CI job when a saved laranex-schema document shows schema drift. It reads only the document (and `package.json`): it never connects to a database, imports application code, starts a process, runs migrations or rewrites the document. It checks the [comparisons](./comparison.md) stored in the document, for example by a `build --source database` of this package, python-schema-viewer or laravel-schema-viewer, or comparisons it computes in memory from the document's inspected metadata.

```bash
npx node-schema-viewer check                       # exit 0, 1 or 2
npx node-schema-viewer check --output gate-report.json
npx node-schema-viewer check 'app:tenant_template=app:*' --severity error
```

## What is checked

The command is a thin layer over `gateDocument` from `laranex-schema-viewer-ui`, the shared reference gate: the [gate report](https://laranex.github.io/schema-viewer-ui/contract#gate-reports) rules are normative, and the 23 shared gate conformance cases give byte-identical reports both through `gateDocument` and through `check --json` (`tests/parity.test.ts`). The gate validates the document itself (2.0 strictly, a newer 2.x leniently), so a missing, unreadable or invalid snapshot still gets a report.

These are **findings**, each with a severity and a certainty:

| Source | Finding | Severity, certainty |
| --- | --- | --- |
| `comparison` | Every listed difference of every checked comparison, kind `<object_type>_<change>` (`column_changed`, `primary_key_missing`) | The difference's own (see [severity](./comparison.md#configure-comparisons)) |
| `diagnostic` | Every diagnostic of category `drift` or `reconciliation` | The diagnostic's own |
| `migration` | A migration track `behind`, `diverged` or `uninitialized`, kind `migration_<status>` | `behind` and `diverged` error, `uninitialized` warning; certain |

Nothing else is a finding: `extraction`, `lint` and `inspection` diagnostics never fail the gate, whatever the thresholds.

These are **errors**: the check could not be completed, and the gate exits 2 whatever the findings.

| Error | When |
| --- | --- |
| `invalid_document` | The snapshot is missing, unreadable, larger than 32 MiB or not JSON (`The input could not be parsed as JSON.`), not a laranex-schema document, not 2.x, or fails validation. The report then has no other error and no findings; the reason (the file error or the first five validation errors) is printed on stderr, never in the report |
| `validation_incomplete` | A newer laranex-schema 2.x minor, validated only leniently |
| `comparison_not_found` | A requested comparison names a connection the document does not have, has a `*` target that expands to no schema, or is not stored in the document |
| `comparison_incomplete` | A checked comparison is incomplete: differences were omitted by its limit, or a side's inspection did not cover a compared feature or its schema |
| `coverage_incomplete` | In a `database` or `combined` document, a connection whose database inspection read `tables` or `columns` other than completely, or left any feature `unavailable` |
| `inspection_failed` | An `inspection` diagnostic with severity `error` |
| `migration_unknown` | A migration track's status is `unknown` |

## Which comparisons are checked

| Command | Requested comparisons | Checked |
| --- | --- | --- |
| `check` without configured `comparisons` | None | Every stored comparison; zero comparisons pass |
| `check` with configured `comparisons` | The configured entries, as written (connection names, `*` targets unexpanded) | Only those, which must be stored in the document; others in the document are ignored |
| `check BASELINE=TARGET ...` | The named comparisons, replacing the configured ones | Only those, computed in memory first |

A target schema `*` is expanded by the gate to every schema the target connection's inspection read except the baseline's own scope, exactly as `compare` expands it. A request that cannot be resolved is a `comparison_not_found` error (exit 2). A comparison configured or named twice is a configuration or usage error, rejected before the snapshot is read (exit 2, no report, nothing on stdout): `Error: Requested comparison app:tenant_a → app:tenant_b is listed more than once.` on stderr, as the contract requires of producers (the gate itself would drop the duplicate silently).

Comparisons named on the command line are computed from the saved document as [`compare`](./comparison.md#compare-a-saved-document) computes them (replacing a stored comparison of the same scopes, with `--limit`), and then requested, so the gate checks exactly what was computed. Nothing is written. Both use the shared `expandComparisonRequests`: a named comparison whose connection is unknown, or whose `*` cannot be expanded or matches no schema, is not computed and is reported by the gate as `comparison_not_found` with the contract's message; the same comparison named twice is the duplicate error above; on an invalid document nothing is computed.

## Thresholds

A finding **qualifies** (fails the check) when its severity is at least the severity threshold and, with certainty `certain`, it is certain; with `likely`, likely findings qualify too.

| Setting | Flag | `"check"` key | Default |
| --- | --- | --- | --- |
| Lowest failing severity: `error`, `warning`, `info` | `--severity` | `severity` | `warning` |
| `certain` (only certain findings fail) or `likely` | `--certainty` | `certainty` | `certain` |

```json
{
  "node-schema-viewer": {
    "check": { "severity": "error", "certainty": "likely" }
  }
}
```

Flags take precedence over the configuration, which takes precedence over the shared defaults (`DEFAULT_THRESHOLDS`). `"check"` accepts only these two keys; anything else, or another value, is a configuration error (exit 2).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Passed: no error and no qualifying finding (findings below the thresholds are still listed) |
| `1` | Drift: at least one finding qualifies, and nothing kept the check from completing |
| `2` | Incomplete or invalid: any error above (it wins over `1`), or, without a report, invalid arguments, invalid configuration, a comparison configured or named twice, a failure writing `--output`, or any unexpected error |

Nothing on a failure path exits 0 or 1.

## Options

| Option | Default |
| --- | --- |
| `BASELINE=TARGET` | The configured comparisons, else every stored one. Each named comparison is computed in memory, then checked; repeatable |
| `--snapshot PATH` | Config `output`, else `schema-viewer.json` |
| `--severity`, `--certainty` | See [thresholds](#thresholds) |
| `--limit N` | `500`, for comparisons named on the command line (an error without one) |
| `--json` | Print the `laranex-schema-gate` 1.0 report instead of the summary |
| `--output FILE` | Also write the JSON report to `FILE`, atomically |

## Output

The default output is a plain-text summary: the verdict and exit code, how many comparisons were checked and which were requested, the errors, and the qualifying findings (most severe first), each with its id. It has no colors, timestamps or absolute paths, so identical inputs print identical bytes, and it is the same text python-schema-viewer's `check` prints:

```text
Schema check FAILED (exit code 1): 8 of 13 findings meet the thresholds (severity warning or above, certain only)
Checked 4 comparisons (every stored one)
Findings that meet the thresholds, most severe first:
  error   certain comparison table_extra  app:tenant_template → app:tenant_initech · tenant_initech.coupons: Only in the target [xdd8277c26188c626]
  error   certain comparison table_missing  app:tenant_template → app:tenant_initech · tenant_template.audit_log: Only in the baseline [xeecedbfce27359f5]
  warning certain comparison column_changed  app:tenant_template → app:tenant_globex · tenant_template.users.email: Differs in type [x124a228e350d0e68]
  warning certain comparison foreign_key_changed  app:tenant_template → app:tenant_initech · tenant_template.orders.orders_user_id_fkey: Differs in onDelete [x9e03cf9976b662a0]
  ...
5 findings below the thresholds are listed in the JSON report (--json or --output)
```

`--json` prints the report in canonical JSON (sorted keys, two-space indentation, a final newline); it validates strictly against the shared gate report schema (`validateGateReport`, `laranex-schema-viewer-ui/contract/gate-report.schema.json`) and is byte-identical to python-schema-viewer's report for the same document, requests and thresholds:

```json
{
  "comparisons": ["c69f5b58e94575f1b"],
  "counts": { "error": 13, "findings": 26, "info": 1, "qualifying": 23, "warning": 12 },
  "errors": [],
  "exitCode": 1,
  "findings": [
    {
      "certainty": "certain",
      "id": "x62b27f513574b3a0",
      "kind": "column_missing",
      "label": "app:tenant_a → app:tenant_b · tenant_a.users.legacy_code",
      "message": "Only in the baseline",
      "severity": "error",
      "source": "comparison"
    }
  ],
  "format": "laranex-schema-gate",
  "passed": false,
  "requested": [],
  "thresholds": { "certainty": "certain", "severity": "warning" },
  "version": "1.0"
}
```

(Shortened.) `requested` lists the requested comparisons, sorted, and `comparisons` the ids of the stored comparisons that were checked. `--output gate-report.json` keeps the report as a CI artifact while the log shows the summary. Notes (why a snapshot could not be read, validator errors) go to stderr only.

## GitHub Actions

Gate a document committed to the repository, or one an earlier step built with a producer that inspects databases (`node-schema-viewer build --source database`, or python-schema-viewer's or laravel-schema-viewer's). `check` itself needs no database and no secrets.

```json
{
  "devDependencies": { "node-schema-viewer": "0.1.0" },
  "node-schema-viewer": {
    "output": "schema-viewer.json",
    "comparisons": [
      { "baseline": { "connection": "app", "schema": "tenant_template" }, "target": { "connection": "app", "schema": "*" } }
    ],
    "check": { "severity": "warning", "certainty": "certain" }
  }
}
```

```yaml
name: schema
on: [pull_request]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - name: Schema drift gate
        run: npx node-schema-viewer check --output gate-report.json
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: schema
          path: |
            schema-viewer.json
            gate-report.json
```

The job fails on exit 1 (drift) and on exit 2 (an incomplete or invalid check). With configured comparisons, the document must store them: compute them once with `npx node-schema-viewer compare --write` (or let the producer's build store them), or name them on the command line (`check 'app:tenant_template=app:*'`) to have `check` compute them in memory on every run.

## Security

`check` and `compare` read the snapshot (at most 32 MiB) and `package.json` and nothing else. `tests/gate-security.test.ts` runs both under the Node.js Permission Model with reads limited to this package's code, the contract package, the project's `package.json` and the snapshot, without network, child-process, worker or addon permissions, and with a preloaded sentinel that fails every network, DNS and child-process call (the Permission Model restricts the network only from Node.js 25 on); the results are identical to an unrestricted run. Loading a database driver, the MCP SDK or any project file would be refused. `compare --write` and `check --output` run under the Permission Model too, with writes granted only to the output's directory; see [security](./security.md#the-snapshot-only-commands-and-the-workers) for atomic writes and `fsync` under the Permission Model.
