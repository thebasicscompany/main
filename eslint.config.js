import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const globals = {
  AbortController: 'readonly',
  Buffer: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  RequestInit: 'readonly',
  Response: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
}

export default [
  {
    ignores: [
      '.sst/**',
      'node_modules/**',
      'vendor/**',
      '**/.next/**',
      '**/dist/**',
      '**/dist-bundle/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals,
    },
    rules: {
      'no-undef': 'off',
      'no-case-declarations': 'off',
      'no-constant-binary-expression': 'off',
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-extra-boolean-cast': 'off',
      'no-prototype-builtins': 'off',
      'no-unsafe-optional-chaining': 'off',
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',
      'preserve-caught-error': 'off',
    },
  },
]
