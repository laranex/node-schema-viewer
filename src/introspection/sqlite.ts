// SQLite catalogs, read as python-schema-viewer reads them: SQLAlchemy's SQLite Inspector (PRAGMAs plus parsing of the
// CREATE TABLE text, ported below from sqlalchemy/dialects/sqlite/base.py) and its own index PRAGMAs and CREATE INDEX
// parsing (introspection/catalog.py).
import {
    action,
    column,
    findMatchingParen,
    identifier,
    indexEntry,
    owner,
    part,
    pyStrip,
    referencedColumns,
    splitTopLevel,
    str,
    text,
    type ColumnFacts,
    type Constraint,
    type ForeignKey,
    type Index,
    type Part,
    type Row,
    type Table,
} from './common.js';
import type { Session } from './readonly.js';

const TIME_TYPES = new Set(['DATETIME', 'DATETIME_CHAR', 'TIME', 'TIME_CHAR', 'TIMESTAMP']);
const FOREIGN_KEY =
    /(?:CONSTRAINT\s+(?:"(.+?)"|(\w+))\s+)?FOREIGN\s+KEY\s*\(\s*(.+?)\s*\)\s+REFERENCES\s+(?:(?:"(.+?)")|([a-z0-9_]+))\s*\(\s*((?:"[^"]+"|[a-z0-9_]+)(?:(?:\s*,\s*|\s+)(?:"[^"]+"|[a-z0-9_]+))*\s*)\)\s*((?:ON\s+(?:DELETE|UPDATE)\s+(?:SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT|NO\s+ACTION)\s*)*)((?:NOT\s+)?DEFERRABLE)?(?:\s+INITIALLY\s+(DEFERRED|IMMEDIATE))?/gi;
const UNIQUE = /(?:CONSTRAINT\s+(?:"(.+?)"|(\w+))\s+)?UNIQUE\s*\((.+?)\)/gi;
const INLINE_UNIQUE = /(?:(".+?")|(?:[[`])?([a-z0-9_]+)(?:[\]`])?)[\t ]+[a-z0-9_]+(?:[\t ]+[a-z0-9_]+)*?[\t ]+UNIQUE/gi;
const CHECK =
    /(?<![A-Za-z0-9_])(?:CONSTRAINT\s+("(?:[^"]|"")+"|'(?:[^']|'')+'|\[(?:[^\]]|\]\])+\]|`(?:[^`]|``)+`|\S+)\s+)?CHECK\s*\(/gi;

interface SqliteColumn {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    primaryKey: number;
    computed: { sqltext: string; persisted: boolean } | null;
}

interface SqliteForeignKey {
    name: string | null;
    columns: string[];
    table: string;
    referred: string[];
    options: { ondelete?: string; onupdate?: string; deferrable?: boolean; initially?: string };
}

export function quoteSqlite(name: string): string {
    return `"${name.split('"').join('""')}"`;
}

function columnsInSignature(signature: string): string[] {
    return [...signature.matchAll(/(?:"(.+?)")|([a-z0-9_]+)/gi)].map((m) => m[1] ?? m[2] ?? '');
}

// SQLAlchemy's _resolve_type_affinity, reduced to the timezone attribute python-schema-viewer reads.
function timezone(declared: string): boolean | null {
    const match = /^([\w ]+)(\(.*?\))?/.exec(declared);
    return TIME_TYPES.has(match?.[1] ?? '') ? false : null;
}

// The key list and WHERE clause of a CREATE INDEX statement (python-schema-viewer's sqlite_index_sql).
export function indexSql(sql: string): { keys: string[]; predicate: string | null } {
    const on = /\bON\b/i.exec(sql);
    const start = sql.indexOf('(', on === null ? 0 : on.index + on[0].length);
    let depth = 0;
    let end = start;
    for (let i = start; i < sql.length; i += 1) {
        end = i;
        depth += sql[i] === '(' ? 1 : 0;
        depth -= sql[i] === ')' ? 1 : 0;
        if (depth === 0) {
            break;
        }
    }
    const rest = pyStrip(sql.slice(end + 1));
    const where = /^WHERE\s+([\s\S]*)$/i.exec(rest);
    return {
        keys: splitTopLevel(sql.slice(start + 1, end)),
        predicate: where === null ? null : pyStrip(pyStrip(where[1] ?? '').replace(/;+$/, '')),
    };
}

export class SQLiteReader {
    private readonly sqlCache = new Map<string, string | null>();

    constructor(
        private readonly session: Session,
        private readonly tableId: (schema: string | null, table: string) => string,
    ) {}

    private rows(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
        return this.session.rows(sql, params);
    }

    // PRAGMA main.x(...), then temp.x(...) when main has no rows.
    private async pragma(name: string, argument: string): Promise<Row[]> {
        for (const prefix of ['main.', 'temp.']) {
            const found = await this.rows(`PRAGMA ${prefix}${name}(${quoteSqlite(argument)})`);
            if (found.length > 0) {
                return found;
            }
        }
        return [];
    }

    private async tableSql(table: string): Promise<string | null> {
        if (!this.sqlCache.has(table)) {
            const found = await this.rows(
                "SELECT sql FROM (SELECT * FROM sqlite_master UNION ALL SELECT * FROM sqlite_temp_master) WHERE name = ? AND type in ('table', 'view')",
                [table],
            );
            this.sqlCache.set(table, text(found[0]?.[0]));
        }
        return this.sqlCache.get(table) ?? null;
    }

    async tables(): Promise<Table[]> {
        const names = (await this.rows("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite~_%' ESCAPE '~' ORDER BY name")).map((r) =>
            str(r[0]),
        );
        const tables: Table[] = [];
        for (const name of names) {
            tables.push(await this.table(name));
        }
        return tables;
    }

    private async columns(table: string): Promise<SqliteColumn[]> {
        const xinfo = (this.session.version[0] ?? 0) > 3 || ((this.session.version[0] ?? 0) === 3 && (this.session.version[1] ?? 0) >= 31);
        let tableText: string | null = null;
        const out: SqliteColumn[] = [];
        for (const row of await this.pragma(xinfo ? 'table_xinfo' : 'table_info', table)) {
            const hidden = xinfo ? Number(row[6]) : 0;
            if (hidden === 1) {
                continue;
            }
            const name = str(row[1]);
            let computed: SqliteColumn['computed'] = null;
            if (hidden === 2 || hidden === 3) {
                if (tableText === null) {
                    const match = /^create table .*?\(([\s\S]*)\)(?:\s*,?\s*(?:WITHOUT\s+ROWID|STRICT))*$/i.exec(pyStrip((await this.tableSql(table)) ?? ''));
                    tableText = pyStrip(match?.[1] ?? '');
                }
                const found = new RegExp(`${escape(name)}[^,]*\\s+GENERATED\\s+ALWAYS\\s+AS\\s+\\(([\\s\\S]*)\\)\\s*(?:virtual|stored)?`, 'i').exec(tableText);
                computed = { sqltext: found?.[1] ?? '', persisted: hidden === 3 };
            }
            let declared = str(row[2]).toUpperCase();
            if (computed !== null) {
                declared = pyStrip(declared.replace(/generated/gi, '').replace(/always/gi, ''));
            }
            out.push({ name, type: declared, nullable: !Number(row[3]), default: text(row[4]), primaryKey: Number(row[5]), computed });
        }
        return out;
    }

    private async primaryKey(table: string): Promise<string[]> {
        return (await this.columns(table))
            .filter((c) => c.primaryKey > 0)
            .sort((a, b) => a.primaryKey - b.primaryKey)
            .map((c) => c.name);
    }

    private async foreignKeys(table: string): Promise<SqliteForeignKey[]> {
        const byId = new Map<number, SqliteForeignKey>();
        for (const row of await this.pragma('foreign_key_list', table)) {
            const id = Number(row[0]);
            const target = str(row[2]);
            const local = str(row[3]);
            const remote = text(row[4]);
            let fk = byId.get(id);
            if (fk === undefined) {
                let referred: string[] = [];
                if (!remote) {
                    // No referred column in the DDL: the referred table's primary key.
                    referred = await this.primaryKey(target);
                }
                fk = { name: null, columns: [], table: target, referred, options: {} };
                byId.set(id, fk);
            }
            fk.columns.push(local);
            if (remote) {
                fk.referred.push(remote);
            }
        }
        const signature = (columns: string[], target: string, referred: string[]): string => JSON.stringify([...columns, target, ...referred]);
        const bySignature = new Map<string, SqliteForeignKey>();
        for (const fk of byId.values()) {
            bySignature.set(signature(fk.columns, fk.table, fk.referred), fk);
        }
        const keys: SqliteForeignKey[] = [];
        const sql = await this.tableSql(table);
        for (const match of sql === null ? [] : sql.matchAll(FOREIGN_KEY)) {
            const constrained = columnsInSignature(match[3] ?? '');
            const referred = match[6] ? columnsInSignature(match[6]) : constrained;
            const key = signature(constrained, match[4] ?? match[5] ?? '', referred);
            const fk = bySignature.get(key);
            if (fk === undefined) {
                continue;
            }
            bySignature.delete(key);
            const options: SqliteForeignKey['options'] = {};
            const clauses = pyStrip((match[7] ?? '').toUpperCase().replace(/\s+/g, ' '));
            for (const token of clauses.split(/ *\bON\b */)) {
                if (token.startsWith('DELETE')) {
                    const value = pyStrip(token.slice(6));
                    if (value && value !== 'NO ACTION') {
                        options.ondelete = value;
                    }
                } else if (token.startsWith('UPDATE')) {
                    const value = pyStrip(token.slice(6));
                    if (value && value !== 'NO ACTION') {
                        options.onupdate = value;
                    }
                }
            }
            if (match[8]) {
                options.deferrable = !match[8].toUpperCase().includes('NOT');
            }
            if (match[9]) {
                options.initially = match[9].toUpperCase();
            }
            fk.name = match[1] ?? match[2] ?? null;
            fk.options = options;
            keys.push(fk);
        }
        keys.push(...bySignature.values());
        return keys;
    }

    // SQLAlchemy's get_unique_constraints: UNIQUE clauses of the table SQL that match an automatic index.
    private async uniques(table: string): Promise<{ name: string | null; columns: string[] }[]> {
        const indexes: { name: string; columns: string[] }[] = [];
        for (const row of await this.pragma('index_list', table)) {
            const name = str(row[1]);
            const info = await this.pragma('index_info', name);
            if (info.some((r) => r[2] === null)) {
                continue;
            }
            indexes.push({ name, columns: info.map((r) => str(r[2])) });
        }
        const automatic = new Map<string, { name: string; columns: string[] }>();
        for (const index of indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            if (index.name.startsWith('sqlite_autoindex')) {
                automatic.set(JSON.stringify(index.columns), index);
            }
        }
        const sql = (await this.tableSql(table)) ?? '';
        const parsed: { name: string | null; columns: string[] }[] = [
            ...[...sql.matchAll(UNIQUE)].map((m) => ({ name: m[1] ?? m[2] ?? null, columns: columnsInSignature(m[3] ?? '') })),
            ...[...sql.matchAll(INLINE_UNIQUE)].map((m) => ({ name: null, columns: columnsInSignature(m[1] ?? m[2] ?? '') })),
        ];
        const out: { name: string | null; columns: string[] }[] = [];
        for (const constraint of parsed) {
            const key = JSON.stringify(constraint.columns);
            if (automatic.has(key)) {
                automatic.delete(key);
                out.push(constraint);
            }
        }
        return out;
    }

    private async checks(table: string): Promise<{ name: string | null; sqltext: string }[]> {
        const sql = (await this.tableSql(table)) ?? '';
        const out: { name: string | null; sqltext: string }[] = [];
        for (const match of sql.matchAll(CHECK)) {
            let name = match[1] ?? null;
            if (name !== null) {
                const unquoted = /^(["'`])([\s\S]+)\1$|^\[([\s\S]+)\]$/.exec(name);
                if (unquoted !== null) {
                    name = unquoted[2] ?? unquoted[3] ?? name;
                }
            }
            const end = match.index + match[0].length;
            const close = findMatchingParen(sql, end - 1);
            if (close !== null) {
                out.push({ name, sqltext: pyStrip(sql.slice(end, close)) });
            }
        }
        return out.sort((a, b) => {
            const x = a.name ?? '~';
            const y = b.name ?? '~';
            return x < y ? -1 : x > y ? 1 : 0;
        });
    }

    private async table(name: string): Promise<Table> {
        const tid = this.tableId(null, name);
        const natives = new Map<string, string>();
        for (const row of await this.rows(`PRAGMA table_xinfo(${quoteSqlite(name)})`)) {
            natives.set(str(row[1]), str(row[2]));
        }
        const columns = await this.columns(name);
        const pk = await this.primaryKey(name);
        const uniques = await this.uniques(name);
        const checks = await this.checks(name);
        const actions = await this.actions(name);
        const facts: ColumnFacts[] = columns.map((c) => ({
            name: c.name,
            native: natives.get(c.name) ?? '',
            isEnum: false,
            enumName: null,
            enumValues: [],
            nullable: c.nullable,
            autoIncrement: false,
            timezone: timezone(c.type),
            collation: null,
            default: c.default,
            identity: null,
            computed: c.computed,
            comment: null,
        }));
        const foreignKeys: ForeignKey[] = (await this.foreignKeys(name)).map((fk) => {
            const target = this.tableId(null, fk.table);
            const options = { ...fk.options, ...actions.get(JSON.stringify(fk.columns)) };
            return {
                id: identifier('foreign_key', tid, fk.name, identifier(...fk.columns), target, identifier(...fk.referred)),
                name: fk.name,
                columns: fk.columns,
                foreignTable: target,
                foreignColumns: fk.referred,
                onUpdate: action(options.onupdate || 'NO ACTION'),
                onDelete: action(options.ondelete || 'NO ACTION'),
                deferrable: options.deferrable ?? false,
                initially: (options.initially || 'IMMEDIATE').toUpperCase(),
                provenance: ['database'],
            };
        });
        const names = facts.map((c) => c.name);
        const constraints: Constraint[] = [
            ...uniques.map((u, n): Constraint => ({
                id: `${tid}:constraint:${u.name ? u.name : String(n)}`,
                kind: 'unique',
                name: u.name,
                columns: u.columns,
                expression: null,
                provenance: ['database'],
            })),
            ...checks.map((ck, n): Constraint => ({
                id: `${tid}:constraint:${ck.name ? ck.name : `check${String(n)}`}`,
                kind: 'check',
                name: ck.name,
                columns: referencedColumns(ck.sqltext, names),
                expression: ck.sqltext,
                provenance: ['database'],
            })),
        ];
        return {
            id: tid,
            name,
            schema: null,
            comment: null,
            note: null,
            owner: owner(name),
            primaryKey: pk,
            columns: facts.map((c) => column(c, pk.length === 1 && pk[0] === c.name && c.native.toUpperCase() === 'INTEGER')),
            indexes: await this.indexes(name, tid, uniques),
            foreignKeys,
            constraints,
            provenance: ['database'],
        };
    }

    // Referential actions from PRAGMA foreign_key_list, by constrained columns; the parsed DDL misses column-level clauses.
    private async actions(table: string): Promise<Map<string, { onupdate: string; ondelete: string }>> {
        const grouped = new Map<number, Row[]>();
        for (const row of await this.rows(`PRAGMA foreign_key_list(${quoteSqlite(table)})`)) {
            const id = Number(row[0]);
            grouped.set(id, [...(grouped.get(id) ?? []), row]);
        }
        const out = new Map<string, { onupdate: string; ondelete: string }>();
        for (const rows of grouped.values()) {
            const ordered = [...rows].sort((a, b) => Number(a[1]) - Number(b[1]));
            out.set(JSON.stringify(ordered.map((r) => str(r[3]))), { onupdate: str(rows[0]?.[5]), ondelete: str(rows[0]?.[6]) });
        }
        return out;
    }

    private async indexes(table: string, tid: string, uniques: { name: string | null; columns: string[] }[]): Promise<Index[]> {
        const uniqueByColumns = new Map(uniques.map((u) => [JSON.stringify(u.columns), u]));
        const out: Index[] = [];
        for (const row of await this.rows(`PRAGMA index_list(${quoteSqlite(table)})`)) {
            const name = str(row[1]);
            const origin = str(row[3]);
            const keys = (await this.rows(`PRAGMA index_xinfo(${quoteSqlite(name)})`)).filter((r) => Number(r[5]));
            let texts: string[] = [];
            let predicate: string | null = null;
            if (origin === 'c') {
                const sql = text((await this.rows("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [name]))[0]?.[0]);
                if (sql) {
                    ({ keys: texts, predicate } = indexSql(sql));
                }
            }
            const parts: Part[] = keys.map((key, n) => {
                const cid = Number(key[1]);
                let expression: string | null = null;
                if (cid === -2) {
                    const raw = texts[n] ?? '';
                    expression = pyStrip(raw.replace(/\s+COLLATE\s+\w+/gi, '').replace(/\s+(ASC|DESC)$/i, '')) || null;
                }
                // index_xinfo also reports collations inherited from the column; only an explicit COLLATE is the index's own.
                const explicit = n < texts.length ? /\bCOLLATE\s+(\w+)/i.exec(texts[n] ?? '') : null;
                return part(cid !== -2 ? text(key[2]) : null, expression, { order: Number(key[3]) ? 'desc' : null, collation: explicit?.[1] ?? null });
            });
            let backs: Index['backs'] = null;
            if (origin === 'pk') {
                backs = { kind: 'primary_key', constraint: null };
            } else if (origin === 'u') {
                const constraint = uniqueByColumns.get(JSON.stringify(parts.map((p) => p.column)));
                if (constraint?.name) {
                    backs = { kind: 'unique_constraint', constraint: `${tid}:constraint:${constraint.name}` };
                }
            }
            out.push(indexEntry(tid, name, parts, { unique: Boolean(Number(row[2])), primary: origin === 'pk', backs, predicate: Number(row[4]) ? predicate : null }));
        }
        return out;
    }
}

function escape(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
