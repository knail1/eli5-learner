import { defineConfig } from '@playwright/test';

/**
 * Packaged-app checks (01 §8.3, 12 §7.8). Needs `release/mac-arm64/ELI5 Learner.app`; every spec is
 * skipped unless ELI5_RUN_PACKAGE_TESTS=1. Not part of `npm test` or `npm run test:e2e`.
 */
export default defineConfig({
  testDir: 'test/package',
  testMatch: '**/*.pkg.ts',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: { trace: 'retain-on-failure' },
});
