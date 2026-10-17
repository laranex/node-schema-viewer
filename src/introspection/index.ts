// Live database introspection: reads a database's catalogs into a laranex-schema 2.0 document (source: database).
//
// It runs in its own introspection worker (worker.ts), separate from the extraction worker that imports application
// code:
//
// - the worker runs under the Permission Model with read access to this package and its database drivers only, an
//   allowlisted environment, a private HOME and TMPDIR and an empty working directory; it never imports application
//   code;
// - it is the only process given the database URL, which travels on stdin, never in the environment or arguments;
//   each connection gets its own worker with only its own URL;
// - it connects with a read-only session (readonly.ts): database-enforced read-only transactions, statement timeouts,
//   an allowlist of catalog statements, and a check of the role's privileges that fails when the role could change
//   the schema or data, unless the caller explicitly accepts that.
//
// See docs/security.md and docs/database.md.
export { IntrospectionError, type DatabaseRequest } from './request.js';
export { introspect, introspectAll, merge } from './runner.js';
