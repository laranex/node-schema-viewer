// What both sides of database introspection share: the request, its error type, URL parsing and scrubbing. Imported by
// the introspection worker, so it uses only JavaScript built-ins.

export class IntrospectionError extends Error {
    override name = 'IntrospectionError';
}

export interface DatabaseRequest {
    // postgres(ql)://, mysql://, mariadb:// or sqlite: (a path to an existing file). Travels to the worker on stdin only.
    url: string;
    // Schemas to read; empty means the connection's default schema. Ignored by MySQL/MariaDB (the URL's database) and SQLite.
    schemas?: readonly string[];
    // The contract connection name. Default "default".
    connection?: string;
    // Inspect even when the role holds privileges beyond reading the catalogs (still inside read-only transactions).
    allowWritePrivileges?: boolean;
    // Seconds for the whole inspection (default 120) and for each statement (default 30).
    timeout?: number;
    statementTimeout?: number;
}

export type Dialect = 'postgresql' | 'mysql' | 'sqlite';

export interface ParsedUrl {
    dialect: Dialect;
    // The decoded password, for scrubbing messages.
    password: string | null;
    // SQLite: the file path as written (absolute, or relative to the current directory).
    path: string | null;
}

const SCHEMES: Readonly<Record<string, Dialect>> = {
    'postgres:': 'postgresql',
    'postgresql:': 'postgresql',
    'mysql:': 'mysql',
    'mariadb:': 'mysql',
    'sqlite:': 'sqlite',
};
// URL parameters the worker passes to the driver. Others could override the read-only session settings (options,
// statement_timeout...), or make the driver read TLS files the worker may not read (sslrootcert...;
// NODE_EXTRA_CA_CERTS adds a CA instead), so they are refused.
const PARAMETERS: Readonly<Record<'postgresql' | 'mysql', ReadonlySet<string>>> = {
    postgresql: new Set(['sslmode', 'ssl', 'uselibpqcompat', 'sslnegotiation', 'host']),
    mysql: new Set(['ssl']),
};

// Never echoes the URL: it may hold a password.
export function parseUrl(url: string): ParsedUrl {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new IntrospectionError('The database URL is not a valid URL');
    }
    const dialect = SCHEMES[parsed.protocol];
    if (dialect === undefined) {
        const scheme = parsed.protocol.slice(0, -1);
        const hint = scheme.includes('+') ? ` (use a plain scheme such as postgresql://, without the ${JSON.stringify(scheme.split('+')[1] ?? '')} driver)` : '';
        throw new IntrospectionError(`Inspecting ${JSON.stringify(scheme)} URLs is not supported${hint}; use PostgreSQL, MySQL, MariaDB, or SQLite`);
    }
    const password = parsed.password === '' ? null : decode(parsed.password);
    if (dialect === 'sqlite') {
        if (parsed.host !== '' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '') {
            throw new IntrospectionError('A SQLite URL is sqlite:/absolute/path.db or sqlite:relative/path.db, without a host or parameters');
        }
        const path = decode(parsed.pathname);
        if (path === '' || path === ':memory:' || path === '/') {
            throw new IntrospectionError('SQLite introspection needs the path of an existing database file');
        }
        return { dialect, password: null, path };
    }
    for (const key of parsed.searchParams.keys()) {
        if (!PARAMETERS[dialect].has(key)) {
            throw new IntrospectionError(`The database URL parameter ${JSON.stringify(key)} is not supported for introspection`);
        }
    }
    if (dialect === 'mysql' && decode(parsed.pathname.replace(/^\//, '')) === '') {
        throw new IntrospectionError('A MySQL or MariaDB URL needs a database name (the schema to inspect)');
    }
    return { dialect, password, path: null };
}

function decode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

// Removes the URL and its password from a message. Very short passwords would mask fragments of ordinary words.
export function scrub(message: string, url: string): string {
    let out = url === '' ? message : message.split(url).join('<database url>');
    let password: string | null = null;
    try {
        password = new URL(url).password;
    } catch {
        // Not a URL; nothing more to hide.
    }
    if (password !== null && password !== '') {
        for (const form of new Set([password, decode(password)])) {
            if (form.length >= 4) {
                out = out.split(form).join('***');
            }
        }
    }
    return out;
}
