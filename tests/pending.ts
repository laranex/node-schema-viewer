// Tests pending until the MCP responses are redesigned for laranex-schema 2.0 (python-schema-viewer is doing it; this
// package ports them byte for byte in phase 2). tests/fixtures/conformance/mcp/*.json are Python's responses for the
// laranex-schema 1.0 documents in tests/fixtures/conformance/documents/, which a 2.0 reader rejects, so the recorded
// query and MCP conformance cases cannot run until both are re-recorded from python-schema-viewer's 2.0 output.
// This is the only skip list; each entry is a recorded document, and both suites skip it.
export const PENDING_MCP_CONFORMANCE: ReadonlySet<string> = new Set([
    'combined-drift.json',
    'combined-eloquent.json',
    'combined-multi-connection.json',
    'database-mysql-indexes.json',
    'database-postgresql-indexes.json',
    'database-sqlite-indexes.json',
    'declared-multi-connection.json',
    'declared-sqlalchemy.json',
    'lenient-future-minor.json',
    'synthetic-large.json',
]);

export function pendingMcp(name: string): string | false {
    return PENDING_MCP_CONFORMANCE.has(name) ? 'pending: MCP responses for laranex-schema 2.0 are re-recorded from python-schema-viewer in phase 2' : false;
}
