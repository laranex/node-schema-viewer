"""Copy python-schema-viewer's MCP conformance recordings and record the exact response text its MCP server sends.

Read-only use of a python-schema-viewer checkout (laranex-schema 2.0, docs/mcp.md) and an environment with its `mcp`
extra:

    PYTHONPATH=<python-schema-viewer>/src python -B scripts/record-mcp-conformance.py <python-schema-viewer> [--check]

1. tests/fixtures/conformance/mcp/NAME.json: python-schema-viewer's tests/fixtures/mcp-conformance/NAME.json, copied
   byte for byte ({document, revision, calls}; each call {tool, arguments, result} or {tool, arguments, error}).
2. tests/fixtures/conformance/mcp-text/NAME.json: {pythonCommit, texts}, where texts[i] is the text content Python's
   MCP server returns over stdio, through the SDK client, for calls[i], and isError. Each call is sent end to end
   (`python -m laranex_schema_viewer mcp --snapshot ...`), so the text is what clients receive, byte for byte.

Writes only into this repository's tests/fixtures/conformance/. --check fails when a file would change.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from mcp import Client
from mcp.client.stdio import StdioServerParameters

NODE = Path(__file__).resolve().parents[1]
PYTHON = Path(sys.argv[1]).resolve()
SOURCE = PYTHON / "tests/fixtures/mcp-conformance"
RECORDINGS = NODE / "tests/fixtures/conformance/mcp"
TEXTS = NODE / "tests/fixtures/conformance/mcp-text"
CHECK = "--check" in sys.argv


def commit() -> str:
    head = subprocess.run(["git", "-C", str(PYTHON), "rev-parse", "HEAD"], capture_output=True, text=True, check=True)
    dirty = subprocess.run(["git", "-C", str(PYTHON), "status", "--porcelain", "src", "tests/fixtures/mcp-conformance"],
                           capture_output=True, text=True, check=True).stdout.strip()
    if dirty:
        raise SystemExit(f"{PYTHON} has uncommitted changes in src or its recordings; record from a commit")
    return head.stdout.strip()


async def texts(snapshot: Path, calls: list[dict]) -> list[dict]:
    params = StdioServerParameters(
        command=sys.executable, args=["-B", "-m", "laranex_schema_viewer", "mcp", "--snapshot", str(snapshot)],
        env={**{k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "HOME")},
             "PYTHONPATH": str(PYTHON / "src"), "PYTHONDONTWRITEBYTECODE": "1"},
    )
    out = []
    async with Client(params, read_timeout_seconds=30) as client:
        for call in calls:
            result = await client.call_tool(call["tool"], call["arguments"])
            assert len(result.content) == 1 and result.content[0].type == "text", call
            out.append({"isError": bool(result.is_error), "text": result.content[0].text})
    return out


def main() -> None:
    sha = commit()
    contract = PYTHON / "tests/fixtures/contract/fixtures/valid"
    expected: dict[Path, bytes] = {}
    for source in sorted(SOURCE.glob("*.json")):
        raw = source.read_bytes()
        recording = json.loads(raw)
        with tempfile.TemporaryDirectory() as tmp:
            if isinstance(recording["document"], str):
                snapshot = contract / Path(recording["document"]).name
            else:
                from laranex_schema_viewer.contract import canonical_json

                snapshot = Path(tmp) / "document.json"
                snapshot.write_text(canonical_json(recording["document"]), encoding="utf-8")
            sent = asyncio.run(texts(snapshot, recording["calls"]))
        expected[RECORDINGS / source.name] = raw
        expected[TEXTS / source.name] = (json.dumps({"pythonCommit": sha, "texts": sent}, ensure_ascii=False, indent=2,
                                                    sort_keys=True) + "\n").encode("utf-8")
    stale = [p for p, data in expected.items() if not p.is_file() or p.read_bytes() != data]
    extra = [p for d in (RECORDINGS, TEXTS) for p in d.glob("*.json") if p not in expected]
    if CHECK:
        if stale or extra:
            raise SystemExit("Stale MCP conformance files: " + ", ".join(str(p.relative_to(NODE)) for p in stale + extra))
        print(f"{len(expected) // 2} MCP conformance recordings are current (python-schema-viewer {sha[:7]})")
        return
    for path in extra:
        path.unlink()
    for path, data in expected.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"Recorded {len(expected) // 2} MCP conformance documents from python-schema-viewer {sha[:7]}")


if __name__ == "__main__":
    main()
