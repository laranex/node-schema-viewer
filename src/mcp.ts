// Read-only MCP tools over stdio (official TypeScript SDK, v2). Only the configured, pinned snapshot is accessible.
// A port of python-schema-viewer's mcp.py: the same tools, arguments, annotations, descriptions and response text
// (the response format is python-schema-viewer's docs/mcp.md; query.ts implements it).
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { KINDS, QueryError, SECTIONS, SnapshotQuery, type Page, type Pagination } from './query.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'Laranex Schema Viewer';
export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const limit = z.number().int().min(1).max(100).default(25);
const offset = z.number().int().min(0).default(0);
const revision = z.string().nullable().default(null);

// The same text as the Python SDK writes for a dict result (pydantic_core.to_json with indent=2: two-space JSON, key
// order kept, non-ASCII unescaped), and its "Error executing tool NAME: " prefix for query errors.
function respond(name: string, run: () => Page): CallToolResult {
    try {
        return { content: [{ type: 'text', text: JSON.stringify(run(), null, 2) }] };
    } catch (error) {
        if (error instanceof QueryError) {
            return { isError: true, content: [{ type: 'text', text: `Error executing tool ${name}: ${error.message}` }] };
        }
        throw error;
    }
}

const paging = (args: { limit: number; offset: number; revision: string | null }): Pagination => ({
    limit: args.limit,
    offset: args.offset,
    revision: args.revision,
});

export function createMcpServer(query: SnapshotQuery): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });

    server.registerTool(
        'schema_overview',
        {
            description: 'Document source, connections with coverage, counts, and paginated table summaries with opaque IDs.',
            inputSchema: z.object({ limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_overview', () => query.overview(paging(args))),
    );
    server.registerTool(
        'schema_search',
        {
            description:
                'Literal case-insensitive search of table, column, index, foreign key, constraint, model and relationship\nnames; returns hits with opaque IDs.',
            inputSchema: z.object({ query_text: z.string(), limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_search', () => query.search(args.query_text, paging(args))),
    );
    server.registerTool(
        'schema_get_table',
        {
            description: "Read one section of a table, as the document's own objects, by the table's exact opaque ID.",
            inputSchema: z.object({ table: z.string(), section: z.enum(SECTIONS).default('columns'), limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_get_table', () => query.getTable(args.table, args.section, paging(args))),
    );
    server.registerTool(
        'schema_get_model',
        {
            description: 'Read a model and the ORM relationships it declares, by exact model ID.',
            inputSchema: z.object({ model: z.string(), limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_get_model', () => query.getModel(args.model, paging(args))),
    );
    server.registerTool(
        'schema_get_relationships',
        {
            description: 'Read declared ORM relationships (kind orm) or physical foreign keys (kind foreign_key), never mixed.',
            inputSchema: z.object({
                table: z.string().nullable().default(null),
                kind: z.enum(KINDS).default('orm'),
                limit,
                offset,
                revision,
            }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_get_relationships', () => query.relationships(args.table, args.kind, paging(args))),
    );
    return server;
}

// Validates and pins the snapshot before reading stdin: a missing, invalid or oversized snapshot fails startup.
export function runStdio(snapshot: string): StdioServerHandle {
    const query = SnapshotQuery.fromFile(snapshot);
    return serveStdio(() => createMcpServer(query), {
        onerror: (error) => {
            process.stderr.write(`node-schema-viewer mcp: ${error.message}\n`);
        },
    });
}
