-- Synthetic schema for the SQLite introspection tests.
CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL COLLATE NOCASE,
    slug TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT notes_slug UNIQUE (slug),
    CONSTRAINT notes_archived_flag CHECK (archived IN (0, 1))
);
CREATE INDEX notes_active_title ON notes (title) WHERE archived = 0;
CREATE INDEX notes_lower_title ON notes (lower(title));
CREATE INDEX notes_title_nocase ON notes (title COLLATE NOCASE DESC);
CREATE TABLE tags (
    note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    PRIMARY KEY (note_id, name)
);
CREATE TABLE tag_links (
    id INTEGER PRIMARY KEY,
    note_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY (note_id, tag) REFERENCES tags (note_id, name) DEFERRABLE INITIALLY DEFERRED
);
