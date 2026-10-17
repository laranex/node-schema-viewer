"""Record python-schema-viewer's laranex-schema 2.0 introspection documents for the synthetic schemas in tests/databases/.

Read-only use of a python-schema-viewer checkout that writes laranex-schema 2.0, with its environment (SQLAlchemy,
psycopg, PyMySQL), against disposable servers (tests/databases/compose.yaml):

    export LSV_TEST_POSTGRES_URL=postgresql+psycopg://postgres:lsv-admin@127.0.0.1:55432/lsv
    export LSV_TEST_MYSQL_URL=mysql+pymysql://root:lsv-admin@127.0.0.1:53306/lsv
    export LSV_TEST_MARIADB_URL=mysql+pymysql://root:lsv-admin@127.0.0.1:53307/lsv
    PYTHONPATH=<python-schema-viewer>/src python -B <node-repo>/scripts/record-database-conformance.py <node-repo>

For every case it creates a database and a read-only role with random names and a random password, loads the
case's DDL, inspects it with python-schema-viewer's introspection worker as that role, and drops both. The random
MySQL/MariaDB database name (the default schema) is replaced by "<database>". Writes only into
<node-repo>/tests/fixtures/conformance/database/, canonically. tests/introspection-conformance.test.ts compares the
Node.js documents with these after normalizing the generator. Regenerate only for an intended change on both sides.
"""

import os
import secrets
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from laranex_schema_viewer.contract import canonical_json, document_to_json
from laranex_schema_viewer.introspection import DatabaseRequest
from laranex_schema_viewer.introspection.runner import introspect, introspect_all

NODE = Path(sys.argv[1]).resolve()
DATABASES = NODE / "tests/databases"
OUT = NODE / "tests/fixtures/conformance/database"
PLACEHOLDER = "<database>"

# name -> (server, DDL files, schemas)
CASES = {
    "postgresql": ("postgres", ["postgresql.sql"], ["public", "billing"]),
    "postgresql-default-schema": ("postgres", ["postgresql.sql"], []),
    "drift-postgresql": ("postgres", ["drift-postgresql.sql"], []),
    "mysql": ("mysql", ["mysql.sql", "mysql-functional.sql"], []),
    "drift-mysql": ("mysql", ["drift-mysql.sql"], []),
    "mariadb": ("mariadb", ["mysql.sql"], []),
    "drift-mariadb": ("mariadb", ["drift-mysql.sql"], []),
    "sqlite": ("sqlite", ["sqlite.sql"], []),
    "drift-sqlite": ("sqlite", ["drift-sqlite.sql"], []),
}
VARIABLES = {"postgres": "LSV_TEST_POSTGRES_URL", "mysql": "LSV_TEST_MYSQL_URL", "mariadb": "LSV_TEST_MARIADB_URL"}


def statements(path: Path):
    for statement in path.read_text().split(";\n"):
        body = "\n".join(line for line in statement.splitlines() if not line.startswith("--")).strip()
        if body:
            yield body


class Database:
    """A disposable database with a read-only role; the URL of that role is `url`."""

    def __init__(self, server: str, files: list[str]):
        self.server = server
        suffix = secrets.token_hex(4)
        self.name = f"lsv_rec_{suffix}"
        if server == "sqlite":
            self.dir = Path(tempfile.mkdtemp(prefix="lsv-rec-")).resolve()
            path = self.dir / "schema.db"
            with closing(sqlite3.connect(path)) as connection:
                for file in files:
                    connection.executescript((DATABASES / file).read_text())
            self.url = f"sqlite:///{path}"
            return
        self.admin_url = make_url(os.environ[VARIABLES[server]])
        self.role, password = f"lsv_rec_{suffix}", secrets.token_hex(12)
        self.admin = create_engine(self.admin_url, isolation_level="AUTOCOMMIT")
        with self.admin.connect() as c:
            if server == "postgres":
                c.exec_driver_sql(f'CREATE DATABASE "{self.name}"')
                c.exec_driver_sql(f"CREATE ROLE \"{self.role}\" LOGIN PASSWORD '{password}'")
            else:
                c.exec_driver_sql(f"CREATE DATABASE `{self.name}`")
                c.exec_driver_sql(f"CREATE USER '{self.role}'@'%%' IDENTIFIED BY '{password}'")
                c.exec_driver_sql(f"GRANT SELECT ON `{self.name}`.* TO '{self.role}'@'%%'")
        engine = create_engine(self.admin_url.set(database=self.name))
        with engine.begin() as c:
            for file in files:
                if server == "postgres":
                    c.exec_driver_sql((DATABASES / file).read_text())
                else:
                    for statement in statements(DATABASES / file):
                        c.exec_driver_sql(statement.replace("%", "%%"))
            if server == "postgres":
                c.exec_driver_sql(f'GRANT CONNECT ON DATABASE "{self.name}" TO "{self.role}"')
                schemas = ", ".join(r[0] for r in c.exec_driver_sql(
                    "SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'billing')"))
                c.exec_driver_sql(f'GRANT USAGE ON SCHEMA {schemas} TO "{self.role}"')
        engine.dispose()
        self.url = self.admin_url.set(database=self.name, username=self.role, password=password).render_as_string(
            hide_password=False)

    def drop(self) -> None:
        if self.server == "sqlite":
            for path in self.dir.iterdir():
                path.unlink()
            self.dir.rmdir()
            return
        with self.admin.connect() as c:
            if self.server == "postgres":
                c.exec_driver_sql(f'DROP DATABASE IF EXISTS "{self.name}" WITH (FORCE)')
                c.exec_driver_sql(f'DROP ROLE IF EXISTS "{self.role}"')
            else:
                c.exec_driver_sql(f"DROP DATABASE IF EXISTS `{self.name}`")
                c.exec_driver_sql(f"DROP USER IF EXISTS '{self.role}'@'%%'")
        self.admin.dispose()


def placeholder(value, name: str):
    if isinstance(value, dict):
        return {k: placeholder(v, name) for k, v in value.items()}
    if isinstance(value, list):
        return [placeholder(v, name) for v in value]
    if isinstance(value, str):
        return value.replace(name, PLACEHOLDER)
    return value


def write(name: str, document, names: list[str]) -> None:
    data = document_to_json(document)
    for database_name in names:
        data = placeholder(data, database_name)
    path = OUT / f"{name}.json"
    path.write_text(canonical_json(data), encoding="utf-8")
    print(f"wrote {path.relative_to(NODE)}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (server, files, schemas) in CASES.items():
        if server != "sqlite" and not os.environ.get(VARIABLES[server]):
            print(f"skipped {name}: set {VARIABLES[server]}")
            continue
        database = Database(server, files)
        try:
            document = introspect(DatabaseRequest(url=database.url, schemas=tuple(schemas)))
        finally:
            database.drop()
        write(name, document, [database.name])
    # Several connections with mixed drivers and duplicate table names (the drift schemas share them).
    if all(os.environ.get(VARIABLES[s]) for s in ("postgres", "mysql")):
        databases = {"default": Database("postgres", ["drift-postgresql.sql"]),
                     "analytics": Database("mysql", ["drift-mysql.sql"]),
                     "local": Database("sqlite", ["drift-sqlite.sql"])}
        try:
            document = introspect_all([DatabaseRequest(url=d.url, connection=n) for n, d in databases.items()])
        finally:
            for database in databases.values():
                database.drop()
        write("multi-connection", document, [d.name for d in databases.values()])


if __name__ == "__main__":
    main()
