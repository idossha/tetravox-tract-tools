import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 300_000,
  expect: { timeout: 30_000 },
});
