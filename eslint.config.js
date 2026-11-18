import js from '@eslint/js';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'data/**'],
  },
  js.configs.recommended,
  {
    // 浏览器端代码：暴露 DOM 与浏览器 API
    files: ['src/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        DOMException: 'readonly',
        KeyboardEvent: 'readonly',
        Event: 'readonly',
        Date: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        JSON: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // 服务端与脚本：暴露 Node API
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        DOMException: 'readonly',
        Date: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        JSON: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
