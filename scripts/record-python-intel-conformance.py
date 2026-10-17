"""Record python-schema-viewer's `compare` and `check` output for the documents in tests/fixtures/conformance/python-intel/.

Read-only use of a python-schema-viewer checkout (and an environment that can run it; no database is needed):

    PYTHONPATH=<python-schema-viewer>/src python -B scripts/record-python-intel-conformance.py <python-schema-viewer> [--check]

The documents in python-intel/documents/ are laranex-schema 2.0 documents python-schema-viewer built from synthetic
databases (tenant schemas, mixed drivers, an omitted comparison, tables named like schemas), copied byte for byte.
For every case below, the document is copied to schema-viewer.json in an empty temporary directory, with a
pyproject.toml holding the case's configuration (given here in this package's camelCase JSON form), and
`python -m laranex_schema_viewer ARGS` runs there. python-intel/cli.json records {pythonCommit, cases}: per case the
document, configuration, arguments, exit code, stdout and, for --write, the SHA-256 of the rewritten document.
tests/parity.test.ts runs node-schema-viewer the same way (configuration in package.json) and requires the same bytes.

Writes only python-intel/cli.json in this repository. --check fails when it would change.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

NODE = Path(__file__).resolve().parents[1]
PYTHON = Path(sys.argv[1]).resolve()
DIRECTORY = NODE / "tests/fixtures/conformance/python-intel"
OUT = DIRECTORY / "cli.json"
CHECK = "--check" in sys.argv

TENANTS = {"baseline": {"connection": "app", "schema": "tenant_template"}, "target": {"connection": "app", "schema": "*"}}
OVERRIDES = [
    {"objectType": "index", "change": "extra", "severity": "info"},
    {"objectType": "column", "change": "changed", "field": "comment", "severity": "warning"},
]

# (document, configuration, arguments)
CASES = [
    ("mixed-drivers", {}, ["check", "--json"]),
    ("mixed-drivers", {}, ["check"]),
    ("mixed-drivers", {}, ["check", "--json", "--severity", "info", "--certainty", "likely"]),
    ("mixed-drivers", {}, ["check", "--json", "primary=mysql", "--limit", "5"]),
    ("mixed-drivers", {"comparisons": [{"baseline": {"connection": "primary"}, "target": {"connection": "mysql"}}],
                       "check": {"severity": "error"}}, ["check", "--json"]),
    ("mixed-drivers", {}, ["compare", "--json", "primary=mysql"]),
    ("mixed-drivers", {}, ["compare", "mysql=mariadb"]),
    ("mixed-drivers", {}, ["compare", "--json", "primary=mariadb", "--limit", "3"]),
    ("mixed-drivers", {}, ["compare", "--write", "--json", "primary=mariadb", "--limit", "3"]),
    ("postgresql-multi-tenant", {}, ["check", "--json"]),
    ("postgresql-multi-tenant", {}, ["check"]),
    ("postgresql-multi-tenant", {}, ["check", "--json", "app:tenant_template=app:*"]),
    ("postgresql-multi-tenant", {}, ["check", "app:tenant_template=app:*", "app:tenant_template=app:tenant_acme",
                                     "--certainty", "likely"]),
    ("postgresql-multi-tenant", {"comparisons": [TENANTS], "check": {"certainty": "likely"}}, ["check", "--json"]),
    ("postgresql-multi-tenant", {"comparisons": [TENANTS]}, ["check", "--severity", "info"]),
    ("postgresql-multi-tenant", {}, ["compare", "--json", "app:tenant_template=app:*"]),
    ("postgresql-multi-tenant", {}, ["compare", "app:tenant_template=app:tenant_acme"]),
    ("postgresql-multi-tenant", {"comparisons": [{**TENANTS, "limit": 4, "overrides": OVERRIDES}]}, ["compare", "--json"]),
    ("postgresql-multi-tenant", {"comparisons": [{**TENANTS, "limit": 4, "overrides": OVERRIDES}]}, ["compare", "--write"]),
    ("postgresql-omitted", {}, ["check", "--json"]),
    ("postgresql-omitted", {}, ["check"]),
    ("postgresql-omitted", {}, ["check", "--json", "app:tenant_template=app:tenant_initech", "--limit", "0"]),
    ("postgresql-omitted", {}, ["compare", "--json", "app:tenant_template=app:tenant_initech", "--limit", "2"]),
    ("postgresql-omitted", {}, ["compare", "app:tenant_template=app:tenant_initech", "--limit", "2"]),
    ("postgresql-omitted", {}, ["compare", "--write", "app:tenant_template=app:tenant_initech", "--limit", "1"]),
    ("postgresql-schema-named-tables", {}, ["check", "--json"]),
    ("postgresql-schema-named-tables", {}, ["check", "--json", "ledger:billing=ledger:*"]),
    ("postgresql-schema-named-tables", {}, ["compare", "--json", "ledger:billing=ledger:*"]),
    ("postgresql-schema-named-tables", {}, ["compare", "ledger:archive=ledger:billing"]),
]


def toml_value(value: object) -> str:
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{toml_key(k)} = {toml_value(v)}" for k, v in value.items()) + " }"
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    return json.dumps(value)


def toml_key(key: str) -> str:
    # This package's camelCase keys, as python-schema-viewer spells them.
    return {"objectType": "object_type"}.get(key, key)


def pyproject(config: dict) -> str:
    lines = ["[tool.laranex-schema-viewer]"]
    for entry in config.get("comparisons", []):
        lines += ["", "[[tool.laranex-schema-viewer.comparisons]]"]
        lines += [f"{toml_key(k)} = {toml_value(v)}" for k, v in entry.items()]
    if "check" in config:
        lines += ["", "[tool.laranex-schema-viewer.check]"]
        lines += [f"{k} = {toml_value(v)}" for k, v in config["check"].items()]
    return "\n".join(lines) + "\n"


def commit() -> str:
    head = subprocess.run(["git", "-C", str(PYTHON), "rev-parse", "HEAD"], capture_output=True, text=True, check=True)
    dirty = subprocess.run(["git", "-C", str(PYTHON), "status", "--porcelain", "src"], capture_output=True, text=True,
                           check=True).stdout.strip()
    if dirty:
        raise SystemExit(f"{PYTHON} has uncommitted changes in src; record from a commit")
    return head.stdout.strip()


def run(document: str, config: dict, args: list[str]) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        cwd = Path(tmp)
        snapshot = cwd / "schema-viewer.json"
        shutil.copyfile(DIRECTORY / "documents" / f"{document}.json", snapshot)
        (cwd / "pyproject.toml").write_text(pyproject(config), encoding="utf-8")
        result = subprocess.run([sys.executable, "-B", "-m", "laranex_schema_viewer", *args], cwd=cwd,
                                capture_output=True, env={"PYTHONPATH": str(PYTHON / "src"), "PATH": "/usr/bin:/bin",
                                                          "PYTHONDONTWRITEBYTECODE": "1", "LANG": "C.UTF-8"})
        if result.returncode not in (0, 1, 2) or (result.returncode != 0 and not result.stdout):
            raise SystemExit(f"{document} {args}: exit {result.returncode}: {result.stderr.decode()}")
        case = {"document": document, "config": config, "args": args, "exitCode": result.returncode,
                "stdout": result.stdout.decode("utf-8")}
        if "--write" in args:
            case["written"] = hashlib.sha256(snapshot.read_bytes()).hexdigest()
        return case


def main() -> None:
    data = {"pythonCommit": commit(), "cases": [run(*case) for case in CASES]}
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if CHECK:
        if not OUT.is_file() or OUT.read_text(encoding="utf-8") != text:
            raise SystemExit(f"Stale {OUT.relative_to(NODE)}")
        print(f"{len(CASES)} python-intel CLI recordings are current (python-schema-viewer {data['pythonCommit'][:7]})")
        return
    OUT.write_text(text, encoding="utf-8")
    print(f"Recorded {len(CASES)} python-intel CLI cases from python-schema-viewer {data['pythonCommit'][:7]}")


if __name__ == "__main__":
    main()
