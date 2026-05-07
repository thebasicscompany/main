import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.live.test.ts', 'node_modules', 'dist'],
    reporters: ['default'],
  },
})
