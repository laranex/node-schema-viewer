// The Drizzle adapter on synthetic schemas (tests/fixtures/drizzle/), per dialect. The adapter is called directly with
// a context like the extraction worker's, so its mapping is checked on every Node.js version; the same modules run
// through the isolated worker in tests/build.test.ts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { canonicalJson, type Column, type SchemaDocument, type Table } from 'laranex-schema-viewer-ui/contract';
import { extract, type DrizzleConnection } from '../src/isolation/extractors/drizzle.js';
import type { ExtractContext } from '../src/isolation/extractor.js';
import { tableId } from '../src/schema/ids.js';
import { assertProducerDocument, ROOT } from './helpers.js';

const FIXTURES = './tests/fixtures/drizzle';
const require = createRequire(join(ROOT, 'package.json'));

// What the worker's context does: project paths relative to the root, package names resolved from the project.
function context(connections: DrizzleConnection[], casing: string | null = null, override?: (specifier: string) => Record<string, unknown> | undefined): ExtractContext {
    return {
        projectRoot: ROOT,
        modules: connections.flatMap((c) => c.modules),
        targets: [],
        options: { connections, casing },
        async importModule(specifier) {
            const replaced = override?.(specifier);
            if (replaced !== undefined) {
                return replaced;
            }
            const path = /^\.\.?\//.test(specifier) || isAbsolute(specifier) ? resolve(ROOT, specifier) : require.resolve(specifier);
            return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
        },
    };
}

async function document(file: string, options: { driver?: string | null; casing?: string | null; name?: string } = {}): Promise<SchemaDocument> {
    const result = (await extract(context([{ name: options.name ?? 'default', driver: options.driver ?? null, modules: [`${FIXTURES}/${file}`] }], options.casing ?? null))) as SchemaDocument;
    assertProducerDocument(result);
    return result;
}

function table(doc: SchemaDocument, name: string, schema: string | null = null): Table {
    const found = doc.connections.flatMap((c) => c.tables).find((t) => t.name === name && t.schema === schema);
    assert.ok(found, `table ${name}`);
    return found;
}

function column(t: Table, name: string): Column {
    const found = t.columns.find((c) => c.name === name);
    assert.ok(found, `column ${name}`);
    return found;
}

function relationship(doc: SchemaDocument, model: string, name: string) {
    const found = doc.relationships.find((r) => r.name === name && doc.models.find((m) => m.id === r.model)?.className === model);
    assert.ok(found, `relationship ${model}.${name}`);
    return found;
}

describe('the Drizzle adapter: PostgreSQL (pg-core)', async () => {
    const doc = await document('pg.mjs');
    const users = tableId('default', null, 'users');
    const posts = tableId('default', null, 'posts');
    const invoices = tableId('default', 'billing', 'invoices');

    test('writes a strictly valid declared document with the dialect as driver and the models', () => {
        assert.equal(doc.source, 'declared');
        assert.deepEqual(doc.generator, { name: 'node-schema-viewer', orm: 'drizzle' });
        const [connection] = doc.connections;
        assert.equal(connection?.driver, 'postgresql');
        assert.equal(connection.defaultSchema, null);
        assert.deepEqual(connection.tables.map((t) => [t.schema, t.name]), [['billing', 'invoice_lines'], ['billing', 'invoices'], [null, 'posts'], [null, 'tags'], [null, 'users']]);
        assert.deepEqual(doc.models.map((m) => [m.className, m.tables, m.primaryKey, m.source]), [
            ['invoices', [invoices], ['year', 'number'], null],
            ['lines', [tableId('default', 'billing', 'invoice_lines')], ['id'], null],
            ['posts', [posts], ['id'], null],
            ['tags', [tableId('default', null, 'tags')], ['post_id', 'label'], null],
            ['users', [users], ['id'], null],
        ]);
        assert.deepEqual(connection.coverage.declared?.features.comments, 'not_applicable');
        assert.deepEqual(connection.coverage.declared.features.includedColumns, 'not_applicable');
        assert.equal(connection.coverage.declared.features.indexPredicates, 'complete');
    });

    test('columns: types as getSQLType() declares them, nullability, identity, defaults and generated columns', () => {
        const t = table(doc, 'users');
        assert.deepEqual(t.columns.map((c) => [c.name, c.type, c.nullable]), [
            ['id', 'integer', false], ['email', 'varchar(255)', false], ['name', 'text', true], ['created_at', 'timestamp with time zone', false],
            ['token', 'uuid', true], ['settings', 'jsonb', true], ['nickname', 'text', true],
        ]);
        const id = column(t, 'id');
        assert.deepEqual([id.default, id.autoIncrement, id.extensions], [{ kind: 'identity', value: 'GENERATED ALWAYS AS IDENTITY' }, true, { drizzle: { identity: { startWith: 100 } } }]);
        assert.deepEqual(column(t, 'created_at').default, { kind: 'expression', value: 'now()' });
        assert.equal(column(t, 'created_at').timezone, true);
        assert.equal(column(t, 'name').timezone, null);
        assert.deepEqual(column(t, 'token').default, { kind: 'expression', value: 'gen_random_uuid()' });
        assert.deepEqual(column(t, 'nickname').ormDefault, { kind: 'callable', value: 'nickname' });
        assert.equal(column(t, 'nickname').default, null);
        const p = table(doc, 'posts');
        assert.deepEqual([column(p, 'id').type, column(p, 'id').autoIncrement, column(p, 'author_id').autoIncrement], ['serial', true, false]);
        assert.deepEqual(column(p, 'title').default, { kind: 'literal', value: "'untitled'" });
        assert.deepEqual(column(p, 'views').default, { kind: 'literal', value: '0' });
        assert.deepEqual(column(p, 'state').enum, { name: 'status', values: ['draft', 'published', 'archived'] });
        assert.deepEqual([column(p, 'state').type, column(p, 'state').default], ['status', { kind: 'literal', value: "'draft'" }]);
        assert.deepEqual(column(p, 'score').generated, { kind: 'stored', expression: 'views * 2' });
        assert.ok(t.columns.every((c) => c.comment === null && c.collation === null && c.typeName === null));
    });

    test('a default Drizzle converts in JavaScript is kept as an extension with a diagnostic, never as invented SQL', () => {
        const settings = column(table(doc, 'users'), 'settings');
        assert.equal(settings.default, null);
        assert.deepEqual(settings.extensions, { drizzle: { default: { theme: 'dark' } } });
        assert.deepEqual(doc.diagnostics.map((d) => [d.kind, d.category, d.subject.type, d.subject.columns]), [['unsupported_metadata', 'extraction', 'column', ['settings']]]);
        assert.equal(doc.connections[0]?.coverage.declared?.features.defaults, 'partial');
        assert.equal(doc.connections[0].coverage.declared.complete, false);
    });

    test('composite primary keys, composite and cross-schema foreign keys with their actions', () => {
        assert.deepEqual(table(doc, 'tags').primaryKey, ['post_id', 'label']);
        assert.deepEqual(table(doc, 'invoices', 'billing').primaryKey, ['year', 'number']);
        const [tagsFk] = table(doc, 'tags').foreignKeys;
        assert.deepEqual([tagsFk?.name, tagsFk?.columns, tagsFk?.foreignTable, tagsFk?.foreignColumns, tagsFk?.onDelete, tagsFk?.onUpdate], ['tags_post_fk', ['post_id'], posts, ['id'], 'SET NULL', 'RESTRICT']);
        const [postFk] = table(doc, 'posts').foreignKeys;
        assert.deepEqual([postFk?.name, postFk?.foreignTable, postFk?.onDelete, postFk?.onUpdate], ['posts_author_id_users_id_fk', users, 'CASCADE', 'NO ACTION']);
        // billing.invoices -> public users: across schemas.
        assert.deepEqual(table(doc, 'invoices', 'billing').foreignKeys.map((f) => [f.columns, f.foreignTable]), [[['user_id'], users]]);
        const [composite] = table(doc, 'invoice_lines', 'billing').foreignKeys;
        assert.deepEqual([composite?.columns, composite?.foreignTable, composite?.foreignColumns], [['invoice_year', 'invoice_number'], invoices, ['year', 'number']]);
    });

    test('unique constraints and indexes: expressions, predicates, order, operator classes and methods', () => {
        const t = table(doc, 'users');
        assert.deepEqual(t.constraints.map((c) => [c.kind, c.name, c.columns, c.expression]), [
            ['check', 'users_email_shape', [], `position('@' in "email") > 1`],
            ['unique', 'users_email_unique', ['email'], null],
        ]);
        assert.deepEqual(t.indexes.map((i) => [i.name, i.unique, i.method, i.expression, i.partial, i.predicate, i.parts.map((p) => [p.column, p.expression, p.order, p.nulls])]), [
            ['users_lower_email', false, 'btree', true, false, null, [[null, 'lower("email")', null, null]]],
            // desc() keeps Drizzle's NULLS LAST, which is not PostgreSQL's default for a descending key.
            ['users_name_partial', false, 'btree', false, true, '"name" IS NOT NULL', [['name', null, 'desc', 'last']]],
        ]);
        const p = table(doc, 'posts');
        assert.deepEqual(p.indexes.map((i) => [i.name, i.unique, i.method, i.backs, i.parts.map((x) => [x.column, x.opclass])]), [
            ['posts_author_title', true, 'btree', null, [['author_id', null], ['title', 'text_pattern_ops']]],
            ['posts_views', false, 'brin', null, [['views', null]]],
        ]);
        const unique = table(doc, 'invoices', 'billing').constraints;
        assert.deepEqual(unique.map((c) => [c.name, c.columns, c.extensions]), [['invoices_user_year', ['user_id', 'year'], { drizzle: { nullsNotDistinct: true } }]]);
    });

    test('relations() are ORM relationships, read-only, oriented like foreign keys, with inverses and cardinality', () => {
        const author = relationship(doc, 'posts', 'author');
        assert.deepEqual([author.type, author.cardinality, author.collection, author.readOnly, author.relatedTable, author.keys], [
            'one', 'many-to-one', false, true, users, { from: { table: posts, columns: ['author_id'] }, to: { table: users, columns: ['id'] } },
        ]);
        const many = relationship(doc, 'users', 'posts');
        assert.deepEqual([many.type, many.cardinality, many.collection, many.keys], ['many', 'one-to-many', true, author.keys]);
        assert.equal(many.inverse, author.id);
        assert.equal(author.inverse, many.id);
        assert.ok(doc.relationships.every((r) => r.pivot === null && r.through === null && r.join === null && r.polymorphic === null));
    });

    test('foreign keys and relationships stay separate; a foreign key without relation is an inferred association', () => {
        const link = doc.links.find((l) => l.from.table === posts && l.to.table === users);
        assert.equal(link?.state, 'both');
        assert.equal(doc.links.find((l) => l.from.table === tableId('default', 'billing', 'invoice_lines'))?.state, 'foreign_key');
        assert.deepEqual(doc.inferredAssociations.map((a) => [a.kind, a.table, a.relatedTable]), [['foreign_key', tableId('default', 'billing', 'invoice_lines'), invoices]]);
    });

    test('equal schemas give equal bytes', async () => {
        assert.equal(canonicalJson(await document('pg.mjs')), canonicalJson(doc));
    });
});

describe('the Drizzle adapter: MySQL (mysql-core)', async () => {
    const doc = await document('mysql.mjs');
    const accounts = tableId('default', null, 'accounts');
    const profiles = tableId('default', null, 'profiles');

    test('mysql-core does not tell MySQL from MariaDB: the driver comes from the configuration', async () => {
        assert.equal(doc.connections[0]?.driver, null);
        assert.equal((await document('mysql.mjs', { driver: 'mariadb' })).connections[0]?.driver, 'mariadb');
        assert.equal(doc.connections[0].coverage.declared?.features.indexPredicates, 'not_applicable');
        assert.deepEqual(doc.diagnostics, []);
    });

    test('database-qualified tables, auto-increment, enums and composite keys', () => {
        assert.deepEqual(table(doc, 'events', 'audit').primaryKey, ['id']);
        const t = table(doc, 'accounts');
        assert.deepEqual([column(t, 'id').autoIncrement, column(t, 'handle').autoIncrement, column(table(doc, 'events', 'audit'), 'id').type], [true, false, 'serial']);
        assert.deepEqual([column(t, 'plan').type, column(t, 'plan').enum, column(t, 'plan').default], ["enum('free','pro')", { name: null, values: ['free', 'pro'] }, { kind: 'literal', value: "'free'" }]);
        assert.deepEqual(table(doc, 'memberships').primaryKey, ['account_id', 'team_id']);
    });

    test('actions Drizzle does not declare stay null; index options and checks keep their dialect', () => {
        assert.deepEqual(table(doc, 'memberships').foreignKeys.map((f) => [f.name, f.onDelete, f.onUpdate]), [['memberships_account', null, null]]);
        assert.deepEqual(table(doc, 'profiles').foreignKeys.map((f) => [f.onDelete, f.onUpdate]), [['CASCADE', 'CASCADE']]);
        const t = table(doc, 'accounts');
        assert.deepEqual(t.indexes.map((i) => [i.name, i.unique, i.method, i.dialectOptions ?? null, i.parts.map((p) => p.column ?? p.expression)]), [
            ['accounts_handle', true, 'btree', { mysql: { options: { algorithm: 'inplace' } } }, ['handle']],
            ['accounts_lower_handle', false, null, null, ['(lower(`handle`))']],
        ]);
        assert.deepEqual(t.constraints.map((c) => [c.kind, c.expression]), [['check', 'char_length(`handle`) > 2']]);
    });

    test('a field-less one() is the inverse of a one-to-one, keyed from the other side', () => {
        const profile = relationship(doc, 'accounts', 'profile');
        const keys = { from: { table: profiles, columns: ['account_id'] }, to: { table: accounts, columns: ['id'] } };
        assert.deepEqual([profile.cardinality, profile.collection, profile.keys], ['one-to-one', false, keys]);
        const account = relationship(doc, 'profiles', 'account');
        // profiles.account_id is the primary key, so the one() is one-to-one.
        assert.deepEqual([account.cardinality, account.keys, account.inverse], ['one-to-one', keys, profile.id]);
        assert.equal(relationship(doc, 'memberships', 'account').cardinality, 'many-to-one');
    });
});

describe('the Drizzle adapter: SQLite (sqlite-core)', async () => {
    const doc = await document('sqlite.mjs');
    const nodes = tableId('default', null, 'nodes');

    test('rowid keys are the database\'s, AUTOINCREMENT is declared; TypeScript-only enums are extensions', () => {
        const t = table(doc, 'nodes');
        assert.equal(doc.connections[0]?.driver, 'sqlite');
        assert.deepEqual([column(t, 'id').autoIncrement, column(table(doc, 'plain'), 'id').autoIncrement, column(t, 'parent_id').autoIncrement], [true, null, false]);
        assert.deepEqual([column(t, 'kind').enum, column(t, 'kind').extensions], [null, { drizzle: { enumValues: ['file', 'folder'] } }]);
        assert.deepEqual(column(t, 'created_at').default, { kind: 'expression', value: '(unixepoch())' });
        assert.deepEqual([column(t, 'active').default, column(t, 'weight').default], [{ kind: 'literal', value: 'true' }, { kind: 'literal', value: '1.5' }]);
        assert.deepEqual(column(t, 'slug').generated, { kind: 'stored', expression: 'lower(label)' });
        assert.deepEqual(table(doc, 'versions').primaryKey, ['node_id', 'number']);
    });

    test('partial indexes, unique constraints, checks and self-referencing foreign keys', () => {
        const t = table(doc, 'nodes');
        assert.deepEqual(t.indexes.map((i) => [i.name, i.predicate, i.method]), [['nodes_active_label', '"active" = 1', null]]);
        assert.deepEqual(t.constraints.map((c) => [c.kind, c.name, c.columns, c.expression]), [['unique', 'nodes_parent_label', ['parent_id', 'label'], null], ['check', 'nodes_weight', [], '"weight" >= 0']]);
        assert.deepEqual(t.foreignKeys.map((f) => [f.columns, f.foreignTable, f.onDelete]), [[['parent_id'], nodes, 'SET NULL']]);
    });

    test('named self-relations pair up by relationName', () => {
        const parent = relationship(doc, 'nodes', 'parent');
        const children = relationship(doc, 'nodes', 'children');
        assert.deepEqual([parent.inverse, children.inverse], [children.id, parent.id]);
        assert.deepEqual(children.keys, parent.keys);
        assert.deepEqual(parent.extensions, { drizzle: { relationName: 'tree' } });
        assert.equal(doc.links.find((l) => l.from.table === nodes && l.to.table === nodes)?.state, 'both');
    });
});

describe('the Drizzle adapter: what it does not represent', async () => {
    const doc = await document('unsupported.mjs');

    test('views, sequences, row-level security, JavaScript defaults, placeholders and unresolved references are diagnostics', () => {
        assert.deepEqual(doc.diagnostics.map((d) => [d.kind, d.subject.type, d.subject.label]), [
            ['unresolved_foreign_key', 'foreignKey', 'items_hidden_id_hidden_id_fk'],
            ['unresolved_relationship', 'relationship', 'items.hidden'],
            ['unresolved_relationship', 'relationship', 'items.owners'],
            ['unsupported_metadata', 'column', 'items.seen_at'],
            ['unsupported_metadata', 'connection', 'counter'],
            ['unsupported_metadata', 'connection', 'itemsCount'],
            ['unsupported_metadata', 'connection', 'itemsView'],
            ['unsupported_metadata', 'table', 'items'],
            ['unsupported_metadata', 'table', 'items'],
        ]);
        assert.ok(doc.diagnostics.every((d) => d.category === 'extraction' && d.certainty === 'certain'));
        const features = doc.connections[0]?.coverage.declared?.features;
        assert.deepEqual([features?.defaults, features?.checkConstraints, features?.relationships], ['partial', 'partial', 'partial']);
    });

    test('nothing is invented for them', () => {
        const items = table(doc, 'items');
        assert.deepEqual(items.constraints, []);
        assert.deepEqual(doc.connections[0]?.tables.map((t) => t.name), ['items', 'owners']);
        const [fk] = items.foreignKeys;
        assert.equal(fk?.foreignTable, tableId('default', null, 'hidden'));
        const hidden = relationship(doc, 'items', 'hidden');
        assert.deepEqual([hidden.relatedModel, hidden.relatedTable, hidden.keys], [null, null, null]);
        const owners = relationship(doc, 'items', 'owners');
        assert.deepEqual([owners.relatedTable, owners.keys], [tableId('default', null, 'owners'), null]);
        assert.equal(column(items, 'seen_at').default, null);
    });
});

describe('the Drizzle adapter: names, connections and modules', () => {
    test('columns named by their keys follow the configured casing', async () => {
        const doc = await document('casing.mjs', { casing: 'snake_case' });
        assert.deepEqual(table(doc, 'authors').columns.map((c) => c.name), ['id', 'display_name']);
        assert.deepEqual(table(doc, 'books').columns.map((c) => c.name), ['book_id', 'author_id', 'Title']);
        assert.deepEqual(table(doc, 'authors').indexes[0]?.parts.map((p) => p.column), ['display_name']);
        assert.deepEqual(table(doc, 'books').foreignKeys[0]?.columns, ['author_id']);
        assert.deepEqual(doc.relationships[0]?.keys?.from.columns, ['author_id']);
        const keys = await document('casing.mjs');
        assert.deepEqual(table(keys, 'authors').columns.map((c) => c.name), ['id', 'displayName']);
    });

    test('each connection gets the tables of its own modules; a foreign key never crosses connections, a relationship may', async () => {
        const doc = (await extract(context([
            { name: 'app', driver: null, modules: [`${FIXTURES}/multi/app.mjs`] },
            { name: 'reporting', driver: 'postgresql', modules: [`${FIXTURES}/multi/reporting.mjs`] },
            { name: 'local', driver: null, modules: [`${FIXTURES}/schema.cjs`] },
        ]))) as SchemaDocument;
        assertProducerDocument(doc);
        assert.deepEqual(doc.connections.map((c) => [c.name, c.driver, c.tables.map((t) => t.name)]), [
            ['app', 'postgresql', ['teams', 'users']],
            ['local', 'sqlite', ['notes']],
            ['reporting', 'postgresql', ['reports', 'users']],
        ]);
        const appUsers = tableId('app', null, 'users');
        const reports = tableId('reporting', null, 'reports');
        const cross = table(doc, 'reports').foreignKeys.find((f) => f.columns[0] === 'app_user_id');
        // The constraint lives in the reporting database, which resolves the name there.
        assert.equal(cross?.foreignTable, tableId('reporting', null, 'users'));
        assert.deepEqual(doc.diagnostics.map((d) => [d.kind, d.subject.id === cross.id]), [['unresolved_foreign_key', true]]);
        assert.match(doc.diagnostics[0]?.message ?? '', /belongs to connection app; a foreign key never crosses connections/);
        const appUser = relationship(doc, 'reports', 'appUser');
        assert.deepEqual([appUser.table, appUser.relatedTable], [reports, appUsers]);
        const link = doc.links.find((l) => l.from.table === reports && l.to.table === appUsers);
        assert.deepEqual([link?.state, link?.foreignKey], ['relationship', null]);
    });

    test('fails clearly on what it cannot map', async () => {
        const one = (modules: string[], driver: string | null = null): ExtractContext => context([{ name: 'default', driver, modules: modules.map((m) => `${FIXTURES}/${m}`) }]);
        await assert.rejects(extract(one(['pg.mjs', 'sqlite.mjs'])), /Connection default mixes pg, sqlite tables/);
        await assert.rejects(extract(one(['pg.mjs'], 'mysql')), /has driver mysql, but its tables are pg-core tables/);
        await assert.rejects(extract(one(['multi/app.mjs', 'multi/reporting.mjs'])), /Connection default declares table users twice/);
        await assert.rejects(extract(context([{ name: 'a', driver: null, modules: [`${FIXTURES}/multi/app.mjs`] }, { name: 'b', driver: null, modules: [`${FIXTURES}/multi/app.mjs`] }])), /exported by modules of two connections/);
        await assert.rejects(extract(one(['../adversarial/common.mjs'])), /export no Drizzle tables/);
        await assert.rejects(extract({ ...one(['pg.mjs']), options: {} }), /needs connections/);
        await assert.rejects(extract(context([{ name: 'default', driver: null, modules: [`${FIXTURES}/pg.mjs`] }], 'kebab')), /casing must be snake_case or camelCase/);
    });

    test('refuses drizzle-orm 1.x, whose relations it does not read yet', async () => {
        const v1 = context([{ name: 'default', driver: null, modules: [`${FIXTURES}/pg.mjs`] }], null, (s) => (s === 'drizzle-orm/version' ? { npmVersion: '1.0.0-rc.4' } : undefined));
        await assert.rejects(extract(v1), /drizzle-orm 1\.0\.0-rc\.4 is not supported: the Drizzle adapter reads the 0\.x metadata API from 0\.36 on/);
        const old = context([{ name: 'default', driver: null, modules: [`${FIXTURES}/pg.mjs`] }], null, (s) => (s === 'drizzle-orm/version' ? { npmVersion: '0.35.3' } : undefined));
        await assert.rejects(extract(old), /drizzle-orm 0\.35\.3 is not supported/);
        const missing = context([{ name: 'default', driver: null, modules: [`${FIXTURES}/pg.mjs`] }], null, (s) => {
            if (s === 'drizzle-orm') {
                throw new Error("Cannot find module 'drizzle-orm'");
            }
            return undefined;
        });
        await assert.rejects(extract(missing), /Cannot load drizzle-orm from the project; install it there/);
    });
});
