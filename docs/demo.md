---
aside: false
---

# Explore a sample schema

The interactive viewer that `node-schema-viewer serve` serves, running entirely in your browser from synthetic laranex-schema 2.0 documents: the shared contract's fixtures for three connections (PostgreSQL, MySQL and SQLite) and for a primary and a replica compared.

<LiveDemo />

## Things to try

1. Pick a connection in the header's connection menu, or step through them with <kbd>[</kbd> and <kbd>]</kbd>.
2. Search for a table and select it to inspect its columns, indexes and constraints.
3. Toggle the foreign-key and ORM layers to compare constraints with declared relationships.
4. Choose **Primary and replica compared** and open the **Compare** tab (<kbd>X</kbd>) to browse the stored comparison's differences.
5. Zoom, pan, drag cards, and press <kbd>S</kbd> for the keyboard shortcuts.

The demo uses the exact viewer files of the `laranex-schema-viewer-ui` version this package depends on, as `serve` serves them, and the contract package's synthetic fixtures. It does not load a real application's schema, credentials, database or data rows.
