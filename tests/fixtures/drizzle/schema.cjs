// Synthetic Drizzle schema as a CommonJS module.
const { integer, sqliteTable, text } = require('drizzle-orm/sqlite-core');

exports.notes = sqliteTable('notes', { id: integer('id').primaryKey(), body: text('body').notNull() });
