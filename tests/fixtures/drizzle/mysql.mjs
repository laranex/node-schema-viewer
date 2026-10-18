// Synthetic Drizzle schema (mysql-core): a database-qualified table, auto-increment, enums, composite keys, index
// options, a check and one-to-one relations.
import { relations, sql } from 'drizzle-orm';
import { check, foreignKey, index, int, mysqlEnum, mysqlSchema, mysqlTable, primaryKey, serial, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

export const audit = mysqlSchema('audit');

export const accounts = mysqlTable('accounts', {
    id: int('id').autoincrement().primaryKey(),
    handle: varchar('handle', { length: 64 }).notNull(),
    plan: mysqlEnum('plan', ['free', 'pro']).notNull().default('free'),
    bio: text('bio'),
}, (t) => [
    uniqueIndex('accounts_handle').on(t.handle).using('btree').algorithm('inplace'),
    index('accounts_lower_handle').on(sql`(lower(${t.handle}))`),
    check('accounts_handle_length', sql`char_length(${t.handle}) > 2`),
]);

export const profiles = mysqlTable('profiles', {
    accountId: int('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    avatar: varchar('avatar', { length: 255 }).default('default.png'),
});

export const memberships = mysqlTable('memberships', {
    accountId: int('account_id').notNull(),
    teamId: int('team_id').notNull(),
}, (t) => [
    primaryKey({ columns: [t.accountId, t.teamId] }),
    foreignKey({ name: 'memberships_account', columns: [t.accountId], foreignColumns: [accounts.id] }),
]);

export const events = audit.table('events', {
    id: serial('id').primaryKey(),
    accountId: int('account_id').references(() => accounts.id),
});

export const accountsRelations = relations(accounts, ({ one, many }) => ({ profile: one(profiles), memberships: many(memberships) }));
export const profilesRelations = relations(profiles, ({ one }) => ({ account: one(accounts, { fields: [profiles.accountId], references: [accounts.id] }) }));
export const membershipsRelations = relations(memberships, ({ one }) => ({ account: one(accounts, { fields: [memberships.accountId], references: [accounts.id] }) }));
