import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Performance checks (13 §13) that run in Node: `npx vitest run --config test/perf/vitest.config.ts`.
 * Kept out of the default projects so timing and RSS are measured in a quiet, dedicated process.
 */
const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root,
  define: { __ELI5_EDITION__: JSON.stringify('public'), __ELI5_TEST__: 'true' },
  resolve: { alias: { '@eli5/overlay': resolve(root, 'src/main/editions/overlay.none.ts') } },
  test: {
    name: 'perf',
    environment: 'node',
    include: ['test/perf/**/*.test.ts'],
    setupFiles: ['test/helpers/net-guard.ts'],
    env: { TZ: 'UTC', LANG: 'en_US.UTF-8' },
    // One fork, --expose-gc: RSS is measured without other suites in the same process.
    pool: 'forks',
    execArgv: ['--expose-gc'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
