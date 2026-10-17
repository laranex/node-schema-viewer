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
    gateDocument,
    inferAssociations,
    migrationHistory,
    migrationState,
    validateDocument,
    validateGateReport,
    type CompareOptions,
    type GateOptions,
    type GateReport,
    type MigrationRevision,
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
// documents). laranex-schema-viewer-ui 0.3.0-dev.0 (cc11407) ships 14 valid and 53 invalid document fixtures, 6 valid
// and 13 invalid gate report fixtures and 23 gate conformance cases.
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
