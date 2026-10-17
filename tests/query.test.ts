// The query service against python-schema-viewer's MCP conformance recordings (its docs/mcp.md): every call's result
// deep-equal to Python's, and its text byte-equal to what Python's MCP server sends.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { casefold, MAX_RESPONSE_BYTES, QueryError, size, SnapshotQuery, type Page } from '../src/query.js';
import { AWAITING_PYTHON, COMBINED, recordings, schemaRejected, scratchDir } from './helpers.js';

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
        case 'schema_compare': {
            const filter = (name: string): string | null => (args[name] as string | null | undefined) ?? null;
            return query.compare(
                (args.section as string | undefined) ?? 'comparisons',
                {
                    comparison: filter('comparison'),
                    baseline: filter('baseline'),
                    target: filter('target'),
                    objectType: filter('object_type'),
                    change: filter('change'),
                    severity: filter('severity'),
                    certainty: filter('certainty'),
                },
                pagination,
            );
        }
        default:
            return query.relationships((args.table as string | undefined) ?? null, (args.kind as string | undefined) ?? 'orm', pagination);
    }
}

describe('query conformance with python-schema-viewer', () => {
    let calls = 0;
    let byteEqual = 0;

    for (const recording of recordings(scratchDir())) {
        test(recording.name, { skip: AWAITING_PYTHON.get(recording.name) ?? false }, () => {
            const query = SnapshotQuery.fromFile(recording.snapshot);
            assert.equal(query.revision, recording.revision);
            assert.equal(recording.texts.length, recording.calls.length);
            recording.calls.forEach((call, n) => {
                const label = `${call.tool} ${JSON.stringify(call.arguments)}`;
                const sent = recording.texts[n];
                assert.ok(sent, label);
                calls++;
                if (call.error !== undefined) {
                    assert.throws(() => invoke(query, call.tool, call.arguments), (error: Error) => error instanceof QueryError && error.message === call.error, label);
                    assert.equal(sent.isError, true, label);
                    if (!schemaRejected(call)) {
                        assert.equal(sent.text, `Error executing tool ${call.tool}: ${call.error}`, label);
                        byteEqual++;
                    }
                    return;
                }
                const result = invoke(query, call.tool, call.arguments);
                assert.deepEqual(JSON.parse(JSON.stringify(result)), call.result, label);
                assert.equal(sent.isError, false, label);
                // The text Python's MCP server sends: two-space JSON in its key order.
                assert.equal(JSON.stringify(result, null, 2), sent.text, label);
                byteEqual++;
            });
        });
    }

    test('skips only recordings python-schema-viewer has not re-recorded since 195c1a6', () => {
        const all = new Map(recordings(scratchDir()).map((r) => [r.name, r.pythonCommit]));
        for (const name of AWAITING_PYTHON.keys()) {
            assert.equal(all.get(name), '195c1a6f6182354b781ba615b2b685e0d463a8db', `${name} was re-recorded: remove it from AWAITING_PYTHON`);
        }
    });

    test('compares every recorded call', () => {
        // 1801 recorded calls (1633 byte-equal), less the 233 (221) of comparison-incomplete.json (AWAITING_PYTHON).
        assert.equal(calls, 1568);
        assert.equal(byteEqual, 1412);
    });
});

describe('query', () => {
    test('validates pagination arguments', () => {
        const query = SnapshotQuery.fromFile(COMBINED);
        for (const limit of [0, 101, 1.5, Number.NaN]) {
            assert.throws(() => query.overview({ limit }), /limit must be an integer from 1 to 100/);
        }
        assert.throws(() => query.overview({ offset: -1 }), /offset must be a nonnegative integer/);
        assert.throws(() => query.overview({ revision: 'x' }), /Document revision differs/);
        assert.throws(() => query.search(''), /query must contain 1 to 200 characters/);
        assert.equal(query.search('😀'.repeat(200)).total, 0);
        assert.throws(() => query.search('😀'.repeat(201)), /query must contain 1 to 200 characters/);
    });

    test('measures UTF-8 bytes of compact JSON and keeps pages under the limit', () => {
        assert.equal(size({ a: [1, 'ü', null], b: {} }), '{"a":[1,"ü",null],"b":{}}'.length + 1);
        assert.equal(MAX_RESPONSE_BYTES, 65536);
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
