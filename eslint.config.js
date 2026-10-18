import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'build/', 'node_modules/', 'tests/fixtures/', '.gh-page/', 'examples/'] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
        languageOptions: {
            parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs'] }, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            '@typescript-eslint/no-floating-promises': [
                'error',
                { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'test', 'suite', 'it'] }] },
            ],
        },
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
    },
);
