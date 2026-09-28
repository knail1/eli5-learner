import { defineConfig } from '@playwright/test';

/**
 * App-level performance checks (13 §13) against the built app; also the `perf` project of the
 * e2e config (config/playwright.e2e.config.ts). Alone:
 * `npx electron-vite build --config config/electron.vite.config.ts && npx playwright test -c test/perf/playwright.perf.config.ts`.
 * Run from the repository root (the specs launch `path.resolve('.')`).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.perf.ts',
  outputDir: '../../test-results/perf',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
