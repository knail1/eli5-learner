import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * Startup time (13 §13): the main window is visible within 3 s of launch. Warning only: a slower
 * start is reported as an annotation and a console warning, never a failure; only a window that
 * never appears fails. Needs a build (`npx electron-vite build`).
 */
const BUDGET_MS = 3_000;

test('main window visible within 3 s of launch (warning only)', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'eli5-perf-'));
  const started = Date.now();
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...(process.env as Record<string, string>),
      ELI5_USER_DATA_DIR: userData,
      ELI5_LIBRARY_DIR: path.join(userData, 'docs'),
      ELI5_KEYSTORE: 'memory',
      TZ: 'UTC',
    },
  });
  try {
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible())), {
        timeout: 30_000,
        intervals: [25],
      })
      .toBe(true);
    const visibleMs = Date.now() - started;
    const win = await app.firstWindow();
    await expect(win.getByRole('heading', { name: 'Turn anything into an explainer.' })).toBeVisible();
    const interactiveMs = Date.now() - started;

    const line = `window visible ${visibleMs} ms, UI ready ${interactiveMs} ms (budget ${BUDGET_MS} ms)`;
    test.info().annotations.push({ type: 'startup', description: line });
    if (visibleMs > BUDGET_MS) {
      test.info().annotations.push({ type: 'warning', description: `startup over budget: ${line}` });
      console.warn(`[perf] WARNING startup over budget: ${line}`);
    } else console.log(`[perf] ${line}`);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});
