// Read-only MCP tools over stdio (official TypeScript SDK, v2). Only the configured, pinned snapshot is accessible.
// A port of python-schema-viewer's mcp.py: the same tools, arguments, annotations, descriptions and response text.
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { QueryError, SnapshotQuery, type Page, type Pagination } from './query.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'Laranex Schema Viewer';
export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const limit = z.number().int().min(1).max(100).default(25);
const offset = z.number().int().min(0).default(0);
const revision = z.string().nullable().default(null);
const SECTIONS = ['columns', 'indexes', 'foreign_keys', 'constraints', 'models', 'relationships'] as const;

// The same text as the Python SDK writes for a dict result (two-space JSON, key order kept, nothing escaped that need
// not be), and the same "Error executing tool" prefix for query errors.
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
            description: 'Schema counts and paginated table IDs. Reads a pinned saved snapshot only.',
            inputSchema: z.object({ limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_overview', () => query.overview(paging(args))),
    );
    server.registerTool(
        'schema_search',
        {
            description: 'Literal substring search of table, column, model and declared relationship names.',
            inputSchema: z.object({ query_text: z.string(), limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_search', () => query.search(args.query_text, paging(args))),
    );
    server.registerTool(
        'schema_get_table',
        {
            description: 'Read a table section using its exact opaque ID from overview/search.',
            inputSchema: z.object({ table: z.string(), section: z.enum(SECTIONS).default('columns'), limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_get_table', () => query.getTable(args.table, args.section, paging(args))),
    );
    server.registerTool(
        'schema_get_model',
        {
            description: 'Read model metadata and its paginated declared ORM relationships by exact model ID.',
            inputSchema: z.object({ model: z.string(), limit, offset, revision }),
            annotations: ANNOTATIONS,
        },
        (args) => respond('schema_get_model', () => query.getModel(args.model, paging(args))),
    );
    server.registerTool(
        'schema_get_relationships',
        {
            description: 'Read declared ORM relationships or physical foreign keys as separate collections.',
            inputSchema: z.object({
                table: z.string().nullable().default(null),
                kind: z.enum(['orm', 'foreign_key']).default('orm'),
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
            process.stderr.write(`laranex-schema-viewer mcp: ${error.message}\n`);
        },
    });
}
