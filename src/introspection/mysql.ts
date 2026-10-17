// MySQL and MariaDB catalogs, read as python-schema-viewer reads them: SQLAlchemy's MySQL Inspector parses SHOW CREATE
// TABLE (ported below from sqlalchemy/dialects/mysql/reflection.py), and information_schema.COLUMNS and STATISTICS
// supply native types and index key parts (introspection/catalog.py).
import { constraintId, foreignKeyId } from '../schema/ids.js';
import type { ConstraintModel, ForeignKeyModel, IndexModel, TableModel } from '../schema/model.js';
import { action, column, indexEntry, owner, part, referencedColumns, str, text, type ColumnFacts, type Row } from './common.js';
import { IntrospectionError } from './request.js';
import type { Session } from './readonly.js';

// SQLAlchemy's MySQL ischema_names with what python-schema-viewer reads from the reflected type: the timezone
// attribute (False for these types) and whether it takes a collation.
const TIME_TYPES = new Set(['datetime', 'time', 'timestamp']);
const STRING_TYPES = new Set(['char', 'enum', 'longtext', 'mediumtext', 'nchar', 'nvarchar', 'set', 'text', 'tinytext', 'uuid', 'varchar']);

const NAME = '`(?<name>(?:``|[^`])+)`';
const COLUMN = new RegExp(
    `^  ${NAME} +(?<coltype>\\w+)(?:\\((?<arg>(?:\\d+|\\d+,\\d+|(?:'(?:''|[^'])*',?)+))\\))?(?: +(?<unsigned>UNSIGNED))?` +
        "(?: +(?<zerofill>ZEROFILL))?(?: +CHARACTER SET +(?<charset>[\\w_]+))?(?: +COLLATE +(?<collate>[\\w_]+))?" +
        "(?: +(?<notnull>(?:NOT )?NULL))?(?: +DEFAULT +(?<default>(?:NULL|'(?:''|[^'])*'|\\(.+?\\)|[\\-\\w.()]+(?: +ON UPDATE [\\-\\w.()]+)?)))?" +
        '(?: +(?:GENERATED ALWAYS)? ?AS +(?<generated>\\(.*\\))? ?(?<persistence>VIRTUAL|STORED)?(?: +(?<notnullGenerated>(?:NOT )?NULL))?)?' +
        "(?: +(?<autoincr>AUTO_INCREMENT))?(?: +COMMENT +'(?<comment>(?:''|[^'])*)')?(?: +COLUMN_FORMAT +(?<colfmt>\\w+))?" +
        '(?: +STORAGE +(?<storage>\\w+))?(?: +(?<extra>.*))?,?$',
    'i',
);
const COLUMN_LOOSE = new RegExp(`^  ${NAME} +(?<coltype>\\w+)(?:\\((?<arg>(?:\\d+|\\d+,\\d+|'(?:''|[^'])+'))\\))?.*?(?<notnull>(?:NOT )NULL)?`, 'i');
const ON = 'RESTRICT|CASCADE|SET NULL|NO ACTION|SET DEFAULT';
const FOREIGN_KEY = new RegExp(
    `^  CONSTRAINT +${NAME} +FOREIGN KEY +\\((?<local>[^)]+?)\\) REFERENCES +(?<table>\`[^\`]+\`(?:\\.\`[^\`]+\`)?) +` +
        `\\((?<foreign>(?:\`[^\`]+\`(?: *, *)?)+)\\)(?: +(?<match>MATCH \\w+))?(?: +ON DELETE (?<ondelete>${ON}))?(?: +ON UPDATE (?<onupdate>${ON}))?`,
    'i',
);
const CHECK = new RegExp(`^  CONSTRAINT +${NAME} +CHECK +\\((?<sqltext>.+)\\),?`, 'i');
const KEY_EXPRESSIONS = /(?:(?:`((?:``|[^`])+)`)(?:\((\d+)\))?(?: +(ASC|DESC))?(?=,|$))+/gi;
const TABLE_COMMENT = /(?<directive>COMMENT)(?:\s*(?:=\s*)|\s+)'(?<val>(?:[^']|'')*?)'(?!')/i;
const CONTROL: Readonly<Record<string, string>> = { '\\\\': '\\', '\\0': '\0', '\\a': '\x07', '\\b': '\b', '\\t': '\t', '\\n': '\n', '\\v': '\v', '\\f': '\f', '\\r': '\r' };

interface Parsed {
    columns: ColumnFacts[];
    comment: string | null;
    foreignKeys: { name: string; local: string[]; table: string[]; foreign: string[]; ondelete: string | null; onupdate: string | null }[];
    checks: { name: string; sqltext: string }[];
}

// SQLAlchemy's cleanup_text for comments.
function cleanup(raw: string): string {
    const unescaped = raw.includes('\\') ? raw.replace(/\\\\|\\0|\\a|\\b|\\t|\\n|\\v|\\f|\\r/g, (s) => CONTROL[s] ?? s) : raw;
    return unescaped.split("''").join("'");
}

function keyColumns(identifiers: string): string[] {
    return [...identifiers.matchAll(KEY_EXPRESSIONS)].map((m) => m[1] ?? '');
}

// MySQLIdentifierPreparer.unformat_identifiers: `a`.`b` -> [a, b].
function unformat(value: string): string[] {
    return [...value.matchAll(/`((?:``|[^`])*)`/g)].map((m) => (m[1] ?? '').split('``').join('`'));
}

// SQLAlchemy's MySQLTableDefinitionParser.parse, for what python-schema-viewer reads.
export function parseCreateTable(sql: string): Parsed {
    const state: Parsed = { columns: [], comment: null, foreignKeys: [], checks: [] };
    for (const line of sql.split(/\r?\n/)) {
        if (line.startsWith('  `')) {
            const facts = parseColumn(line);
            if (facts !== null) {
                state.columns.push(facts);
            }
        } else if (line.startsWith(') ')) {
            const match = TABLE_COMMENT.exec(line);
            if (match?.groups?.val !== undefined) {
                state.comment = cleanup(match.groups.val);
            }
        } else if (line === ')' || line.startsWith('CREATE ') || line.includes('PARTITION') || line === '') {
            continue;
        } else {
            const fk = FOREIGN_KEY.exec(line)?.groups;
            if (fk !== undefined) {
                state.foreignKeys.push({
                    name: fk.name ?? '',
                    local: keyColumns(fk.local ?? ''),
                    table: unformat(fk.table ?? ''),
                    foreign: keyColumns(fk.foreign ?? ''),
                    ondelete: fk.ondelete ?? null,
                    onupdate: fk.onupdate ?? null,
                });
                continue;
            }
            const check = CHECK.exec(line)?.groups;
            if (check !== undefined && !/^ {2}(?:\S+ )?KEY/i.test(line)) {
                state.checks.push({ name: check.name ?? '', sqltext: check.sqltext ?? '' });
            }
        }
    }
    state.checks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return state;
}

function parseColumn(line: string): ColumnFacts | null {
    const spec = COLUMN.exec(line)?.groups ?? COLUMN_LOOSE.exec(line)?.groups;
    if (spec === undefined) {
        return null;
    }
    const type = spec.coltype ?? '';
    const args = spec.arg ?? '';
    const values = type === 'enum' || type === 'set' ? [...args.matchAll(/'(?:''|[^'])*'/g)].map((m) => m[0].slice(1, -1).split("''").join("'")) : [];
    let defaultText = spec.default ?? null;
    if (defaultText === 'NULL') {
        defaultText = null;
    }
    const computed = spec.generated === undefined ? null : { sqltext: spec.generated, persisted: spec.persistence === undefined ? null : spec.persistence.toUpperCase() === 'STORED' };
    return {
        name: (spec.name ?? '').split('``').join('`'),
        native: '',
        isEnum: type === 'enum',
        enumName: null,
        enumValues: values,
        nullable: !(spec.notnull?.toUpperCase() === 'NOT NULL' || spec.notnullGenerated?.toUpperCase() === 'NOT NULL'),
        autoIncrement: spec.autoincr !== undefined,
        timezone: TIME_TYPES.has(type) ? false : null,
        collation: STRING_TYPES.has(type) ? (spec.collate ?? null) : null,
        default: defaultText,
        identity: null,
        computed,
        comment: spec.comment === undefined ? null : cleanup(spec.comment),
    };
}

export class MySQLReader {
    constructor(
        private readonly session: Session,
        private readonly tableId: (schema: string | null, table: string) => string,
    ) {}

    async schemaNames(): Promise<string[]> {
        return (await this.session.rows('SHOW schemas')).map((r) => str(r[0]));
    }

    async tables(schema: string): Promise<TableModel[]> {
        const names = (await this.session.rows(`SHOW FULL TABLES FROM ${quote(schema)}`)).filter((r) => str(r[1]) === 'BASE TABLE').map((r) => str(r[0]));
        const natives = new Map<string, string>();
        for (const row of await this.session.rows('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?', [schema])) {
            natives.set(`${str(row[0])}\u0000${str(row[1])}`, str(row[2]));
        }
        const { indexes, primary } = await this.indexes(schema);
        const parsed = new Map<string, Parsed>();
        for (const name of names) {
            const create = await this.session.rows(`SHOW CREATE TABLE ${quote(schema)}.${quote(name)}`);
            parsed.set(name, parseCreateTable(str(create[0]?.[1]).trim()));
        }
        await this.correctForeignKeyCase(schema, [...parsed.values()]);
        return names.map((name) => {
            const state = parsed.get(name) ?? { columns: [], comment: null, foreignKeys: [], checks: [] };
            const tid = this.tableId(schema, name);
            const facts = state.columns.map((c) => ({ ...c, native: natives.get(`${name}\u0000${c.name}`) ?? '' }));
            const foreignKeys: ForeignKeyModel[] = state.foreignKeys.map((fk) => {
                const target = this.tableId(fk.table.length > 1 ? (fk.table[fk.table.length - 2] ?? schema) : schema, fk.table[fk.table.length - 1] ?? '');
                return {
                    id: foreignKeyId(tid, fk.name, fk.local, target, fk.foreign),
                    name: fk.name,
                    columns: fk.local,
                    referencedTable: target,
                    referencedColumns: fk.foreign,
                    onUpdate: action(fk.onupdate ?? 'NO ACTION'),
                    onDelete: action(fk.ondelete ?? 'NO ACTION'),
                    deferrable: null,
                    initially: null,
                };
            });
            // MySQL and MariaDB unique constraints are unique indexes; listed there.
            const constraints: ConstraintModel[] = state.checks.map((check, n) => ({
                kind: 'check',
                id: constraintId(tid, check.name === '' ? `check${String(n)}` : check.name),
                name: check.name,
                expression: check.sqltext,
                columns: referencedColumns(check.sqltext, facts.map((c) => c.name)),
            }));
            return {
                id: tid,
                name,
                schema,
                comment: state.comment,
                ownership: owner(name),
                primaryKey: primary.get(name) ?? [],
                columns: facts.map((c) => column(c, false)),
                indexes: indexes.get(name) ?? [],
                foreignKeys,
                constraints,
            } satisfies TableModel;
        });
    }

    // SQLAlchemy corrects the case of referenced tables and columns on MySQL 8+ (MySQL bugs 88718 and 96365).
    private async correctForeignKeyCase(schema: string, states: Parsed[]): Promise<void> {
        if (this.session.mariadb || (this.session.version[0] ?? 0) < 8) {
            return;
        }
        const keys = states.flatMap((s) => s.foreignKeys);
        if (keys.length === 0) {
            return;
        }
        const casing = Number((await this.session.rows('SELECT @@lower_case_table_names'))[0]?.[0] ?? 0);
        const lower = (s: string): string => (casing === 1 || casing === 2 ? s.toLowerCase() : s);
        const targetSchema = (fk: Parsed['foreignKeys'][number]): string => (fk.table.length > 1 ? (fk.table[fk.table.length - 2] ?? schema) : schema);
        const schemas = [...new Set(keys.map(targetSchema))];
        const found = new Map<string, { schema: string; table: string; columns: Map<string, string> }>();
        for (const target of schemas) {
            for (const row of await this.session.rows('SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?', [target])) {
                const key = `${lower(str(row[0]))}\u0000${lower(str(row[1]))}`;
                const entry = found.get(key) ?? { schema: str(row[0]), table: str(row[1]), columns: new Map<string, string>() };
                entry.columns.set(str(row[2]).toLowerCase(), str(row[2]));
                found.set(key, entry);
            }
        }
        for (const fk of keys) {
            const entry = found.get(`${lower(targetSchema(fk))}\u0000${lower(fk.table[fk.table.length - 1] ?? '')}`);
            if (entry === undefined) {
                continue;
            }
            fk.table = [entry.schema, entry.table];
            fk.foreign = fk.foreign.map((c) => entry.columns.get(c.toLowerCase()) ?? c);
        }
    }

    private async indexes(schema: string): Promise<{ indexes: Map<string, IndexModel[]>; primary: Map<string, string[]> }> {
        const available = new Set(
            (
                await this.session.rows(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'STATISTICS'",
                )
            ).map((r) => str(r[0])),
        );
        const optional = (name: string): string => (available.has(name) ? name : 'NULL');
        const grouped = new Map<string, Row[]>();
        for (const row of await this.session.rows(
            `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, ${optional('EXPRESSION')}, COLLATION, SUB_PART, INDEX_TYPE, ` +
                `${optional('IS_VISIBLE')}, ${optional('IGNORED')} FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ` +
                'ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
            [schema],
        )) {
            const key = `${str(row[0])}\u0000${str(row[1])}`;
            grouped.set(key, [...(grouped.get(key) ?? []), row]);
        }
        const indexes = new Map<string, IndexModel[]>();
        const primary = new Map<string, string[]>();
        for (const rows of grouped.values()) {
            const first = rows[0] ?? [];
            const table = str(first[0]);
            const name = str(first[1]);
            const tid = this.tableId(schema, table);
            const method = str(first[7]).toLowerCase() || null;
            // STATISTICS escapes quotes inside functional key parts.
            const parts = rows.map((r) => {
                const columnName = text(r[3]);
                const length = r[6] === null || r[6] === undefined ? 0 : Number(r[6]);
                return part(columnName, columnName !== null ? null : str(r[4]).split("\\'").join("'") || null, {
                    order: text(r[5]) === 'D' ? 'desc' : null,
                    prefixLength: length && method !== 'spatial' ? length : null,
                });
            });
            const options: Record<string, boolean> = {};
            if (text(first[8]) === 'NO') {
                options.visible = false;
            }
            if (text(first[9]) === 'YES') {
                options.ignored = true;
            }
            const isPrimary = name === 'PRIMARY';
            if (isPrimary) {
                primary.set(table, parts.flatMap((p) => (p.column === null ? [] : [p.column])));
            }
            indexes.set(table, [
                ...(indexes.get(table) ?? []),
                indexEntry(tid, name, parts, {
                    unique: !Number(first[2]),
                    enforces: isPrimary ? { kind: 'primary_key' } : null,
                    method,
                    dialectOptions: Object.keys(options).length > 0 ? { mysql: options } : null,
                }),
            ]);
        }
        return { indexes, primary };
    }
}

function quote(name: string): string {
    if (name.includes('\u0000')) {
        throw new IntrospectionError('Names with NUL characters cannot be inspected');
    }
    return `\`${name.split('`').join('``')}\``;
}
