// Connection "app" of a two-connection synthetic schema.
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', { id: serial('id').primaryKey(), name: text('name').notNull() });
export const teams = pgTable('teams', { id: serial('id').primaryKey(), ownerId: integer('owner_id').references(() => users.id) });
