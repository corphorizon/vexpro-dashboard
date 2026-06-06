import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config — kept intentionally minimal. We run tests in node
 * environment (server logic, pure calculations, schema validation).
 * Browser-side tests (React Testing Library + jsdom) can be added in
 * a separate folder later if needed; for now the priority is making
 * the calculation core regression-proof.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/lib/env.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
