import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    restoreMocks: true,
  },
})
