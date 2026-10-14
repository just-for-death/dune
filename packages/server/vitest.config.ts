import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // src/tui is an interactive Ink dev tool (needs a TTY); it is
      // typechecked (tsc) and smoke-imported, not unit-covered in CI.
      exclude: ['node_modules/', 'dist/', '**/*.test.ts', '**/*.config.ts', 'src/tui/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
    testTimeout: 30000
  }
});
