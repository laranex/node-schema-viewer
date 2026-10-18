// Synthetic Drizzle schema whose DDL is tests/databases/drizzle-postgresql.sql: the parity test compares the declared
// document with the database document of the same schema.
import { foreignKey, index, integer, numeric, pgSchema, pgTable, primaryKey, serial, text, varchar } from 'drizzle-orm/pg-core';

export const billing = pgSchema('billing');
export const customers = pgTable('customers', { id: serial('id').primaryKey(), email: varchar('email', { length: 255 }).notNull().unique(), name: text('name') });
export const invoices = billing.table('invoices', {
    year: integer('year').notNull(),
    number: integer('number').notNull(),
    customerId: integer('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    total: numeric('total', { precision: 10, scale: 2 }).notNull().default('0'),
}, (t) => [primaryKey({ columns: [t.year, t.number] })]);
export const lines = billing.table('invoice_lines', {
    id: serial('id').primaryKey(),
    invoiceYear: integer('invoice_year').notNull(),
    invoiceNumber: integer('invoice_number').notNull(),
    note: text('note'),
}, (t) => [
    foreignKey({ name: 'lines_invoice_fk', columns: [t.invoiceYear, t.invoiceNumber], foreignColumns: [invoices.year, invoices.number] }),
    index('lines_note_idx').on(t.note),
]);
