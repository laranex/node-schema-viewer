// Defense in depth for the introspection worker: only catalog statements reach a driver. The databases enforce
// read-only sessions themselves (readonly.ts); this refuses anything else before it is sent. A port of
// python-schema-viewer's introspection/readonly.py STATEMENT and MySQL grant rules.
import { IntrospectionError } from './request.js';

export const STATEMENT =
    /^\s*(SELECT|WITH|SHOW|SET\s+(SESSION|TRANSACTION|LOCAL|NAMES)|BEGIN|START\s+TRANSACTION|ROLLBACK|PRAGMA\s+query_only\s*=\s*(1|ON)\s*$|PRAGMA\s+[\w.]+\s*(\(\s*[^)=;]*\))?\s*;?\s*$)/i;

export function assertCatalogStatement(sql: string): void {
    if (!STATEMENT.test(sql)) {
        throw new IntrospectionError(`Refused a statement that is not a catalog read: ${JSON.stringify(sql.trim().slice(0, 80))}`);
    }
}

// Privileges that only read. Everything else (INSERT, CREATE, ALTER, ALL PRIVILEGES, GRANT OPTION...) is a problem.
const MYSQL_READ_ONLY = new Set([
    'SELECT',
    'SHOW VIEW',
    'USAGE',
    'SHOW DATABASES',
    'PROCESS',
    'REPLICATION CLIENT',
    'BINLOG MONITOR',
    'SLAVE MONITOR',
    'REPLICA MONITOR',
]);
const MYSQL_GRANT = /^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\s/i;

// What the grants of SHOW GRANTS allow beyond reading. An empty list means a read-only account.
export function mysqlGrantProblems(grants: readonly string[]): string[] {
    const problems: string[] = [];
    for (const grant of grants) {
        const match = MYSQL_GRANT.exec(grant);
        if (match === null) {
            // A role granted to the user ("GRANT `role` TO ..."): its privileges are not listed here.
            const upper = grant.toUpperCase();
            if (upper.startsWith('GRANT ') && upper.includes(' TO ')) {
                problems.push(`holds a role whose privileges cannot be verified (${(grant.split(' TO ')[0] ?? '').slice(6)})`);
            }
            continue;
        }
        const privileges = new Set((match[1] ?? '').split(',').map((p) => p.replace(/\s*\(.*?\)/g, '').trim().toUpperCase()));
        const extra = [...privileges].filter((p) => !MYSQL_READ_ONLY.has(p)).sort(codePoints);
        if (grant.toUpperCase().includes('WITH GRANT OPTION')) {
            extra.push('GRANT OPTION');
        }
        if (extra.length > 0) {
            problems.push(`has ${extra.join(', ')} on ${match[2] ?? ''}`);
        }
    }
    return problems;
}

// Python's default string order (by code point), unlike localeCompare.
export function codePoints(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
