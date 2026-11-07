import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['dist/**'] },
  {
    files: ['src/**/*.ts', 'manifest.json', 'package.json', 'LICENSE'],
    extends: obsidianmd.configs.recommended,
  },
  // Node-based fixtures and build scripts are not Obsidian plugin runtime code.
  { files: ['tests/**/*.ts', 'scripts/**/*.mjs'], extends: tseslint.configs.recommended },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      'no-console': 'error',
      'no-restricted-imports': ['error', { patterns: ['node:*', 'electron', 'fs', 'fs/*'] }],
    },
  },
]);
