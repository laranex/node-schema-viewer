-- Differs from tests/fixtures/drift_models.py on purpose; see that module. Statements are separated by ";\n".
CREATE TABLE teams (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL, UNIQUE KEY name (name));
CREATE TABLE users (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email varchar(320) NOT NULL,
    team_id int,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status varchar(20) NOT NULL DEFAULT 'archived',
    legacy_flag boolean,
    UNIQUE KEY ix_users_email (email),
    CONSTRAINT users_email_length CHECK (length(email) > 3)
);
CREATE TABLE memberships (
    user_id int NOT NULL,
    team_id int NOT NULL,
    PRIMARY KEY (user_id, team_id),
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (team_id) REFERENCES teams (id)
);
CREATE TABLE order_lines (order_id int NOT NULL, line_no int NOT NULL, amount decimal(10, 2) NOT NULL,
                          PRIMARY KEY (order_id, line_no));
CREATE TABLE line_notes (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id int NOT NULL,
    line_no int NOT NULL,
    CONSTRAINT line_notes_line_fk FOREIGN KEY (order_id, line_no) REFERENCES order_lines (order_id, line_no)
);
CREATE TABLE audit_log (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, payload json)
