import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Eval suite config (13 §9). Three projects:
 * - `evals:unit`: offline tests of the runner (FakeProvider generator, fake judge, net-guard on).
 * - `evals:run`: the real eval run (real providers, network allowed, cost-capped). Only through
 *   `scripts/eval/run.mjs`, never on pull requests.
 * - `evals:calibrate`: judge vs human agreement over test/evals/calibration (13 §9.5).
 */
const root = resolve(import.meta.dirname, '../..');

const shared = {
  root,
  define: {
    __ELI5_EDITION__: JSON.stringify('public'),
    __ELI5_TEST__: 'true',
  },
  resolve: {
    alias: {
      '@eli5/overlay': resolve(root, 'src/main/editions/overlay.none.ts'),
    },
  },
};

const env = { TZ: 'UTC', LANG: 'en_US.UTF-8' };

export default defineConfig({
  ...shared,
  test: {
    env,
    projects: [
      {
        ...shared,
        test: {
          name: 'evals:unit',
          environment: 'node',
          env,
          include: ['test/evals/**/*.test.ts'],
          setupFiles: ['test/helpers/net-guard.ts'],
          testTimeout: 60_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'evals:run',
          environment: 'node',
          // Real providers: net-guard (imported by the fixture server) must not block the API.
          env: { ...env, ELI5_ALLOW_NET: '1' },
          include: ['test/evals/run.eval.ts'],
          testTimeout: 6 * 60 * 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'evals:calibrate',
          environment: 'node',
          env: { ...env, ELI5_ALLOW_NET: '1' },
          include: ['test/evals/calibrate.eval.ts'],
          testTimeout: 2 * 60 * 60_000,
        },
      },
    ],
  },
});
