import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Flat config (ESLint 10). Mirrors the previous .eslintrc.json: JS recommended
// + typescript-eslint recommended, with `any` and unused vars as warnings.
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
);
