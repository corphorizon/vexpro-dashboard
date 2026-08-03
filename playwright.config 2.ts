import { defineConfig } from '@playwright/test';

// E2E tests for the MONEY flows. Everything runs against the dedicated
// 'e2e-test' tenant (seeded/reset in e2e/global-setup.ts), never against
// production tenants.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'es-419',
  },
  webServer: {
    command: 'npm run dev',
    port: 3100,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
