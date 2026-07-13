import globals from 'globals';

export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.es2021,
                ARGV: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
                global: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-undef': 'error',
            'no-var': 'error',
            'prefer-const': 'warn',
            'eqeqeq': ['error', 'always'],
            'no-throw-literal': 'error',
            'no-implicit-coercion': 'warn',
            'semi': ['warn', 'always'],
            'no-extra-semi': 'warn',
            'comma-dangle': ['warn', 'always-multiline'],
            'no-trailing-spaces': 'warn',
        },
    },
    {
        ignores: ['node_modules/', 'build/', '*.zip'],
    },
];
