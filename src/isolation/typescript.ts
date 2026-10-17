// TypeScript model files in the extraction worker: a synchronous module.registerHooks load hook (Node.js 22.15+)
// that transpiles .ts/.mts/.cts files with the project's own `typescript` package (5.x or 6.x; TypeScript 7 has no
// JavaScript API). Transpiling, not type stripping: ORMs such as TypeORM need legacy decorators and their metadata,
// which Node.js's built-in type stripping does not support. module.register is never used: it starts a loader
// thread, which the Permission Model refuses.
import { readFileSync } from 'node:fs';
import module, { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CompilerOptions {
    [option: string]: unknown;
}

interface TypeScript {
    version: string;
    ModuleKind: { CommonJS: number; ESNext: number };
    ScriptTarget: { ES2022: number };
    transpileModule(source: string, options: { fileName: string; compilerOptions: CompilerOptions }): { outputText: string };
    findConfigFile(root: string, exists: (path: string) => boolean): string | undefined;
    getParsedCommandLineOfConfigFile(path: string, extended: CompilerOptions | undefined, host: unknown): { options: CompilerOptions } | undefined;
    sys: { fileExists(path: string): boolean } & Record<string, unknown>;
}

const TYPESCRIPT_FILE = /\.([mc]?)ts$/;
const DECLARATION_FILE = /\.d\.[mc]?ts$/;

export function typeScriptHooksAvailable(): boolean {
    return typeof module.registerHooks === 'function';
}

export function installTypeScriptHooks(projectRoot: string): void {
    let typescript: TypeScript | undefined;
    let projectOptions: CompilerOptions | undefined;
    const packageTypes = new Map<string, string>();

    function compiler(): TypeScript {
        if (typescript === undefined) {
            try {
                typescript = createRequire(join(projectRoot, 'package.json'))('typescript') as TypeScript;
            } catch {
                throw new Error('TypeScript model files need the typescript package (5.x or 6.x) installed in the project');
            }
            projectOptions = configOptions(typescript, projectRoot);
        }
        return typescript;
    }

    function packageType(path: string): string {
        let directory = dirname(path);
        const visited: string[] = [];
        for (;;) {
            const known = packageTypes.get(directory);
            if (known !== undefined) {
                visited.forEach((d) => packageTypes.set(d, known));
                return known;
            }
            visited.push(directory);
            let type: string | undefined;
            try {
                const data = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { type?: unknown };
                type = data.type === 'module' ? 'module' : 'commonjs';
            } catch {
                // No readable package.json here.
            }
            const parent = dirname(directory);
            if (type !== undefined || parent === directory) {
                const result = type ?? 'commonjs';
                visited.forEach((d) => packageTypes.set(d, result));
                return result;
            }
            directory = parent;
        }
    }

    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            try {
                return nextResolve(specifier, context);
            } catch (error) {
                // TypeScript sources import siblings by their emitted name: './user.js' for ./user.ts.
                const parent = context.parentURL;
                if (parent !== undefined && TYPESCRIPT_FILE.test(parent) && /^\.\.?\//.test(specifier) && /\.[mc]?js$/.test(specifier)) {
                    try {
                        return nextResolve(specifier.replace(/js$/, 'ts'), context);
                    } catch {
                        // Report the original failure.
                    }
                }
                throw error;
            }
        },
        load(url, context, nextLoad) {
            const match = TYPESCRIPT_FILE.exec(url);
            if (match === null || !url.startsWith('file:') || DECLARATION_FILE.test(url)) {
                return nextLoad(url, context);
            }
            const ts = compiler();
            const path = fileURLToPath(url);
            const format = match[1] === 'm' ? 'module' : match[1] === 'c' ? 'commonjs' : packageType(path);
            const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), {
                fileName: path,
                compilerOptions: {
                    ...projectOptions,
                    module: format === 'module' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
                    sourceMap: false,
                    inlineSourceMap: true,
                    declaration: false,
                    noEmit: false,
                },
            });
            return { format, source: outputText, shortCircuit: true };
        },
    });
}

// The options of the project's tsconfig.json that change emitted JavaScript. Without a tsconfig, or when it does not
// choose, legacy decorators with metadata, as the TypeScript ORMs expect.
function configOptions(ts: TypeScript, projectRoot: string): CompilerOptions {
    const options: CompilerOptions = { target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true };
    const path = ts.findConfigFile(projectRoot, (file) => ts.sys.fileExists(file));
    if (path === undefined) {
        return options;
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(path, undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    const chosen = parsed?.options ?? {};
    for (const key of ['target', 'experimentalDecorators', 'emitDecoratorMetadata', 'useDefineForClassFields', 'esModuleInterop', 'jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource']) {
        if (chosen[key] !== undefined) {
            options[key] = chosen[key];
        }
    }
    return options;
}
