-- The DDL of tests/fixtures/drizzle/parity-sqlite.mjs as drizzle-kit writes it (primary keys NOT NULL), for the
-- declared/database parity test.
CREATE TABLE customers (id integer PRIMARY KEY NOT NULL, email text NOT NULL, name text, CONSTRAINT customers_email_unique UNIQUE (email));
CREATE TABLE invoices (
    year integer NOT NULL,
    number integer NOT NULL,
    customer_id integer NOT NULL,
    total real NOT NULL DEFAULT 0,
    PRIMARY KEY (year, number),
    CONSTRAINT invoices_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
);
CREATE TABLE invoice_lines (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    invoice_year integer NOT NULL,
    invoice_number integer NOT NULL,
    note text,
    CONSTRAINT lines_invoice_fk FOREIGN KEY (invoice_year, invoice_number) REFERENCES invoices (year, number)
);
CREATE INDEX lines_note_idx ON invoice_lines (note);
