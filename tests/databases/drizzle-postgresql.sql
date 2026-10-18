-- The DDL of tests/fixtures/drizzle/parity-pg.mjs, for the declared/database parity test.
CREATE SCHEMA billing;
CREATE TABLE public.customers (id serial PRIMARY KEY, email varchar(255) NOT NULL, name text, CONSTRAINT customers_email_unique UNIQUE (email));
CREATE TABLE billing.invoices (
    year integer NOT NULL,
    number integer NOT NULL,
    customer_id integer NOT NULL,
    total numeric(10, 2) NOT NULL DEFAULT '0',
    PRIMARY KEY (year, number),
    CONSTRAINT invoices_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES public.customers (id) ON DELETE CASCADE
);
CREATE TABLE billing.invoice_lines (
    id serial PRIMARY KEY,
    invoice_year integer NOT NULL,
    invoice_number integer NOT NULL,
    note text,
    CONSTRAINT lines_invoice_fk FOREIGN KEY (invoice_year, invoice_number) REFERENCES billing.invoices (year, number)
);
CREATE INDEX lines_note_idx ON billing.invoice_lines (note);
