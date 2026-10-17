-- Differs from tests/fixtures/drift_models.py on purpose; see that module.
CREATE TABLE teams (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, UNIQUE (name));
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    team_id INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'archived',
    legacy_flag BOOLEAN,
    CONSTRAINT users_email_length CHECK (length(email) > 3)
);
CREATE UNIQUE INDEX ix_users_email ON users (email);
CREATE TABLE memberships (
    user_id INTEGER NOT NULL REFERENCES users (id),
    team_id INTEGER NOT NULL REFERENCES teams (id),
    PRIMARY KEY (user_id, team_id)
);
CREATE TABLE order_lines (order_id INTEGER NOT NULL, line_no INTEGER NOT NULL, amount NUMERIC(10, 2) NOT NULL,
                          PRIMARY KEY (order_id, line_no));
CREATE TABLE line_notes (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    line_no INTEGER NOT NULL,
    CONSTRAINT line_notes_line_fk FOREIGN KEY (order_id, line_no) REFERENCES order_lines (order_id, line_no)
);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, payload TEXT);
