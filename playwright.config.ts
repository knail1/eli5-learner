import { defineConfig } from '@playwright/test';
import { crossbrowserProjects } from './playwright.crossbrowser.config';

/**
 * `playwright test` is the 13 §12 e2e job: the `_electron` e2e specs and the startup check (both
 * need an ELI5_TEST_BUILD=1 build, see `npm run test:e2e`) plus the cross-browser smoke and
 * zero-network probe over the goldens (13 §7.2, §7.3). `--project e2e` runs one of them.
 */
export default defineConfig({
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'e2e', testDir: 'test/e2e', testMatch: '**/*.e2e.ts' },
    // 13 §13 startup time, warning only.
    { name: 'perf', testDir: 'test/perf', testMatch: '**/*.perf.ts' },
    ...crossbrowserProjects,
  ],
});
