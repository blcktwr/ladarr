import { defineConfig, devices } from '@playwright/test';

// The tests start their own server on port 3111 (LADARR_E2E_PORT), so they run in one worker, one file after the other.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
});
