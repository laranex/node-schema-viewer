// Synthetic Drizzle schema whose DDL is tests/databases/drizzle-mysql.sql (parity test).
import { decimal, foreignKey, index, int, mysqlTable, primaryKey, text, varchar } from 'drizzle-orm/mysql-core';

export const customers = mysqlTable('customers', { id: int('id').autoincrement().primaryKey(), email: varchar('email', { length: 255 }).notNull().unique(), name: text('name') });
export const invoices = mysqlTable('invoices', {
    year: int('year').notNull(),
    number: int('number').notNull(),
    customerId: int('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    total: decimal('total', { precision: 10, scale: 2 }).notNull().default('0'),
}, (t) => [primaryKey({ columns: [t.year, t.number] })]);
export const lines = mysqlTable('invoice_lines', {
    id: int('id').autoincrement().primaryKey(),
    invoiceYear: int('invoice_year').notNull(),
    invoiceNumber: int('invoice_number').notNull(),
    note: varchar('note', { length: 100 }),
}, (t) => [
    foreignKey({ name: 'lines_invoice_fk', columns: [t.invoiceYear, t.invoiceNumber], foreignColumns: [invoices.year, invoices.number] }),
    index('lines_note_idx').on(t.note),
]);
