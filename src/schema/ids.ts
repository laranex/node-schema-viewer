// Producer ids, python-schema-viewer's scheme so that the same database yields the same ids from either package:
// compact JSON arrays of names (Python's json.dumps(parts, ensure_ascii=False, separators=(",", ":"))).

export function identifier(...parts: (string | null)[]): string {
    return JSON.stringify(parts);
}

export function connectionId(name: string): string {
    return `connection:${name}`;
}

// schema null: the connection's default schema.
export function tableId(connection: string, schema: string | null, table: string): string {
    return identifier(connection, schema, table);
}

export function indexId(table: string, name: string): string {
    return `${table}:index:${name}`;
}

export function constraintId(table: string, key: string): string {
    return `${table}:constraint:${key}`;
}

export function foreignKeyId(table: string, name: string | null, columns: string[], target: string, targetColumns: string[]): string {
    return identifier('foreign_key', table, name, identifier(...columns), target, identifier(...targetColumns));
}
