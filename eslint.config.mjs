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
];
