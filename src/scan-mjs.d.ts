// laranex-schema-viewer-ui ships contract/scan.mjs without type declarations; this is the part src/scan.ts uses.
declare module 'laranex-schema-viewer-ui/contract/scan.mjs' {
    export function run(
        argv: string[],
        options?: { cwd?: string; stdout?: { write(text: string): unknown }; stderr?: { write(text: string): unknown }; limit?: number },
    ): 0 | 1 | 2 | 3;
}
