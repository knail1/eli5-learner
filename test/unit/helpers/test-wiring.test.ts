/**
 * The M4 quality checks run where the spec says, not only on a manual invocation: `playwright test`
 * (the 13 §12 e2e job) covers e2e, cross-browser (13 §7.2, §7.3) and startup (13 §13), and
 * `vitest run` covers the memory budget (13 §13).
 */
import { describe, expect, it } from 'vitest';
import playwrightConfig from '../../../playwright.config';
import vitestConfig from '../../../vitest.config';

describe('default test runs include the quality checks', () => {
  it('playwright test runs e2e, cross-browser in Chromium and WebKit, and startup', () => {
    const projects = (playwrightConfig.projects ?? []).map((p) => ({
      name: p.name,
      dir: p.testDir,
      browser: p.use?.browserName,
    }));
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dir: 'test/e2e' }),
        expect.objectContaining({ dir: 'test/crossbrowser', browser: 'chromium' }),
        expect.objectContaining({ dir: 'test/crossbrowser', browser: 'webkit' }),
        expect.objectContaining({ dir: 'test/perf' }),
      ]),
    );
  });

  it('vitest run includes the perf project', () => {
    const perf = (vitestConfig.test?.projects ?? []).find(
      (p) => typeof p === 'object' && 'test' in p && p.test?.name === 'perf',
    );
    expect(perf).toMatchObject({ test: { include: ['test/perf/**/*.test.ts'], execArgv: ['--expose-gc'] } });
  });
});
