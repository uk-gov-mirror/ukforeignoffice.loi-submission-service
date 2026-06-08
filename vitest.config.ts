import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', '!server/app.js', '!server/server.js'],
      thresholds: {
        statements: 41,
        branches: 17,
        functions: 56,
        lines: 41,
      },
    },
  },
})
