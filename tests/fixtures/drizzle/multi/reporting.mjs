// Connection "reporting": its own users table, a foreign key into connection "app" (never a physical foreign key
// across connections) and a relation across connections.
import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { users as appUsers } from './app.mjs';

export const users = pgTable('users', { id: serial('id').primaryKey(), email: text('email') });
export const reports = pgTable('reports', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    appUserId: integer('app_user_id').references(() => appUsers.id),
});
export const reportsRelations = relations(reports, ({ one }) => ({
    user: one(users, { fields: [reports.userId], references: [users.id] }),
    appUser: one(appUsers, { fields: [reports.appUserId], references: [appUsers.id] }),
}));
