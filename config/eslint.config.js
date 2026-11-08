import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

const mainModules = [
  'config',
  'devtools',
  'document',
  'editions',
  'extract',
  'fetch',
  'ipc',
  'library',
  'llm',
  'photos',
  'pipeline',
  'publish',
  'security',
  'shell',
  'sources',
  'sync',
];

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      'out/**',
      'build/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'docs/**',
      'enterprise/**',
      'coverage/**',
      // The Android project is its own Gradle build (16 §6.1); its build/ holds generated JS reports.
      'android/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.mjs'] } },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Import boundaries (01 §3, 13 §13).
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: ['./src/renderer', './src/doc-runtime'],
              from: './src/main',
              message: 'Renderers talk to main only through src/preload/contract.ts.',
            },
            {
              target: './src/doc-runtime',
              from: ['./src/preload', './src/renderer'],
              message: 'The doc-runtime imports nothing outside its own folder and src/shared.',
            },
            // src/shared (01 module map): pure code for main and the doc-runtime; imports only src/shared.
            {
              target: './src/shared',
              from: ['./src/main', './src/preload', './src/renderer', './src/doc-runtime'],
              message: 'src/shared imports only src/shared.',
            },
            // Modules import each other only through index.ts.
            ...mainModules.map((m) => ({
              target: `./src/main/!(${m})/**/*`,
              from: `./src/main/${m}`,
              except: ['./index.ts'],
              message: `Import src/main/${m} through its index.ts.`,
            })),
          ],
        },
      ],
    },
  },
  {
    // Vendor LLM SDKs only in llm/, network only in llm/, fetch/ and (v2) sync/: Google OAuth, Drive
    // REST and the loopback listener (12 §11, 16 §8).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/main/llm/**', 'src/main/fetch/**', 'src/main/sync/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@anthropic-ai/sdk', message: 'LLM SDKs belong in src/main/llm/.' },
            { name: 'openai', message: 'LLM SDKs belong in src/main/llm/.' },
            { name: 'node:http', message: 'Network access belongs in src/main/llm/ or src/main/fetch/.' },
            { name: 'node:https', message: 'Network access belongs in src/main/llm/ or src/main/fetch/.' },
            { name: 'undici', message: 'Network access belongs in src/main/llm/ or src/main/fetch/.' },
          ],
        },
      ],
    },
  },
  {
    // sync/ may reach the network (above) but still never imports an LLM SDK.
    files: ['src/main/sync/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@anthropic-ai/sdk', message: 'LLM SDKs belong in src/main/llm/.' },
            { name: 'openai', message: 'LLM SDKs belong in src/main/llm/.' },
          ],
        },
      ],
    },
  },
  {
    // Overlays import public code only as `@eli5/public/<module>` (01 §6.5 step 4.3); `llm/testing`
    // is the one documented test entry. enterprise/ is linted by the private repo with the same rule.
    files: ['test/fixtures/overlay-fake/**/*.ts', 'enterprise/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@eli5/public/*/**', '!@eli5/public/llm/testing'],
              message: 'Import public code only through @eli5/public/<module> (no deep imports).',
            },
            {
              group: ['**/src/main/**', '**/src/main'],
              message: 'Overlays reach public code only through the @eli5/public/* alias.',
            },
          ],
        },
      ],
    },
  },
  {
    // src/shared runs in main and in every generated document: no Node built-ins or packages.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^(?!\\.{1,2}/)', message: 'src/shared imports only src/shared (relative paths).' }] },
      ],
    },
  },
  {
    // No co-located tests under src/ (13 §2).
    files: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', { selector: 'Program', message: 'Tests live under test/, not src/.' }] },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        exports: 'writable',
        module: 'writable',
        __dirname: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}', 'eslint.config.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
