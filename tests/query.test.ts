import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { casefold, MAX_RESPONSE_BYTES, pythonJsonBytes, QueryError, SnapshotQuery, type Page } from '../src/query.js';
import { COMBINED, DOCUMENTS, EXPECTED, largeDocument } from './helpers.js';
import { pendingMcp } from './pending.js';

interface Call {
    tool: string;
    arguments: Record<string, unknown>;
    response?: Page;
    text?: string;
    error?: string;
}

interface Expected {
    python_revision: string;
    raw_revision: string;
    view: unknown;
    calls: Call[];
}

export function invoke(query: SnapshotQuery, tool: string, args: Record<string, unknown>): Page {
    const pagination = {
        ...(args.limit === undefined ? {} : { limit: args.limit as number }),
        ...(args.offset === undefined ? {} : { offset: args.offset as number }),
        ...(args.revision === undefined ? {} : { revision: args.revision as string }),
    };
    switch (tool) {
        case 'schema_overview':
            return query.overview(pagination);
        case 'schema_search':
            return query.search(args.query_text as string, pagination);
        case 'schema_get_table':
            return query.getTable(args.table as string, (args.section as string | undefined) ?? 'columns', pagination);
        case 'schema_get_model':
            return query.getModel(args.model as string, pagination);
        default:
            return query.relationships((args.table as string | undefined) ?? null, (args.kind as string | undefined) ?? 'orm', pagination);
    }
}

// Python hashes a later minor without the properties it does not know; everything else must match exactly.
function withRevision<T>(value: T, from: string, to: string): T {
    return JSON.parse(JSON.stringify(value).replaceAll(from, to)) as T;
}

const names = readdirSync(EXPECTED).filter((name) => name.endsWith('.json'));

describe('query conformance with python-schema-viewer', () => {
    test('covers every recorded document', () => {
        assert.deepEqual(names, readdirSync(DOCUMENTS).filter((name) => name.endsWith('.json')));
        assert.equal(names.length, 10);
    });

    for (const name of names) {
        test(name, { skip: pendingMcp(name) }, () => {
            const expected = JSON.parse(readFileSync(join(EXPECTED, name), 'utf8')) as Expected;
            const query = SnapshotQuery.fromFile(join(DOCUMENTS, name));
            const lenient = expected.python_revision !== expected.raw_revision;
            assert.equal(lenient, name === 'lenient-future-minor.json');
            const local = (value: Call) => (lenient ? withRevision(value, expected.python_revision, query.revision) : value);
            assert.deepEqual(JSON.parse(JSON.stringify(query.view)), expected.view);
            let compared = 0;
            for (const raw of expected.calls) {
                const call = local(raw);
                const label = `${call.tool} ${JSON.stringify(call.arguments)}`;
                if (call.error !== undefined) {
                    assert.throws(() => invoke(query, call.tool, call.arguments), (error: Error) => error instanceof QueryError && error.message === call.error, label);
                } else {
                    const response = invoke(query, call.tool, call.arguments);
                    assert.deepEqual(JSON.parse(JSON.stringify(response)), call.response, label);
                    // Byte-equal with the text the Python MCP SDK sends for the same response.
                    assert.equal(JSON.stringify(response, null, 2), call.text, label);
                }
                compared++;
            }
            assert.equal(compared, expected.calls.length);
        });
    }
});

describe('query', () => {
    test('pagination stops before 64 KiB and follows next_offset', () => {
        const query = new SnapshotQuery(largeDocument(400));
        const table = [...query.tables.keys()][0] ?? '';
        let offset: number | null = 0;
        let seen = 0;
        let pages = 0;
        while (offset !== null) {
            const page = query.getTable(table, 'columns', { limit: 100, offset, revision: query.revision });
            assert.ok(pythonJsonBytes(page) <= MAX_RESPONSE_BYTES - 128);
            assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_RESPONSE_BYTES);
            seen += page.items.length;
            offset = page.next_offset;
            pages++;
        }
        assert.equal(seen, query.getTable(table).total);
        assert.ok(pages >= 2);
    });

    test('validates pagination arguments', () => {
        const query = SnapshotQuery.fromFile(COMBINED);
        for (const limit of [0, 101, 1.5, Number.NaN]) {
            assert.throws(() => query.overview({ limit }), /limit must be an integer from 1 to 100/);
        }
        assert.throws(() => query.overview({ offset: -1 }), /offset must be a nonnegative integer/);
        assert.throws(() => query.overview({ revision: 'x' }), /Snapshot revision differs/);
        assert.throws(() => query.search(''), /query must contain 1 to 200 characters/);
        assert.equal(query.search('😀'.repeat(200)).total, 0);
        assert.throws(() => query.search('😀'.repeat(201)), /query must contain 1 to 200 characters/);
    });

    test('measures bytes as Python json.dumps(ensure_ascii=False) does', () => {
        assert.equal(pythonJsonBytes({ a: [1, 'ü', null, true, false], b: {} }), '{"a": [1, "ü", null, true, false], "b": {}}'.length + 1);
        assert.equal(pythonJsonBytes('"\\\n\u0001'), '"\\"\\\\\\n\\u0001"'.length);
        assert.equal(pythonJsonBytes(1.5), 3);
        assert.equal(pythonJsonBytes(0.0001), '0.0001'.length);
        assert.equal(pythonJsonBytes(1.5e-7), '1.5e-07'.length);
        assert.equal(pythonJsonBytes(1e16), '1e+16'.length);
        assert.equal(pythonJsonBytes(-2.25), 5);
    });

    test('folds case like Python str.casefold', () => {
        assert.equal(casefold('Straße'), 'strasse');
        assert.equal(casefold('STRAẞE'), 'strasse');
        assert.equal(casefold('ΣΊΣΥΦΟΣ'), 'σίσυφοσ');
        assert.equal(casefold('ﬁle'), 'file');
        assert.equal(casefold('ı'), 'ı');
        assert.equal(casefold('İ'), 'i̇');
    });
});
