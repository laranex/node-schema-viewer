// Synthetic Drizzle schema whose columns take their names from their keys (drizzle({ casing: 'snake_case' })).
import { relations } from 'drizzle-orm';
import { index, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const authors = pgTable('authors', { id: serial().primaryKey(), displayName: text().notNull() }, (t) => [index('authors_display').on(t.displayName)]);
export const books = pgTable('books', { bookId: serial().primaryKey(), authorId: integer().references(() => authors.id), title: text('Title') });
export const booksRelations = relations(books, ({ one }) => ({ author: one(authors, { fields: [books.authorId], references: [authors.id] }) }));
