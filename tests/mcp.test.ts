import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CLI, COMBINED, DECLARED, recordings, runCli, schemaRejected, scratchDir, tempDir } from './helpers.js';

const SECTIONS = ['columns', 'indexes', 'foreign_keys', 'constraints', 'models', 'relationships', 'links', 'derived_links', 'diagnostics'];
// python-schema-viewer's tool descriptions, as its MCP server lists them.
const DESCRIPTIONS: Record<string, string> = {
    schema_overview: 'Document source, connections with coverage, counts, and paginated table summaries with opaque IDs.',
    schema_search: 'Literal case-insensitive search of table, column, index, foreign key, constraint, model and relationship\nnames; returns hits with opaque IDs.',
    schema_get_table: "Read one section of a table, as the document's own objects, by the table's exact opaque ID.",
    schema_get_model: 'Read a model and the ORM relationships it declares, by exact model ID.',
    schema_get_relationships: 'Read declared ORM relationships (kind orm) or physical foreign keys (kind foreign_key), never mixed.',
    schema_compare:
        'Read the schema comparisons stored in the document (section comparisons) or their differences (section\ndifferences), by comparison ID or by baseline/target scope (CONNECTION or CONNECTION:SCHEMA), and filter\ndifferences by object_type, change, severity and certainty. Never computes or connects.',
};
const TOOLS = ['schema_compare', 'schema_get_model', 'schema_get_relationships', 'schema_get_table', 'schema_overview', 'schema_search'];

interface Text {
    type: string;
    text: string;
}

async function connect(snapshot: string): Promise<{ client: Client; transport: StdioClientTransport; stderr: () => string }> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--snapshot', snapshot], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'node-schema-viewer-tests', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport, stderr: () => stderr };
}

function text(result: { content?: unknown }): string {
    const content = result.content as Text[];
    assert.equal(content.length, 1);
    assert.equal(content[0]?.type, 'text');
    return content[0].text;
}

describe('mcp over stdio', () => {
    let session: Awaited<ReturnType<typeof connect>>;

    before(async () => {
        session = await connect(COMBINED);
    });
    after(async () => {
        await session.client.close();
    });

    test('lists the six read-only tools with Python-compatible inputs', async () => {
        const { tools } = await session.client.listTools();
        assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
        for (const tool of tools) {
            assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, tool.name);
            assert.equal(tool.description, DESCRIPTIONS[tool.name]);
            assert.equal(tool.outputSchema, undefined);
            const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
            assert.equal(properties.limit?.minimum, 1);
            assert.equal(properties.limit.maximum, 100);
            assert.equal(properties.limit.default, 25);
            assert.equal(properties.offset?.minimum, 0);
            assert.equal(properties.offset.default, 0);
            assert.ok(properties.revision);
        }
        const byName = new Map(tools.map((t) => [t.name, t]));
        assert.deepEqual(byName.get('schema_search')?.inputSchema.required, ['query_text']);
        assert.deepEqual(byName.get('schema_get_table')?.inputSchema.required, ['table']);
        assert.deepEqual(byName.get('schema_get_model')?.inputSchema.required, ['model']);
        assert.deepEqual(byName.get('schema_get_relationships')?.inputSchema.required ?? [], []);
        const section = (byName.get('schema_get_table')?.inputSchema.properties as Record<string, { enum?: string[] }>).section;
        assert.deepEqual(section?.enum, SECTIONS);
        const compare = byName.get('schema_compare')?.inputSchema;
        assert.deepEqual(compare?.required ?? [], []);
        assert.deepEqual(Object.keys(compare?.properties ?? {}), ['section', 'comparison', 'baseline', 'target', 'object_type', 'change', 'severity', 'certainty', 'limit', 'offset', 'revision']);
    });

    test('rejects invalid arguments as tool errors', async () => {
        const invalid: [string, Record<string, unknown>][] = [
            ['schema_overview', { limit: 0 }],
            ['schema_overview', { limit: 101 }],
            ['schema_overview', { limit: 2.5 }],
            ['schema_overview', { limit: '5' }],
            ['schema_overview', { offset: -1 }],
            ['schema_search', {}],
            ['schema_search', { query_text: 3 }],
            ['schema_get_table', {}],
            ['schema_get_table', { table: 'x', section: 'rows' }],
            ['schema_get_model', {}],
            ['schema_get_relationships', { kind: 'both' }],
            ['schema_compare', { section: 'tables' }],
            ['schema_compare', { section: 'differences', object_type: 'view' }],
            ['schema_compare', { section: 'differences', severity: 'fatal' }],
        ];
        for (const [name, args] of invalid) {
            const result = await session.client.callTool({ name, arguments: args }).catch((error: unknown) => ({ isError: true, thrown: error }));
            assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
        }
        const unknown = await session.client.callTool({ name: 'schema_get_table', arguments: { table: 'table:../../etc/passwd' } });
        assert.equal(unknown.isError, true);
        assert.match(text(unknown), /Unknown table ID/);
        const model = await session.client.callTool({ name: 'schema_get_model', arguments: { model: 'nope' } });
        assert.match(text(model), /Unknown model ID/);
        const stale = await session.client.callTool({ name: 'schema_overview', arguments: { revision: '0'.repeat(64) } });
        assert.equal(text(stale), 'Error executing tool schema_overview: Document revision differs; restart pagination without revision');
        const missing = await session.client.callTool({ name: 'schema_drop_table', arguments: {} }).catch(() => ({ isError: true }));
        assert.equal(missing.isError, true);
    });
});

describe('mcp conformance over stdio with python-schema-viewer', () => {
    let calls = 0;
    let byteEqual = 0;

    for (const recording of recordings(scratchDir())) {
        test(recording.name, async () => {
            const session = await connect(recording.snapshot);
            try {
                for (const [n, call] of recording.calls.entries()) {
                    const label = `${call.tool} ${JSON.stringify(call.arguments)}`;
                    const sent = recording.texts[n];
                    assert.ok(sent, label);
                    const result = await session.client.callTool({ name: call.tool, arguments: call.arguments });
                    calls++;
                    assert.equal(result.isError === true, sent.isError, label);
                    if (schemaRejected(call)) {
                        // Both SDKs reject values outside the input schema before the query runs, each in its own words.
                        continue;
                    }
                    assert.equal(text(result), sent.text, label);
                    byteEqual++;
                }
            } finally {
                await session.client.close();
            }
        });
    }

    test('compares every recorded call end to end', () => {
        // 1885 recorded calls; 1717 byte-equal (input-schema rejections compare the error only).
        assert.equal(calls, 1885);
        assert.equal(byteEqual, 1717);
    });
});

describe('mcp startup', () => {
    test('fails before serving when the snapshot is missing or invalid', async (t) => {
        const dir = tempDir(t);
        const missing = await runCli(['mcp', '--snapshot', join(dir, 'missing.json')]);
        assert.equal(missing.code, 1);
        assert.equal(missing.stdout, '');
        assert.match(missing.stderr, /Snapshot not found/);
        writeFileSync(join(dir, 'other.json'), JSON.stringify({ name: 'not-a-schema' }));
        const invalid = await runCli(['mcp', '--snapshot', join(dir, 'other.json')]);
        // 1.x is refused with one clear error; nothing converts it.
        writeFileSync(join(dir, 'v1.json'), JSON.stringify({ ...(JSON.parse(readFileSync(DECLARED, 'utf8')) as object), version: '1.0' }));
        const v1 = await runCli(['mcp', '--snapshot', join(dir, 'v1.json')]);
        assert.equal(v1.code, 1);
        assert.equal(v1.stdout, '');
        assert.match(v1.stderr, /Unsupported laranex-schema version "1\.0"; this reader supports 2\.x\. Rebuild the snapshot/);
        assert.equal(invalid.code, 1);
        assert.equal(invalid.stdout, '');
        assert.match(invalid.stderr, /Not a laranex-schema document/);
    });

    test('stdout carries only JSON-RPC lines and the server exits when stdin closes', async () => {
        const child = spawn(process.execPath, [CLI, 'mcp', '--snapshot', COMBINED], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        const initialize = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
        };
        child.stdin.write(`${JSON.stringify(initialize)}\n`);
        await new Promise<void>((resolve) => {
            const check = () => {
                if (stdout.includes('\n')) {
                    resolve();
                } else {
                    setTimeout(check, 20);
                }
            };
            check();
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        child.stdin.end();
        const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
        assert.equal(code, 0);
        const lines = stdout.split('\n').filter(Boolean);
        assert.ok(lines.length >= 2);
        for (const line of lines) {
            const message = JSON.parse(line) as { jsonrpc: string };
            assert.equal(message.jsonrpc, '2.0');
        }
        assert.match(lines[0] ?? '', /"serverInfo":\{"name":"Laranex Schema Viewer"/);
    });
});
