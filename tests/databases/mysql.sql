-- Synthetic schema for the MySQL and MariaDB introspection tests. Statements are separated by ";\n".
CREATE TABLE accounts (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    email varchar(320) NOT NULL COMMENT 'Login address',
    PRIMARY KEY (id),
    UNIQUE KEY accounts_email_unique (email)
) COMMENT='Customer accounts';
CREATE TABLE products (
    id int unsigned NOT NULL AUTO_INCREMENT,
    sku varchar(32) NOT NULL,
    name varchar(255) COLLATE utf8mb4_bin NOT NULL,
    description text NOT NULL,
    location point NOT NULL,
    status enum('draft','live') NOT NULL DEFAULT 'draft',
    price decimal(10,2) NOT NULL DEFAULT 0.00,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attributes json,
    PRIMARY KEY (id),
    UNIQUE KEY products_sku_unique (sku),
    KEY products_name_prefix (name(10)),
    KEY products_status_created (status, created_at DESC),
    FULLTEXT KEY products_description_fulltext (description),
    SPATIAL KEY products_location_spatial (location),
    CONSTRAINT products_price_positive CHECK (price >= 0)
);
-- Composite primary key, and a composite foreign key onto it.
CREATE TABLE orders (
    account_id bigint unsigned NOT NULL,
    number int NOT NULL,
    placed_at datetime NOT NULL,
    PRIMARY KEY (account_id, number),
    CONSTRAINT orders_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);
CREATE TABLE order_lines (
    account_id bigint unsigned NOT NULL,
    order_number int NOT NULL,
    line_no smallint NOT NULL,
    product_id int unsigned NOT NULL,
    PRIMARY KEY (account_id, order_number, line_no),
    CONSTRAINT order_lines_order_fk FOREIGN KEY (account_id, order_number) REFERENCES orders (account_id, number)
        ON UPDATE CASCADE,
    CONSTRAINT order_lines_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
);
