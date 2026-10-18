# Supported ORMs

[`build --source declared`](./build.md) reads your ORM schema modules in an isolated extraction worker ([isolation and security](./security.md)) and writes a laranex-schema 2.0 document. Adapters are added one at a time; for an ORM without one, [`build --source database`](./build.md) reads the live catalogs read-only and needs no ORM.

| ORM | Status | Notes |
| --- | --- | --- |
| Drizzle | **Supported** (`drizzle-orm` 0.36 to 0.45) | `pg-core`, `mysql-core` and `sqlite-core`; relations v1 (`relations()`). 1.0 beta/rc is refused. See [Drizzle ORM](./build.md#drizzle-orm) |
| TypeORM | Planned, not yet available | |
| MikroORM | Planned, not yet available | |
| Sequelize v6 | Planned, not yet available | |

Every adapter produces the same laranex-schema 2.0 document, so the viewer, the MCP tools, `compare` and `check` work the same for every ORM. Physical foreign keys and declared ORM relationships stay separate layers of that document.

## Out of scope

These are not supported and not planned:

- **Prisma**, which has its own schema viewer (Prisma Studio).
- **Kysely**, **Knex** and **Objection**.
- **Sequelize v7** (alpha); only Sequelize v6 is planned.

To document a database that any of these manage, read its catalogs with [database introspection](./database.md) instead: it needs no ORM at all.
