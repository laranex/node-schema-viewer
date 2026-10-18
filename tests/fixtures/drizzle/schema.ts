// Synthetic Drizzle schema in TypeScript, transpiled in the worker with the project's typescript package.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

interface Meta { tag: string }
const meta: Meta = { tag: 'ts' };

export const documents = sqliteTable('documents', { id: integer('id').primaryKey(), title: text('title').notNull().default(meta.tag) });
