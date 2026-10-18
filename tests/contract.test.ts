// The shared laranex-schema 2.0 contract suite, run independently here: the fixtures and conformance cases of the
// installed laranex-schema-viewer-ui package, through its validators and producer algorithms and through this
// package's own loading and writing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
    buildGraph,
    canonicalJson,
    compareScopes,
    comparisonDiagnostics,
    coverageGaps,
    coverageGapText,
    expandComparisonRequests,
    gateDocument,
    inferAssociations,
    migrationHistory,
    migrationState,
    scopeCovered,
    storeComparisons,
    validateDocument,
    validateGateReport,
    validateSeverityOverrides,
    type Comparison,
    type CompareOptions,
    type CoverageGap,
    type GateOptions,
    type GateReport,
    type MigrationRevision,
    type RequestedComparison,
    type SchemaDocument,
    type Scope,
} from 'laranex-schema-viewer-ui/contract';
import { loadDocument, snapshotBytes, writeDocument } from '../src/snapshot.js';
import { CONTRACT, tempDir, VALID } from './helpers.js';

function cases<T>(directory: string): [string, T][] {
    const path = join(CONTRACT, directory);
    const names = readdirSync(path).filter((name) => name.endsWith('.json')).sort();
    assert.ok(names.length > 0, directory);
    return names.map((name) => [name, JSON.parse(readFileSync(join(path, name), 'utf8')) as T]);
}

interface Case<I, E> {
    description: string;
    input: I;
    expected: E;
}

describe('shared valid fixtures', () => {
    for (const [name, document] of cases<Parameters<typeof validateDocument>[0]>('fixtures/valid')) {
        test(`${name} passes strict validation and stores the shared links and inferred associations`, () => {
            assert.deepEqual(validateDocument(document, { strict: true }).errors, []);
            const doc = loadDocument(join(VALID, name));
            assert.deepEqual({ links: doc.links, derivedLinks: doc.derivedLinks }, buildGraph(doc));
            assert.deepEqual(doc.inferredAssociations, inferAssociations(doc));
        });

        test(`${name} is unchanged by storing the comparisons it holds`, () => {
            const doc = loadDocument(join(VALID, name));
            assert.deepEqual(storeComparisons(doc, doc.comparisons), doc);
        });

        test(`${name} round-trips to identical canonical bytes`, (t) => {
            const bytes = readFileSync(join(VALID, name));
            const doc = loadDocument(join(VALID, name));
            assert.equal(canonicalJson(doc), bytes.toString('utf8'));
            assert.deepEqual(snapshotBytes(doc), bytes);
            const out = join(tempDir(t), 'written.json');
            writeDocument(doc, out);
            assert.deepEqual(readFileSync(out), bytes);
        });
    }
});

// Exactly the package's own fixture directories (the gate-report fixtures in fixtures/gate are a separate format, not
// documents). laranex-schema-viewer-ui 0.3.0 ships 14 valid and 53 invalid document fixtures, 6 valid
// and 13 invalid gate report fixtures, 23 gate conformance cases and 43 producer cases (13 request, 11 coverage-gap,
// 9 override, 6 comparison-diagnostic and 4 store cases).
describe('shared fixture inventory', () => {
    test('the installed package has 14 valid and 53 invalid document fixtures', () => {
        assert.equal(cases('fixtures/valid').length, 14);
        assert.equal(cases('fixtures/invalid').length, 53);
    });

    test('the installed package has 6 valid and 13 invalid gate reports and 23 gate conformance cases', () => {
        assert.equal(cases('fixtures/gate/valid').length, 6);
        assert.equal(cases('fixtures/gate/invalid').length, 13);
        assert.equal(cases('conformance/gate').length, 23);
    });

    test('the installed package has 43 request, coverage-gap, override, comparison-diagnostic and store cases', () => {
        const counts = ['requests', 'coverage-gaps', 'overrides', 'comparison-diagnostics', 'store'].map((d) => cases(`conformance/${d}`).length);
        assert.deepEqual(counts, [13, 11, 9, 6, 4]);
    });
});

describe('shared invalid fixtures', () => {
    for (const [name, fixture] of cases<{ description: string; document: unknown; errors: string[]; strict: boolean }>('fixtures/invalid')) {
        test(`${name}: ${fixture.description}`, () => {
            const result = validateDocument(fixture.document, { strict: fixture.strict });
            assert.equal(result.ok, false);
            for (const message of fixture.errors) {
                assert.ok(
                    result.errors.some((e) => e.includes(message)),
                    `expected "${message}" in ${JSON.stringify(result.errors)}`,
                );
            }
        });
    }
});

describe('graph conformance', () => {
    for (const [name, c] of cases<Case<Parameters<typeof buildGraph>[0], unknown>>('conformance/graph')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(buildGraph(c.input), c.expected);
        });
    }
});

describe('migration conformance', () => {
    for (const [name, c] of cases<Case<{ revisions: MigrationRevision[] | null; current: string[] | null }, unknown>>('conformance/migrations')) {
        test(`${name}: ${c.description}`, () => {
            const history = c.input.revisions === null ? null : migrationHistory(c.input.revisions);
            assert.deepEqual({ history, ...migrationState(history, c.input.current) }, c.expected);
        });
    }
});

describe('comparison conformance', () => {
    type Input = { document: Parameters<typeof compareScopes>[0]; baseline: Scope; target: Scope; overrides?: CompareOptions['overrides']; limit?: number };
    for (const [name, c] of cases<Case<Input, unknown>>('conformance/comparison')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(compareScopes(c.input.document, c.input.baseline, c.input.target, { overrides: c.input.overrides, limit: c.input.limit }), c.expected);
        });
    }
});

describe('inference conformance', () => {
    type Input = Parameters<typeof inferAssociations>[0] & Parameters<typeof buildGraph>[0];
    for (const [name, c] of cases<Case<Input, { inferredAssociations: unknown }>>('conformance/inference')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(c.input.links, buildGraph(c.input).links);
            assert.deepEqual(inferAssociations(c.input), c.expected.inferredAssociations);
        });
    }
});

describe('gate report fixtures', () => {
    for (const [name, report] of cases<unknown>('fixtures/gate/valid')) {
        test(`${name} passes strict gate report validation`, () => {
            assert.deepEqual(validateGateReport(report, { strict: true }).errors, []);
        });
    }
    for (const [name, fixture] of cases<{ description: string; report: unknown; errors: string[] }>('fixtures/gate/invalid')) {
        test(`${name}: ${fixture.description}`, () => {
            const result = validateGateReport(fixture.report, { strict: true });
            assert.equal(result.ok, false);
            for (const message of fixture.errors) {
                assert.ok(
                    result.errors.some((e) => e.includes(message)),
                    `expected "${message}" in ${JSON.stringify(result.errors)}`,
                );
            }
        });
    }
});

describe('gate conformance', () => {
    type Input = { document: unknown; thresholds: GateOptions['thresholds']; requested: GateOptions['requested'] };
    for (const [name, c] of cases<Case<Input, GateReport>>('conformance/gate')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(validateGateReport(c.expected, { strict: true }).errors, []);
            const report = gateDocument(c.input.document, { thresholds: c.input.thresholds, requested: c.input.requested });
            assert.deepEqual(report, c.expected);
            assert.equal(canonicalJson(report), canonicalJson(c.expected));
        });
    }
});

describe('requested comparison conformance', () => {
    type Input = { document: Parameters<typeof expandComparisonRequests>[0]; requests: RequestedComparison[] };
    for (const [name, c] of cases<Case<Input, unknown>>('conformance/requests')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(expandComparisonRequests(c.input.document, c.input.requests), c.expected);
        });
    }
});

describe('coverage gap conformance', () => {
    type Input = { document: Parameters<typeof coverageGaps>[0]; scope: Scope };
    for (const [name, c] of cases<Case<Input, { gaps: CoverageGap[]; covered: boolean }>>('conformance/coverage-gaps')) {
        test(`${name}: ${c.description}`, () => {
            const { document, scope } = c.input;
            const connection = document.connections.find((x) => x.id === scope.connection);
            assert.ok(connection);
            const coverage = document.source === 'declared' ? connection.coverage.declared : connection.coverage.database;
            assert.deepEqual({ gaps: coverageGaps(document, scope), covered: scopeCovered(coverage, connection, scope.schema) }, c.expected);
            assert.ok(c.expected.gaps.every((gap) => coverageGapText(gap).length > 0));
        });
    }
});

describe('severity override conformance', () => {
    for (const [name, c] of cases<Case<{ overrides: unknown }, { errors: string[] }>>('conformance/overrides')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(validateSeverityOverrides(c.input.overrides), c.expected.errors);
        });
    }
});

describe('comparison diagnostic conformance', () => {
    type Input = { document: Parameters<typeof comparisonDiagnostics>[0]; comparison: Comparison };
    for (const [name, c] of cases<Case<Input, { diagnostics: unknown }>>('conformance/comparison-diagnostics')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(comparisonDiagnostics(c.input.document, c.input.comparison), c.expected.diagnostics);
        });
    }
});

describe('store conformance', () => {
    type Input = { document: SchemaDocument; comparisons: Comparison[] };
    for (const [name, c] of cases<Case<Input, { document: SchemaDocument }>>('conformance/store')) {
        test(`${name}: ${c.description}`, () => {
            assert.deepEqual(storeComparisons(c.input.document, c.input.comparisons), c.expected.document);
            assert.deepEqual(validateDocument(c.expected.document, { strict: true }).errors, []);
        });
    }
});
