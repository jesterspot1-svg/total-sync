import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': ['error', { patterns: ['node:*', 'electron', 'fs', 'fs/*'] }],
    },
  },
];
