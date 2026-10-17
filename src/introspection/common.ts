// Shared pieces of the catalog readers: the internal model entities (../schema/model.ts) with python-schema-viewer's
// ids, normalization and text parsing (introspection/catalog.py). Worker-side; imports only this directory and
// ../schema/. Nothing here knows the document's field names.
import { indexId } from '../schema/ids.js';
import type { ColumnModel, IndexModel, JsonScalar, KeyPartModel, ReferentialAction, TableModel } from '../schema/model.js';


export type Row = unknown[];

// The parts a reflected column needs, before the contract shape.
export interface ColumnFacts {
    name: string;
    native: string;
    isEnum: boolean;
    enumName: string | null;
    enumValues: string[];
    nullable: boolean;
    autoIncrement: boolean;
    timezone: boolean | null;
    collation: string | null;
    default: string | null;
    identity: { always: boolean } | null;
    computed: { sqltext: string; persisted: boolean | null } | null;
    comment: string | null;
}

const LITERAL = /^(?:'(?:[^']|'')*'(?:::[\w .[\]"]+)?|\(?-?\d+(?:\.\d+)?\)?(?:::[\w ."]+)?|true|false|null)$/i;
const TYPE_NAMES: Readonly<Record<string, string>> = {
    'character varying': 'varchar',
    character: 'char',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'time with time zone': 'timetz',
    'time without time zone': 'time',
    'double precision': 'double',
    'bit varying': 'varbit',
};
const OWNERS: Readonly<Record<string, [string, string]>> = {
    alembic_version: ['package', 'alembic'],
    django_migrations: ['framework', 'django'],
    aerich: ['package', 'aerich'],
};
const ACTIONS = new Set<string>(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']);

export function typeName(native: string, isEnum: boolean): string {
    if (isEnum || native.toLowerCase().startsWith('enum(')) {
        return 'enum';
    }
    const base = native
        .replace(/\(.*?\)/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+(unsigned|zerofill|signed)\b/g, '');
    return TYPE_NAMES[base] ?? base;
}

export function defaultValue(text: string | null): ColumnModel['serverDefault'] {
    if (text === null) {
        return null;
    }
    const sql = text.trim();
    if (sql.toLowerCase().startsWith('nextval(')) {
        return { kind: 'sequence', sql };
    }
    return { kind: LITERAL.test(sql) ? 'literal' : 'expression', sql };
}

// A referential action in SQL spelling, or null when it is not an SQL action.
export function action(value: string): ReferentialAction | null {
    const normal = value.trim().toUpperCase().replace(/_/g, ' ');
    return ACTIONS.has(normal) ? (normal as ReferentialAction) : null;
}

export function owner(table: string): TableModel['ownership'] {
    const found = Object.hasOwn(OWNERS, table) ? OWNERS[table] : undefined;
    return found === undefined ? { kind: 'application', package: null } : { kind: found[0] as 'framework' | 'package', package: found[1] };
}

export function part(column: string | null, expression: string | null = null, extra: Partial<KeyPartModel> = {}): KeyPartModel {
    return {
        column,
        expression,
        order: extra.order ?? null,
        nulls: extra.nulls ?? null,
        prefixLength: extra.prefixLength ?? null,
        collation: extra.collation ?? null,
        operatorClass: extra.operatorClass ?? null,
    };
}

export function indexEntry(
    tid: string,
    name: string,
    keyParts: KeyPartModel[],
    options: {
        unique: boolean;
        enforces?: IndexModel['enforces'];
        method?: string | null;
        predicate?: string | null;
        included?: string[];
        dialectOptions?: Record<string, Record<string, JsonScalar>> | null;
    },
): IndexModel {
    return {
        id: indexId(tid, name),
        name,
        keyParts,
        unique: options.unique,
        enforces: options.enforces ?? null,
        method: options.method ?? null,
        predicate: options.predicate ?? null,
        includedColumns: options.included ?? [],
        dialectOptions: options.dialectOptions ?? {},
    };
}

export function column(c: ColumnFacts, rowid: boolean): ColumnModel {
    let serverDefault = c.computed === null ? defaultValue(c.default) : null;
    if (c.identity !== null) {
        serverDefault = { kind: 'identity', sql: `GENERATED ${c.identity.always ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` };
    }
    return {
        name: c.name,
        nativeType: c.native,
        baseType: typeName(c.native, c.isEnum),
        nullable: c.nullable,
        autoIncrement: rowid || c.autoIncrement,
        timezone: c.timezone,
        collation: c.collation,
        enumeration: c.isEnum ? { namedType: c.enumName, values: c.enumValues } : null,
        serverDefault,
        generated:
            c.computed === null
                ? null
                : { storage: c.computed.persisted === null ? null : c.computed.persisted ? 'stored' : 'virtual', expression: c.computed.sqltext },
        comment: c.comment,
    };
}

const IDENTIFIER = /[A-Za-z_][\w$]*|`[^`]+`|"[^"]+"/g;

// The table's columns an expression mentions, in table order.
export function referencedColumns(expression: string, columns: string[]): string[] {
    const found = new Set((expression.match(IDENTIFIER) ?? []).map((token) => token.replace(/^[`"]+|[`"]+$/g, '')));
    return columns.filter((c) => found.has(c));
}

export function splitTopLevel(text: string, separator = ','): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';
    for (const char of text) {
        if (quote !== null) {
            if (char === quote) {
                quote = null;
            }
        } else if (`'"\`[`.includes(char)) {
            quote = char === '[' ? ']' : char;
        } else if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth -= 1;
        } else if (char === separator && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current.trim());
    return parts;
}

// SQLAlchemy's find_matching_paren: the index of the ")" closing the "(" at start, skipping quoted literals.
export function findMatchingParen(text: string, start: number): number | null {
    let depth = 0;
    let single = false;
    let double = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (single) {
            if (ch === "'") {
                if (text[i + 1] === "'") {
                    i += 1;
                    continue;
                }
                single = false;
            }
        } else if (double) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    i += 1;
                    continue;
                }
                double = false;
            }
        } else if (ch === "'") {
            single = true;
        } else if (ch === '"') {
            double = true;
        } else if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return null;
}

// SQLAlchemy's strip_outer_parens: one layer of parentheses wrapping the whole (stripped) text.
export function stripOuterParens(text: string): string {
    const stripped = pyStrip(text);
    if (stripped.length < 2 || !stripped.startsWith('(') || !stripped.endsWith(')')) {
        return text;
    }
    return findMatchingParen(stripped, 0) === stripped.length - 1 ? stripped.slice(1, -1) : text;
}

// Python's str.strip() without arguments.
export function pyStrip(text: string): string {
    return text.replace(/^\s+|\s+$/g, '');
}

export function text(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('utf8');
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
}

export function str(value: unknown): string {
    return text(value) ?? '';
}
