// The interface between the extraction worker and an ORM adapter. The worker imports the adapter, which imports the
// application's modules through the context and returns what they declare as a laranex-schema 1.0 document with
// source "declared". The parent validates the document strictly before using it.

export interface ExtractContext {
    // Absolute path of the project inside the worker (the working directory).
    projectRoot: string;
    modules: readonly string[];
    targets: readonly string[];
    options: Record<string, unknown>;
    // Imports a module the way the project would: paths relative to the project root, package names resolved from it.
    importModule(specifier: string): Promise<Record<string, unknown>>;
}

export interface Extractor {
    extract(context: ExtractContext): unknown;
}

// Registered adapters: name -> module next to the worker. Adapters are added by later milestones (drizzle, typeorm,
// mikro-orm, prisma, sequelize).
export const EXTRACTORS: Readonly<Record<string, string>> = {};

export const EXTRACTOR_NAME = /^[a-z][a-z0-9-]*$/;
