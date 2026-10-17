-- Index features MySQL 8 has and MariaDB lacks: functional key parts and invisible indexes.
CREATE INDEX products_color ON products ((CAST(attributes->>'$.color' AS CHAR(16))));
CREATE INDEX products_price ON products (price) INVISIBLE;
