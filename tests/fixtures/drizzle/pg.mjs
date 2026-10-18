// Synthetic Drizzle schema (pg-core): composite keys, cross-schema foreign keys, every index feature Drizzle declares,
// checks, identity and generated columns, enums, and relations.
import { relations, sql } from 'drizzle-orm';
import {
    check, foreignKey, index, integer, jsonb, pgEnum, pgSchema, pgTable, primaryKey, serial, text, timestamp, unique, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';

export const billing = pgSchema('billing');
export const status = pgEnum('status', ['draft', 'published', 'archived']);

export const users = pgTable('users', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity({ startWith: 100 }),
    email: varchar('email', { length: 255 }).notNull().unique(),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    token: uuid('token').defaultRandom(),
    settings: jsonb('settings').default({ theme: 'dark' }),
    nickname: text('nickname').$defaultFn(function nickname() { return 'anon'; }),
}, (t) => [
    index('users_lower_email').on(sql`lower(${t.email})`),
    index('users_name_partial').on(t.name.desc()).where(sql`${t.name} IS NOT NULL`),
    check('users_email_shape', sql`position('@' in ${t.email}) > 1`),
]);

export const posts = pgTable('posts', {
    id: serial('id').primaryKey(),
    authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }).notNull().default('untitled'),
    state: status('state').notNull().default('draft'),
    views: integer('views').notNull().default(0),
    score: integer('score').generatedAlwaysAs(sql`views * 2`),
}, (t) => [
    uniqueIndex('posts_author_title').on(t.authorId, t.title.op('text_pattern_ops')),
    index('posts_views').using('brin', t.views),
]);

export const tags = pgTable('tags', {
    postId: integer('post_id').notNull(),
    label: text('label').notNull(),
}, (t) => [
    primaryKey({ columns: [t.postId, t.label] }),
    foreignKey({ name: 'tags_post_fk', columns: [t.postId], foreignColumns: [posts.id] }).onDelete('set null').onUpdate('restrict'),
]);

export const invoices = billing.table('invoices', {
    number: integer('number').notNull(),
    year: integer('year').notNull(),
    userId: integer('user_id').notNull().references(() => users.id),
}, (t) => [primaryKey({ columns: [t.year, t.number] }), unique('invoices_user_year').on(t.userId, t.year).nullsNotDistinct()]);

export const lines = billing.table('invoice_lines', {
    id: serial('id').primaryKey(),
    invoiceYear: integer('invoice_year').notNull(),
    invoiceNumber: integer('invoice_number').notNull(),
}, (t) => [foreignKey({ columns: [t.invoiceYear, t.invoiceNumber], foreignColumns: [invoices.year, invoices.number] })]);

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts), invoices: many(invoices) }));
export const postsRelations = relations(posts, ({ one, many }) => ({
    author: one(users, { fields: [posts.authorId], references: [users.id] }),
    tags: many(tags),
}));
export const tagsRelations = relations(tags, ({ one }) => ({ post: one(posts, { fields: [tags.postId], references: [posts.id] }) }));
export const invoicesRelations = relations(invoices, ({ one }) => ({ user: one(users, { fields: [invoices.userId], references: [users.id] }) }));
