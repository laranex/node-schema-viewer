"""Record python-schema-viewer's MCP query responses for laranex-schema fixtures (read-only use of the Python package).

Run with cwd = python-schema-viewer:  python -B record_conformance.py <ui-fixtures-dir> <extra-fixtures-dir> <node-repo>
Writes only into <node-repo>/tests/fixtures/conformance/.
"""

import copy
import json
import shutil
import sys
from pathlib import Path

import pydantic_core

from laranex_schema_viewer.contract import assert_document, canonical_json, revision
from laranex_schema_viewer.query import SnapshotQuery

UI, EXTRA, NODE = (Path(p) for p in sys.argv[1:4])
DOCS = NODE / "tests/fixtures/conformance/documents"
OUT = NODE / "tests/fixtures/conformance/mcp"
SECTIONS = ["columns", "indexes", "foreign_keys", "constraints", "models", "relationships"]


def synthetic_large(base: dict) -> dict:
    """Many long, non-ASCII column comments: pagination stops at the 64 KiB cap, counted as Python counts bytes."""
    doc = copy.deepcopy(base)
    table = doc["connections"][0]["tables"][0]
    template = table["columns"][0]
    for n in range(240):
        column = copy.deepcopy(template)
        column["name"] = f"wide_{n:03d}"
        column["comment"] = f"Spalte {n} – größe ✓ " + "ü" * 200 + " \"quoted\" \\ end"
        table["columns"].append(column)
    doc["generator"] = {"name": "node-schema-viewer-conformance", "orm": None}
    return assert_document(doc, strict=True).to_json()


def lenient_future(base: dict) -> dict:
    """A later 1.x minor with properties this version does not define: readers ignore them."""
    doc = copy.deepcopy(base)
    doc["version"] = "1.7"
    doc["futureTopLevel"] = {"x": 1}
    connection = doc["connections"][0]
    connection["futureConnection"] = True
    connection["coverage"]["database"]["futureCoverage"] = "x"
    for table in connection["tables"]:
        table["owner"]["futureOwner"] = 1
        for column in table["columns"]:
            column["futureColumn"] = "c"
            for drift in column.get("drift") or []:
                drift["futureDrift"] = 2
        for index in table["indexes"]:
            for part in index["parts"]:
                part["futurePart"] = None
            if index["backs"]:
                index["backs"]["futureBacks"] = 3
    for model in doc["models"]:
        if model["source"]:
            model["source"]["futureSource"] = 4
    for relationship in doc["relationships"]:
        relationship["futureRelationship"] = []
    assert_document(doc)  # lenient
    return doc


def calls(query: SnapshotQuery) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = [
        ("schema_overview", {}), ("schema_overview", {"limit": 100}),
        ("schema_overview", {"limit": 2, "offset": 1}), ("schema_overview", {"limit": 1, "offset": 10_000}),
        ("schema_overview", {"revision": query.revision}),
    ]
    terms = ["id", "ID", "order", "user", "e", "MANYTOONE", "one", "zzz", "default.", "ß", "_"]
    terms += sorted({t["name"] for t in query.view["tables"]})[:3]
    for text in terms:
        out.append(("schema_search", {"query_text": text, "limit": 100}))
    out.append(("schema_search", {"query_text": "e", "limit": 3, "offset": 2}))
    for table in query.tables:
        out.append(("schema_get_table", {"table": table}))
        for section in SECTIONS:
            out.append(("schema_get_table", {"table": table, "section": section, "limit": 100}))
        out.append(("schema_get_table", {"table": table, "section": "columns", "limit": 1, "offset": 1}))
        for kind in ("orm", "foreign_key"):
            out.append(("schema_get_relationships", {"table": table, "kind": kind, "limit": 100}))
    for model in query.models:
        out.append(("schema_get_model", {"model": model}))
        out.append(("schema_get_model", {"model": model, "limit": 1}))
    for kind in ("orm", "foreign_key"):
        out.append(("schema_get_relationships", {"kind": kind, "limit": 100}))
        out.append(("schema_get_relationships", {"kind": kind, "limit": 2, "offset": 1}))
    out.append(("schema_get_relationships", {}))
    # Tool errors raised by the query layer (the MCP layer prefixes "Error executing tool <name>: ").
    first = next(iter(query.tables), "table:none")
    out += [
        ("schema_get_table", {"table": "table:does-not-exist"}),
        ("schema_get_model", {"model": "model:does-not-exist"}),
        ("schema_get_relationships", {"table": "table:does-not-exist"}),
        ("schema_overview", {"revision": "0" * 64}),
        ("schema_search", {"query_text": "x" * 201}),
        ("schema_get_table", {"table": first, "section": "rows"}),
        ("schema_get_relationships", {"kind": "both"}),
    ]
    return out


def invoke(query: SnapshotQuery, tool: str, args: dict) -> dict:
    a = dict(args)
    pagination = {k: a.pop(k) for k in ("limit", "offset", "revision") if k in a}
    if tool == "schema_overview":
        return query.overview(**pagination)
    if tool == "schema_search":
        return query.search(a["query_text"], **pagination)
    if tool == "schema_get_table":
        return query.get_table(a["table"], a.get("section", "columns"), **pagination)
    if tool == "schema_get_model":
        return query.get_model(a["model"], **pagination)
    return query.relationships(a.get("table"), a.get("kind", "orm"), **pagination)


def main() -> None:
    if DOCS.exists():
        shutil.rmtree(DOCS)
    if OUT.exists():
        shutil.rmtree(OUT)
    DOCS.mkdir(parents=True)
    OUT.mkdir(parents=True)
    sources = sorted(UI.glob("*.json")) + sorted(EXTRA.glob("*.json"))
    for path in sources:
        shutil.copyfile(path, DOCS / path.name)
    declared = json.loads((UI / "declared-sqlalchemy.json").read_text())
    (DOCS / "synthetic-large.json").write_text(canonical_json(synthetic_large(declared)))
    drift = json.loads((UI / "combined-drift.json").read_text())
    (DOCS / "lenient-future-minor.json").write_text(json.dumps(lenient_future(drift), indent=2) + "\n")

    total = 0
    for path in sorted(DOCS.glob("*.json")):
        query = SnapshotQuery(path)
        raw = json.loads(path.read_text())
        records = []
        for tool, args in calls(query):
            try:
                result = invoke(query, tool, args)
                records.append({"tool": tool, "arguments": args, "response": result,
                                "text": pydantic_core.to_json(result, fallback=str, indent=2).decode()})
            except ValueError as error:
                records.append({"tool": tool, "arguments": args, "error": str(error)})
        expected = {
            "document": path.name,
            "python_revision": query.revision,
            "raw_revision": revision(raw),
            "view": query.view,
            "calls": records,
        }
        (OUT / path.name).write_text(json.dumps(expected, indent=1, ensure_ascii=False) + "\n")
        total += len(records)
        print(f"{path.name}: {len(records)} calls, revision {query.revision[:12]}")
    print(f"total {total}")


main()
