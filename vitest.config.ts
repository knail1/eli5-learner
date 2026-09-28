import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;
const overlayDir = resolve(root, process.env.ELI5_OVERLAY_DIR ?? 'enterprise');
const hasOverlay = existsSync(resolve(overlayDir, 'index.ts')) && existsSync(resolve(overlayDir, 'contracts'));
if (!hasOverlay && !process.env.ELI5_OVERLAY_NOTICE) {
  console.log('contracts:enterprise skipped: no overlay present');
  process.env.ELI5_OVERLAY_NOTICE = '1';
}

const shared = {
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

export default defineConfig({
  ...shared,
  test: {
    env: { TZ: 'UTC', LANG: 'en_US.UTF-8' },
    coverage: {
      provider: 'v8',
      include: ['src/main/**', 'src/doc-runtime/**'],
      exclude: ['**/*.stub.ts', '**/testing/**'],
    },
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          exclude: ['test/unit/renderer/**', 'test/unit/doc-runtime/**'],
          setupFiles: ['test/helpers/net-guard.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['test/unit/renderer/**/*.test.{ts,tsx}', 'test/unit/doc-runtime/**/*.test.ts'],
          setupFiles: ['test/helpers/net-guard.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'contracts:public',
          environment: 'node',
          include: ['test/contracts/**/*.public.test.ts'],
          setupFiles: ['test/helpers/net-guard.ts'],
        },
      },
      ...(hasOverlay
        ? [
            {
              ...shared,
              test: {
                name: 'contracts:enterprise',
                environment: 'node',
                include: [`${overlayDir}/contracts/**/*.test.ts`],
              },
            },
          ]
        : []),
    ],
  },
});
