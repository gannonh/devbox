import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', 'templates/', '.agents/', 'site/.astro/', 'site/dist/'],
  },
  {
    files: ['scripts/**/*.mjs', 'images/vercel/**/*.mjs', 'packages/dbx/**/*.js'],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
