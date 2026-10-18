// Synthetic Drizzle schema whose DDL is tests/databases/drizzle-sqlite.sql (parity test).
import { foreignKey, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const customers = sqliteTable('customers', { id: integer('id').primaryKey(), email: text('email').notNull().unique(), name: text('name') });
export const invoices = sqliteTable('invoices', {
    year: integer('year').notNull(),
    number: integer('number').notNull(),
    customerId: integer('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    total: real('total').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.year, t.number] })]);
export const lines = sqliteTable('invoice_lines', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invoiceYear: integer('invoice_year').notNull(),
    invoiceNumber: integer('invoice_number').notNull(),
    note: text('note'),
}, (t) => [
    foreignKey({ name: 'lines_invoice_fk', columns: [t.invoiceYear, t.invoiceNumber], foreignColumns: [invoices.year, invoices.number] }),
    index('lines_note_idx').on(t.note),
]);
