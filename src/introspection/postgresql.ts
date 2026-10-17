// PostgreSQL catalogs, read as python-schema-viewer reads them through SQLAlchemy's PostgreSQL Inspector plus its own
// pg_index query (introspection/catalog.py), with the SQL written out here.
import {
    action,
    column,
    identifier,
    indexEntry,
    owner,
    part,
    referencedColumns,
    str,
    stripOuterParens,
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

// format_type() names SQLAlchemy recognizes, with what python-schema-viewer reads from the reflected type: the
// timezone attribute, whether the type takes a collation, and integer affinity (a nextval() default makes it
// auto-incrementing).
type Kind = 'integer' | 'string' | 'timezone' | 'local' | 'other';
const TYPES: Readonly<Record<string, Kind>> = {
    integer: 'integer',
    bigint: 'integer',
    smallint: 'integer',
    'character varying': 'string',
    character: 'string',
    '"char"': 'string',
    name: 'string',
    text: 'string',
    citext: 'string',
    uuid: 'string',
    timestamp: 'local',
    'timestamp with time zone': 'timezone',
    'timestamp without time zone': 'local',
    'time with time zone': 'timezone',
    'time without time zone': 'local',
    time: 'local',
};
const OTHER = [
    'hstore', 'json', 'jsonb', 'int4range', 'int8range', 'numrange', 'daterange', 'tsrange', 'tstzrange', 'int4multirange',
    'int8multirange', 'nummultirange', 'datemultirange', 'tsmultirange', 'tstzmultirange', 'numeric', 'float', 'real', 'inet',
    'cidr', 'bit', 'bit varying', 'macaddr', 'macaddr8', 'money', 'oid', 'regclass', 'double precision', 'date', 'bytea',
    'boolean', 'interval', 'tsvector', '_array',
];
const ACTION_CODES: Readonly<Record<string, string>> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const CHECK = /^CHECK *\(([\s\S]+)\)( NO INHERIT)?( NOT VALID)?$/;

interface NamedType {
    name: string;
    schema: string;
    visible: boolean;
}
interface EnumType extends NamedType {
    labels: string[];
}
interface DomainType extends NamedType {
    nullable: boolean;
    default: string | null;
    collation: string | null;
}
interface Reflected {
    kind: Kind | 'enum' | 'domain' | 'null';
    array: boolean;
    enum: EnumType | null;
    domain: DomainType | null;
}

export class PostgreSQLReader {
    private enums = new Map<string, EnumType>();
    private domains = new Map<string, DomainType>();

    constructor(
        private readonly session: Session,
        private readonly tableId: (schema: string | null, table: string) => string,
    ) {}

    async load(): Promise<void> {
        for (const row of await this.session.rows(
            'SELECT t.typname::text, pg_type_is_visible(t.oid), n.nspname::text, ' +
                'ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) ' +
                "FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype = 'e' ORDER BY n.nspname, t.typname",
        )) {
            const entry: EnumType = { name: str(row[0]), visible: row[1] === true, schema: str(row[2]), labels: (row[3] as string[] | null) ?? [] };
            this.enums.set(namedKey(entry), entry);
        }
        for (const row of await this.session.rows(
            'SELECT t.typname::text, NULL, NOT t.typnotnull, t.typdefault, ' +
                'pg_type_is_visible(t.oid), n.nspname::text, co.collname::text FROM pg_type t ' +
                'JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_collation co ON co.oid = t.typcollation ' +
                "WHERE t.typtype = 'd' ORDER BY n.nspname, t.typname",
        )) {
            const entry: DomainType = {
                name: str(row[0]),
                nullable: row[2] === true,
                default: text(row[3]),
                visible: row[4] === true,
                schema: str(row[5]),
                collation: text(row[6]),
            };
            this.domains.set(namedKey(entry), entry);
        }
    }

    // Schemas the role can see, as SQLAlchemy lists them (no pg_* schemas).
    async schemaNames(): Promise<string[]> {
        return (await this.session.rows("SELECT nspname::text FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ORDER BY 1")).map((r) => str(r[0]));
    }

    async tables(schema: string): Promise<Table[]> {
        const rows = (sql: string): Promise<Row[]> => this.session.rows(sql, [schema]);
        const relations = "n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relpersistence <> 't'";
        const names = (await rows(`SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${relations} AND NOT c.relispartition`)).map(
            (r) => str(r[0]),
        );
        const generated = this.version(12) ? 'a.attgenerated::text' : "''";
        const columns = group(
            await rows(
                `SELECT c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), ` +
                    'CASE WHEN a.atthasdef THEN pg_get_expr(d.adbin, d.adrelid) END, a.attnotnull, des.description, ' +
                    `${generated}, CASE WHEN a.attidentity <> '' THEN a.attidentity = 'a' END, ` +
                    'CASE WHEN a.attcollation <> 0 AND (SELECT ty.typcollation FROM pg_type ty WHERE ty.oid = a.atttypid) <> a.attcollation ' +
                    'THEN co.collname::text END ' +
                    'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
                    'JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ' +
                    'LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum ' +
                    'LEFT JOIN pg_description des ON des.objoid = a.attrelid AND des.objsubid = a.attnum ' +
                    `LEFT JOIN pg_collation co ON co.oid = a.attcollation WHERE ${relations} ORDER BY c.relname, a.attnum`,
            ),
        );
        const constraintColumns = (type: string): Promise<Row[]> =>
            rows(
                'SELECT c.relname::text, con.conname::text, ' +
                    'ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) ' +
                    'JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord), i.indnkeyatts ' +
                    'FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
                    `JOIN pg_index i ON i.indexrelid = con.conindid WHERE con.contype = '${type}' AND ${relations} ORDER BY c.relname, con.conname`,
            );
        const primary = new Map<string, { name: string; columns: string[] }>();
        for (const row of await constraintColumns('p')) {
            primary.set(str(row[0]), { name: str(row[1]), columns: (row[2] as string[]).slice(0, Number(row[3])) });
        }
        const uniques = group((await constraintColumns('u')).map((row) => [row[0], row[1], (row[2] as string[]).slice(0, Number(row[3]))]));
        const setColumns = this.version(15) ? 'con.confdelsetcols IS NOT NULL AND cardinality(con.confdelsetcols) > 0' : 'false';
        const foreign = group(
            await rows(
                'SELECT c.relname::text, con.conname::text, rn.nspname::text, rc.relname::text, ' +
                    'ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) ' +
                    'JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord), ' +
                    'ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) ' +
                    'JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord), ' +
                    `con.confupdtype::text, con.confdeltype::text, con.condeferrable, con.condeferred, ${setColumns} ` +
                    'FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
                    'JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace ' +
                    `WHERE con.contype = 'f' AND con.conparentid = 0 AND ${relations} ORDER BY c.relname, con.conname`,
            ),
        );
        const checks = group(
            await rows(
                'SELECT c.relname::text, con.conname::text, pg_get_constraintdef(con.oid, true) FROM pg_constraint con ' +
                    'JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
                    `WHERE con.contype = 'c' AND ${relations} ORDER BY c.relname, con.conname`,
            ),
        );
        const comments = new Map<string, string | null>();
        for (const row of await rows(
            'SELECT c.relname::text, des.description FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
                "LEFT JOIN pg_description des ON des.objoid = c.oid AND des.objsubid = 0 AND des.classoid = 'pg_catalog.pg_class'::regclass " +
                `WHERE ${relations}`,
        )) {
            comments.set(str(row[0]), text(row[1]));
        }
        const indexes = await this.indexes(schema, primary);
        return names.map((name) => {
            const tid = this.tableId(schema, name);
            const facts = (columns.get(name) ?? []).map((row) => this.column(row, schema));
            const pk = primary.get(name)?.columns ?? [];
            const constraints: Constraint[] = (uniques.get(name) ?? []).map((row) => ({
                id: `${tid}:constraint:${str(row[1])}`,
                kind: 'unique',
                name: str(row[1]),
                columns: row[2] as string[],
                expression: null,
                provenance: ['database'],
            }));
            for (const row of checks.get(name) ?? []) {
                const match = CHECK.exec(str(row[2]));
                const expression = match === null ? '' : stripOuterParens(match[1] ?? '');
                constraints.push({
                    id: `${tid}:constraint:${str(row[1])}`,
                    kind: 'check',
                    name: str(row[1]),
                    columns: referencedColumns(expression, facts.map((c) => c.name)),
                    expression,
                    provenance: ['database'],
                });
            }
            const foreignKeys: ForeignKey[] = (foreign.get(name) ?? []).map((row) => {
                const target = this.tableId(str(row[2]), str(row[3]));
                const columnNames = row[4] as string[];
                const targetColumns = row[5] as string[];
                return {
                    id: identifier('foreign_key', tid, str(row[1]), identifier(...columnNames), target, identifier(...targetColumns)),
                    name: str(row[1]),
                    columns: columnNames,
                    foreignTable: target,
                    foreignColumns: targetColumns,
                    onUpdate: action(ACTION_CODES[str(row[6])] ?? 'NO ACTION'),
                    onDelete: row[10] === true ? null : action(ACTION_CODES[str(row[7])] ?? 'NO ACTION'),
                    deferrable: row[8] === true,
                    initially: row[9] === true ? 'DEFERRED' : 'IMMEDIATE',
                    provenance: ['database'],
                };
            });
            return {
                id: tid,
                name,
                schema,
                comment: comments.get(name) ?? null,
                note: null,
                owner: owner(name),
                primaryKey: pk,
                columns: facts.map((c) => column(c, false)),
                indexes: indexes.get(name) ?? [],
                foreignKeys,
                constraints,
                provenance: ['database'],
            } satisfies Table;
        });
    }

    private version(major: number): boolean {
        return (this.session.version[0] ?? 0) >= major;
    }

    // SQLAlchemy's _reflect_type, reduced to what the document records.
    private reflect(formatType: string): Reflected {
        const array = /((?:\[\])*)$/.exec(formatType)?.[1] !== '';
        const attype = formatType.replace(/\((.*)\)/, '').replace(/((?:\[\])*)$/, '');
        let kind: Reflected['kind'] | undefined = TYPES[attype.toLowerCase()] ?? (OTHER.includes(attype.toLowerCase()) ? 'other' : undefined);
        if (attype === 'interval' || attype.startsWith('interval ')) {
            kind = 'other';
        }
        let enumType: EnumType | null = null;
        let domain: DomainType | null = null;
        if (kind === undefined) {
            const key = quotedTokens(attype).join('\u0000');
            enumType = this.enums.get(key) ?? null;
            domain = enumType === null ? (this.domains.get(key) ?? null) : null;
            kind = enumType !== null ? 'enum' : domain !== null ? 'domain' : 'null';
        }
        return { kind, array, enum: enumType, domain };
    }

    private column(row: Row, schema: string): ColumnFacts {
        const native = str(row[2]);
        const type = this.reflect(native);
        const scalar = (kind: Reflected['kind']): boolean => type.kind === kind && !type.array;
        let collation = text(row[8]);
        if (!(scalar('string') || scalar('domain'))) {
            collation = null;
        } else if (scalar('domain') && collation === null) {
            collation = type.domain?.collation ?? null;
        }
        let defaultText = text(row[3]);
        let nullable = row[4] !== true;
        if (scalar('domain') && type.domain !== null) {
            if (!defaultText && type.domain.default !== null) {
                defaultText = type.domain.default;
            }
            nullable = nullable && type.domain.nullable;
        }
        const generated = str(row[6]);
        let computed: ColumnFacts['computed'] = null;
        if (generated !== '' && generated !== '\u0000') {
            computed = { sqltext: defaultText ?? '', persisted: generated === 's' };
            defaultText = null;
        }
        let autoIncrement = false;
        if (defaultText !== null) {
            const match = /(nextval\(')([^']+)('.*$)/.exec(defaultText);
            if (match !== null) {
                autoIncrement = scalar('integer');
                if (!(match[2] ?? '').includes('.')) {
                    // SQLAlchemy qualifies the sequence with the schema it reflected, quoted.
                    defaultText = `${match[1] ?? ''}"${schema}".${match[2] ?? ''}${match[3] ?? ''}`;
                }
            }
        }
        const identity = row[7] === null || row[7] === undefined ? null : { always: row[7] === true };
        return {
            name: str(row[1]),
            native,
            isEnum: scalar('enum'),
            enumName: type.enum?.name ?? null,
            enumValues: type.enum?.labels ?? [],
            nullable,
            autoIncrement: autoIncrement || identity !== null,
            timezone: scalar('timezone') ? true : scalar('local') ? false : null,
            collation,
            default: defaultText,
            identity,
            computed,
            comment: text(row[5]),
        };
    }

    private async indexes(schema: string, primary: Map<string, { name: string; columns: string[] }>): Promise<Map<string, Index[]>> {
        const nullsNotDistinct = this.version(15) ? 'i.indnullsnotdistinct' : 'false';
        const rows = await this.session.rows(
            'SELECT t.relname::text, c.relname::text, i.indisprimary, i.indisunique, con.conrelid IS NOT NULL, ' +
                'i.indoption::int2[], am.amname::text, CASE WHEN i.indpred IS NOT NULL THEN pg_get_expr(i.indpred, i.indrelid) END, ' +
                `i.indnkeyatts, ${nullsNotDistinct}, ` +
                'ARRAY(SELECT CASE WHEN k.attnum = 0 THEN pg_get_indexdef(i.indexrelid, k.ord::int, true) ELSE a.attname::text END ' +
                'FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid ' +
                'AND a.attnum = k.attnum ORDER BY k.ord), ' +
                'ARRAY(SELECT k.attnum = 0 FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) ORDER BY k.ord), ' +
                'ARRAY(SELECT CASE WHEN opc.opcdefault THEN NULL ELSE opc.opcname::text END FROM unnest(i.indclass::oid[]) ' +
                'WITH ORDINALITY k(opc, ord) LEFT JOIN pg_opclass opc ON opc.oid = k.opc ORDER BY k.ord), ' +
                // python-schema-viewer's own query: key collations that differ from the column's (or an expression's) default.
                "ARRAY(SELECT CASE WHEN k.coll <> 0 AND k.coll IS DISTINCT FROM a.attcollation AND co.collname <> 'default' " +
                'THEN co.collname::text END FROM unnest(i.indcollation::oid[], (i.indkey::int2[])[0:i.indnkeyatts - 1]) ' +
                'WITH ORDINALITY AS k(coll, attnum, n) LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ' +
                'AND k.attnum > 0 LEFT JOIN pg_collation co ON co.oid = k.coll ORDER BY k.n) ' +
                'FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid ' +
                'JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = c.relam ' +
                'LEFT JOIN pg_constraint con ON con.conrelid = i.indrelid AND con.conindid = i.indexrelid ' +
                "AND con.contype IN ('p', 'u', 'x') WHERE n.nspname = $1 AND t.relkind IN ('r', 'p') AND t.relpersistence <> 't' " +
                'ORDER BY t.relname, c.relname',
            [schema],
        );
        const methods = new Map<string, string>();
        const out = new Map<string, Index[]>();
        const add = (table: string, index: Index): void => {
            out.set(table, [...(out.get(table) ?? []), index]);
        };
        for (const row of rows) {
            const table = str(row[0]);
            const name = str(row[1]);
            methods.set(`${table}\u0000${name}`, str(row[6]));
            if (row[2] === true) {
                continue;
            }
            const tid = this.tableId(schema, table);
            const keyCount = Number(row[8]);
            const all = row[10] as (string | null)[];
            const elements = all.slice(0, keyCount);
            const isExpression = (row[11] as boolean[]).slice(0, keyCount);
            const opclasses = row[12] as (string | null)[];
            const collations = row[13] as (string | null)[];
            const included = all.length > keyCount ? all.slice(keyCount).map((e) => e ?? '') : [];
            const expressions = isExpression.some(Boolean);
            const columnNames = expressions ? elements.map((e, n) => (isExpression[n] === true ? null : e)) : elements;
            const ops = new Map<string | null, string>();
            elements.forEach((element, n) => {
                const opclass = opclasses[n];
                if (opclass !== null && opclass !== undefined) {
                    ops.set(element, opclass);
                }
            });
            const sorting = new Map<string | null, string[]>();
            (row[5] as number[]).forEach((flags, n) => {
                const found: string[] = [];
                if (flags & 0x01) {
                    found.push('desc');
                    if (!(flags & 0x02)) {
                        found.push('nulls_last');
                    }
                } else if (flags & 0x02) {
                    found.push('nulls_first');
                }
                if (found.length > 0) {
                    sorting.set(elements[n] ?? null, found);
                }
            });
            const parts: Part[] = columnNames.map((columnName, n) => {
                const key = elements[n] ?? null;
                const flags = sorting.get(key) ?? [];
                return part(columnName, columnName === null ? key : null, {
                    order: flags.includes('desc') ? 'desc' : null,
                    nulls: flags.includes('nulls_last') ? 'last' : flags.includes('nulls_first') ? 'first' : null,
                    collation: collations[n] ?? null,
                    opclass: ops.get(key) ?? null,
                });
            });
            const predicate = text(row[7]);
            add(
                table,
                indexEntry(tid, name, parts, {
                    unique: row[3] === true,
                    backs: row[4] === true ? { kind: 'unique_constraint', constraint: `${tid}:constraint:${name}` } : null,
                    method: str(row[6]),
                    predicate: predicate === '' ? null : predicate,
                    included,
                    dialectOptions: row[9] === true ? { postgresql: { options: { nullsNotDistinct: true } } } : null,
                }),
            );
        }
        for (const [table, pk] of primary) {
            if (pk.name !== '' && pk.columns.length > 0) {
                const tid = this.tableId(schema, table);
                add(
                    table,
                    indexEntry(
                        tid,
                        pk.name,
                        pk.columns.map((c) => part(c)),
                        { unique: true, primary: true, backs: { kind: 'primary_key', constraint: null }, method: methods.get(`${table}\u0000${pk.name}`) ?? 'btree' },
                    ),
                );
            }
        }
        return out;
    }
}

function namedKey(type: NamedType): string {
    return (type.visible ? [type.name] : [type.schema, type.name]).join('\u0000');
}

// SQLAlchemy's quoted_token_parser: a dotted name with double-quoted parts.
export function quotedTokens(value: string): string[] {
    if (!value.includes('"')) {
        return value.split('.');
    }
    const result: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < value.length; i += 1) {
        const char = value.charAt(i);
        if (char === '"') {
            if (quoted && value.charAt(i + 1) === '"') {
                current += '"';
                i += 1;
            } else {
                quoted = !quoted;
            }
        } else if (char === '.' && !quoted) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

function group(rows: Row[]): Map<string, Row[]> {
    const out = new Map<string, Row[]>();
    for (const row of rows) {
        const key = str(row[0]);
        out.set(key, [...(out.get(key) ?? []), row]);
    }
    return out;
}

