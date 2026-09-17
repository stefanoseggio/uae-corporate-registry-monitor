import prettierConfig from 'eslint-config-prettier';

import apifyConfig from '@apify/eslint-config/ts.js';

export default [
    { ignores: ['dist', 'node_modules', 'storage'] },
    ...apifyConfig,
    prettierConfig,
    {
        files: ['src/**/*.ts', 'tests/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.eslint.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            'no-console': 'error',
        },
    },
    {
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        files: ['eslint.config.mjs'],
        rules: {
            'import-x/no-default-export': 'off',
        },
    },
    {
        // docs/monitoring/*.js scripts are standalone operational CLI tooling, not part of the
        // actor's own runtime (they never run inside an Apify Actor process and have no access to
        // Apify's structured `log` object) - their entire purpose is human-readable console
        // output, so the no-console rule (correct for src/, which must use Apify's logger) does
        // not apply here.
        files: ['docs/**/*.js'],
        rules: {
            'no-console': 'off',
        },
    },
];
