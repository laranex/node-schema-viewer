# Supported ORMs

Building a declared document from Node.js ORM definitions (`build`) is **not available yet**. The isolation layer it runs on is in place and tested ([isolation and security](./security.md)); the ORM adapters are added on top of it one at a time. Until then, `serve`, `mcp`, `compare` and `check` read documents written by another Laranex producer or by the [database introspection API](./database.md).

| ORM | Status | Notes |
| --- | --- | --- |
| Drizzle | **In development**, not yet available | The first adapter being built |
| TypeORM | Planned, not yet available | |
| MikroORM | Planned, not yet available | |
| Sequelize v6 | Planned, not yet available | |

Every adapter will produce the same laranex-schema 2.0 document, so the viewer, the MCP tools, `compare` and `check` will work the same for every ORM. Physical foreign keys and declared ORM relationships stay separate layers of that document.

## Out of scope

These are not supported and not planned:

- **Prisma**, which has its own schema viewer (Prisma Studio).
- **Kysely**, **Knex** and **Objection**.
- **Sequelize v7** (alpha); only Sequelize v6 is planned.

To document a database that any of these manage, read its catalogs with [database introspection](./database.md) instead: it needs no ORM at all.
