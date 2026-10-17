// The environment an extraction worker sees: an allowlist, never the parent's whole environment.
import { IsolationError } from './index.js';

// What Node.js and typical model modules need to start: the search path, locale, time zone, terminal, NODE_ENV and
// the Windows system variables. NODE_ENV is allowed because configuration modules commonly branch on it at import
// time and it never holds a credential. NODE_OPTIONS and NODE_PATH are never passed: they could load code before the
// worker starts or widen module resolution beyond the permitted directories.
const ALLOWED = new Set(['PATH', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'NODE_ENV', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']);
const ALLOWED_PREFIXES = ['LC_'];
// Refused in envPassthrough: names that look like credentials, ORM connection settings, and variables that change
// how Node.js or npm load code.
const CREDENTIAL =
    /(PASSWORD|PASSWD|PASSFILE|SECRET|TOKEN|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|_KEY$|^DATABASE_URL$|_DSN$|_URI$|_URL$|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^MIKRO_ORM_|^TYPEORM_|^PG[A-Z]*$|^MYSQL_|^npm_config_)/i;
const LOADER = /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_V8_COVERAGE|NODE_COMPILE_CACHE)$/i;
// NODE_ENV is passed unchanged when the parent sets it, and only as a plain token such as production or test.
const NODE_ENV_VALUE = /^[A-Za-z0-9._-]{1,32}$/;
// A URL with a password in it, which no placeholder needs.
const URL_WITH_PASSWORD = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/;

export interface WorkerEnvironment {
    env: Record<string, string>;
    // How many of the source variables were left out; names and values are never reported.
    withheld: number;
}

export function workerEnvironment(
    source: NodeJS.ProcessEnv,
    options: { passthrough: readonly string[]; fixed: Readonly<Record<string, string>>; home: string; tmp: string; keepPath?: boolean },
): WorkerEnvironment {
    const refused = options.passthrough.filter((name) => CREDENTIAL.test(name) || LOADER.test(name));
    if (refused.length > 0) {
        throw new IsolationError(
            `envPassthrough must not carry credentials or loader settings (${[...refused].sort().join(', ')}); give the ` +
                'extraction worker a placeholder in the isolation env instead',
        );
    }
    const badFixed = Object.entries(options.fixed)
        .filter(([name, value]) => LOADER.test(name) || URL_WITH_PASSWORD.test(value))
        .map(([name]) => name);
    if (badFixed.length > 0) {
        throw new IsolationError(
            `The isolation env must not set loader settings or URLs with passwords (${badFixed.sort().join(', ')}); use a placeholder`,
        );
    }
    for (const [origin, values] of [['The environment', source], ['The isolation env', options.fixed]] as const) {
        for (const [name, value] of Object.entries(values)) {
            if (name.toUpperCase() === 'NODE_ENV' && value !== undefined && !NODE_ENV_VALUE.test(value)) {
                throw new IsolationError(
                    `${origin} sets NODE_ENV to a value the extraction worker does not accept: it must be a plain token of at most ` +
                        '32 letters, digits, dots, underscores or hyphens (such as production or test). Unset or correct it.',
                );
            }
        }
    }
    const passthrough = new Set(options.passthrough);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (value === undefined) {
            continue;
        }
        const upper = name.toUpperCase();
        if (upper === 'PATH' && options.keepPath === false) {
            continue;
        }
        if (ALLOWED.has(upper) || ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || passthrough.has(name)) {
            env[name] = value;
        }
    }
    Object.assign(env, options.fixed);
    Object.assign(env, { HOME: options.home, USERPROFILE: options.home, TMPDIR: options.tmp, TEMP: options.tmp, TMP: options.tmp });
    const withheld = Object.entries(source).filter(([name, value]) => value !== undefined && !(name in env)).length;
    return { env, withheld };
}
