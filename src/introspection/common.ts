// Shared pieces of the catalog readers: the contract shapes python-schema-viewer's introspection/catalog.py writes,
// with the same ids, normalization and text parsing. Worker-side; imports nothing outside this directory.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Row = unknown[];

export interface Part {
    column: string | null;
    expression: string | null;
    order: 'desc' | null;
    nulls: 'first' | 'last' | null;
    length: number | null;
    collation: string | null;
    opclass: string | null;
}

export interface Index {
    id: string;
    name: string;
    parts: Part[];
    columns: string[];
    expression: boolean;
    unique: boolean;
    primary: boolean;
    backs: { kind: 'primary_key' | 'unique_constraint'; constraint: string | null } | null;
    method: string | null;
    partial: boolean;
    predicate: string | null;
    included: string[];
    provenance: ['database'];
    dialectOptions?: Record<string, { options: Record<string, Json> }>;
}

export interface Column {
    name: string;
    type: string;
    typeName: string;
    nullable: boolean;
    autoIncrement: boolean;
    timezone: boolean | null;
    collation: string | null;
    enum: { name: string | null; values: string[] } | null;
    default: { kind: 'literal' | 'expression' | 'sequence' | 'identity'; value: string } | null;
    ormDefault: null;
    generated: { kind: 'stored' | 'virtual' | null; expression: string } | null;
    comment: string | null;
    note: null;
    provenance: ['database'];
}

export interface ForeignKey {
    id: string;
    name: string | null;
    columns: string[];
    foreignTable: string;
    foreignColumns: string[];
    onUpdate: string | null;
    onDelete: string | null;
    deferrable: boolean | null;
    initially: string | null;
    provenance: ['database'];
}

export interface Constraint {
    id: string;
    kind: 'unique' | 'check';
    name: string | null;
    columns: string[];
    expression: string | null;
    provenance: ['database'];
}

export interface Table {
    id: string;
    name: string;
    schema: string | null;
    comment: string | null;
    note: null;
    owner: { kind: string; package: string | null };
    primaryKey: string[];
    columns: Column[];
    indexes: Index[];
    foreignKeys: ForeignKey[];
    constraints: Constraint[];
    provenance: ['database'];
}

export interface Diagnostic {
    kind: string;
    category: 'inspection';
    severity: 'warning';
    certainty: 'certain';
    subject: { type: 'connection'; id: string; columns: null; label: string };
    message: string;
}

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

// Python's json.dumps(parts, ensure_ascii=False, separators=(",", ":")).
export function identifier(...parts: (string | null)[]): string {
    return JSON.stringify(parts);
}

export function connectionId(name: string): string {
    return `connection:${name}`;
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
const ACTIONS = new Set(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']);

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

export function defaultValue(text: string | null): Column['default'] {
    if (text === null) {
        return null;
    }
    const value = text.trim();
    if (value.toLowerCase().startsWith('nextval(')) {
        return { kind: 'sequence', value };
    }
    return { kind: LITERAL.test(value) ? 'literal' : 'expression', value };
}

// A referential action as the contract spells it, or null when it is not an SQL action.
export function action(value: string): string | null {
    const normal = value.trim().toUpperCase().replace(/_/g, ' ');
    return ACTIONS.has(normal) ? normal : null;
}

export function owner(table: string): Table['owner'] {
    const found = Object.hasOwn(OWNERS, table) ? OWNERS[table] : undefined;
    return found === undefined ? { kind: 'application', package: null } : { kind: found[0], package: found[1] };
}

export function part(column: string | null, expression: string | null = null, extra: Partial<Part> = {}): Part {
    return {
        column,
        expression,
        order: extra.order ?? null,
        nulls: extra.nulls ?? null,
        length: extra.length ?? null,
        collation: extra.collation ?? null,
        opclass: extra.opclass ?? null,
    };
}

export function indexEntry(
    tid: string,
    name: string,
    parts: Part[],
    options: {
        unique: boolean;
        primary?: boolean;
        backs?: Index['backs'];
        method?: string | null;
        predicate?: string | null;
        included?: string[];
        dialectOptions?: Index['dialectOptions'] | null;
    },
): Index {
    const predicate = options.predicate ?? null;
    const entry: Index = {
        id: `${tid}:index:${name}`,
        name,
        parts,
        columns: parts.flatMap((p) => (p.column === null ? [] : [p.column])),
        expression: parts.some((p) => p.expression !== null),
        unique: options.unique,
        primary: options.primary ?? false,
        backs: options.backs ?? null,
        method: options.method ?? null,
        partial: predicate !== null,
        predicate,
        included: options.included ?? [],
        provenance: ['database'],
    };
    if (options.dialectOptions) {
        entry.dialectOptions = options.dialectOptions;
    }
    return entry;
}

export function column(c: ColumnFacts, rowid: boolean): Column {
    let defaultEntry = c.computed === null ? defaultValue(c.default) : null;
    if (c.identity !== null) {
        defaultEntry = { kind: 'identity', value: `GENERATED ${c.identity.always ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` };
    }
    return {
        name: c.name,
        type: c.native,
        typeName: typeName(c.native, c.isEnum),
        nullable: c.nullable,
        autoIncrement: rowid || c.autoIncrement,
        timezone: c.timezone,
        collation: c.collation,
        enum: c.isEnum ? { name: c.enumName, values: c.enumValues } : null,
        default: defaultEntry,
        ormDefault: null,
        generated:
            c.computed === null
                ? null
                : { kind: c.computed.persisted === null ? null : c.computed.persisted ? 'stored' : 'virtual', expression: c.computed.sqltext },
        comment: c.comment,
        note: null,
        provenance: ['database'],
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

export function byId<T extends { id: string }>(items: T[]): T[] {
    return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
    const key = (d: Diagnostic): string[] => [d.category, d.kind, d.subject.type, d.subject.id, d.message];
    return diagnostics.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        for (let i = 0; i < x.length; i += 1) {
            const p = x[i] ?? '';
            const q = y[i] ?? '';
            if (p !== q) {
                return p < q ? -1 : 1;
            }
        }
        return 0;
    });
}
