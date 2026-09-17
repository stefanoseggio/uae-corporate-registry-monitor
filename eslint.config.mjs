import prettierConfig from 'eslint-config-prettier';

import apifyConfig from '@apify/eslint-config/ts.js';

export default [
    { ignores: ['dist', 'node_modules', 'storage'] },
    ...apifyConfig,
    prettierConfig,
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
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
        files: ['test/**/*.ts'],
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
    {
        // examples/*.cjs is a standalone, runnable usage snippet referenced from the README, not
        // part of the actor's own bundled runtime - it intentionally uses console.log (its whole
        // purpose is printing output) and its own `apify-client` import is a documented dependency
        // a reader installs separately (see the file's own "Install:" comment), not a dependency
        // of this package.
        files: ['examples/**/*.cjs'],
        rules: {
            'no-console': 'off',
            'import-x/no-extraneous-dependencies': 'off',
        },
    },
];
