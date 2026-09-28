import { defineConfig, type PlaywrightTestProject } from '@playwright/test';

/**
 * Cross-browser smoke and runtime zero-network probe over the golden documents (13 §7.2, §7.3):
 * Chromium covers the Chrome and Edge engines, WebKit the Safari engine. No app build needed.
 * The e2e config (config/playwright.e2e.config.ts, the 13 §12 e2e job) includes these
 * projects; this config runs them alone: `npx playwright test -c config/playwright.crossbrowser.config.ts`.
 * Needs `npx playwright install chromium webkit`.
 */
// 13 §3.2: deterministic locale and time zone.
const use = { locale: 'en-US', timezoneId: 'UTC', trace: 'retain-on-failure' } as const;

export const crossbrowserProjects: PlaywrightTestProject[] = (['chromium', 'webkit'] as const).map((browserName) => ({
  name: `crossbrowser-${browserName}`,
  testDir: '../test/crossbrowser',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  use: { ...use, browserName },
}));

export default defineConfig({
  outputDir: '../test-results/crossbrowser',
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  projects: crossbrowserProjects,
});
