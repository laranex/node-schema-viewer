// Synthetic Drizzle schema with what the adapter cannot represent: views, a sequence, row-level security, a default
// Drizzle converts in JavaScript, an unrenderable check, a relation without its inverse, and references to a table
// that is not exported.
import { relations, sql } from 'drizzle-orm';
import { check, integer, pgMaterializedView, pgPolicy, pgSequence, pgTable, pgView, serial, text, timestamp } from 'drizzle-orm/pg-core';

const hidden = pgTable('hidden', { id: serial('id').primaryKey() });

export const items = pgTable('items', {
    id: serial('id').primaryKey(),
    hiddenId: integer('hidden_id').references(() => hidden.id),
    seenAt: timestamp('seen_at', { mode: 'date' }).default(new Date(0)),
    label: text('label'),
}, (t) => [
    check('items_label', sql`${t.label} <> ${sql.placeholder('forbidden')}`),
    pgPolicy('items_read', { for: 'select', using: sql`true` }),
]).enableRLS();

export const owners = pgTable('owners', { id: serial('id').primaryKey() });

export const itemsView = pgView('items_view').as((qb) => qb.select().from(items));
export const itemsCount = pgMaterializedView('items_count', { n: integer('n') }).existing();
export const counter = pgSequence('counter', { startWith: 1 });

export const itemsRelations = relations(items, ({ one, many }) => ({
    hidden: one(hidden, { fields: [items.hiddenId], references: [hidden.id] }),
    owners: many(owners),
}));
