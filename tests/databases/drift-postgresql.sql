-- Differs from tests/fixtures/drift_models.py on purpose; see that module.
CREATE TABLE teams (id serial PRIMARY KEY, name varchar(100) NOT NULL UNIQUE);
CREATE TABLE users (
    id serial PRIMARY KEY,
    email varchar(320) NOT NULL,
    team_id integer,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status varchar(20) NOT NULL DEFAULT 'archived',
    legacy_flag boolean,
    CONSTRAINT users_email_length CHECK (length(email) > 3)
);
CREATE UNIQUE INDEX ix_users_email ON users (email);
CREATE TABLE memberships (
    user_id integer NOT NULL REFERENCES users (id),
    team_id integer NOT NULL REFERENCES teams (id),
    PRIMARY KEY (user_id, team_id)
);
CREATE TABLE order_lines (order_id integer NOT NULL, line_no integer NOT NULL, amount numeric(10, 2) NOT NULL,
                          PRIMARY KEY (order_id, line_no));
CREATE TABLE line_notes (
    id serial PRIMARY KEY,
    order_id integer NOT NULL,
    line_no integer NOT NULL,
    CONSTRAINT line_notes_line_fk FOREIGN KEY (order_id, line_no) REFERENCES order_lines (order_id, line_no)
);
CREATE TABLE audit_log (id serial PRIMARY KEY, payload jsonb);
