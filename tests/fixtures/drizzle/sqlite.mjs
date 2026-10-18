// Synthetic Drizzle schema (sqlite-core): rowid keys, autoincrement, a composite primary key, a partial index,
// self-referencing named relations, a timestamp default and a stored generated column.
import { relations, sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const nodes = sqliteTable('nodes', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parentId: integer('parent_id').references(() => nodes.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    kind: text('kind', { enum: ['file', 'folder'] }).notNull().default('file'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    weight: real('weight').default(1.5),
    slug: text('slug').generatedAlwaysAs(sql`lower(label)`, { mode: 'stored' }),
}, (t) => [
    index('nodes_active_label').on(t.label).where(sql`${t.active} = 1`),
    unique('nodes_parent_label').on(t.parentId, t.label),
    check('nodes_weight', sql`${t.weight} >= 0`),
]);

export const versions = sqliteTable('versions', {
    nodeId: integer('node_id').notNull().references(() => nodes.id),
    number: integer('number').notNull(),
    body: text('body'),
}, (t) => [primaryKey({ columns: [t.nodeId, t.number] })]);

export const plain = sqliteTable('plain', { id: integer('id').primaryKey(), note: text('note') });

export const nodesRelations = relations(nodes, ({ one, many }) => ({
    parent: one(nodes, { fields: [nodes.parentId], references: [nodes.id], relationName: 'tree' }),
    children: many(nodes, { relationName: 'tree' }),
    versions: many(versions),
}));
export const versionsRelations = relations(versions, ({ one }) => ({ node: one(nodes, { fields: [versions.nodeId], references: [nodes.id] }) }));
