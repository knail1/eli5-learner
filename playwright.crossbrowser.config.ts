import { defineConfig } from '@playwright/test';

/**
 * Cross-browser smoke and runtime zero-network probe over the golden documents (13 §7.2, §7.3):
 * Chromium covers the Chrome and Edge engines, WebKit the Safari engine. No app build needed.
 * Run with `npx playwright test -c playwright.crossbrowser.config.ts`.
 */
export default defineConfig({
  testDir: 'test/crossbrowser',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/crossbrowser',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // 13 §3.2: deterministic locale and time zone.
  use: { locale: 'en-US', timezoneId: 'UTC', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
