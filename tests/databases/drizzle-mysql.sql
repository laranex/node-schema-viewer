-- The DDL of tests/fixtures/drizzle/parity-mysql.mjs, for the declared/database parity test.
CREATE TABLE customers (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, email varchar(255) NOT NULL, name text, CONSTRAINT customers_email_unique UNIQUE (email));
CREATE TABLE invoices (
    year int NOT NULL,
    number int NOT NULL,
    customer_id int NOT NULL,
    total decimal(10, 2) NOT NULL DEFAULT '0',
    PRIMARY KEY (year, number),
    CONSTRAINT invoices_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
);
CREATE TABLE invoice_lines (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    invoice_year int NOT NULL,
    invoice_number int NOT NULL,
    note varchar(100),
    CONSTRAINT lines_invoice_fk FOREIGN KEY (invoice_year, invoice_number) REFERENCES invoices (year, number)
);
CREATE INDEX lines_note_idx ON invoice_lines (note);
