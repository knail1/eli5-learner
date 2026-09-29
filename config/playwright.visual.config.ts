import { defineConfig } from '@playwright/test';

/**
 * Visual regression (13 §7.4): pixel comparisons of the golden documents in Chromium and WebKit
 * (`docs.visual.ts`, file://, no app build) and of the app shell in Electron (`app.visual.ts`, needs
 * an ELI5_TEST_BUILD=1 build). `npm run test:visual` builds and runs both; `npm run
 * test:visual:update` rewrites the baselines, which must be reviewed on the contact sheet
 * (test-results/visual/index.html) before they are committed. Not part of `npm test` or
 * `npm run test:e2e`. Paths are relative to this file (config/).
 */

/**
 * 13 §7.4 tolerances: anti-aliasing noise passes, a moved or recolored element does not. `threshold`
 * is the per-pixel YIQ color distance (0-1) below which a pixel counts as equal. Of the two caps on
 * differing pixels Playwright applies the smaller: 0.2% of the image or 20 pixels (5 CSS px² at 2x).
 * A ratio alone is too loose on big shots: at 1% a whole "Moved to Trash" toast plus an extra
 * sidebar row passed on the window shot (0.94%), and a folder count moved by 45 px differed in only
 * 80 pixels (muted anti-aliased text is mostly under `threshold`). Runs on one Mac are
 * pixel-identical, so the caps only absorb engine noise.
 */
export const VISUAL_TOLERANCE = { threshold: 0.2, maxDiffPixelRatio: 0.002, maxDiffPixels: 20 } as const;

// 13 §3.2 locale and time zone; 13 §7.4 determinism: 2x pixels, reduced motion, no caret, no animation.
const use = {
  locale: 'en-US',
  timezoneId: 'UTC',
  deviceScaleFactor: 2,
  reducedMotion: 'reduce',
  viewport: { width: 1280, height: 800 },
  trace: 'retain-on-failure',
} as const;

export default defineConfig({
  outputDir: '../test-results/visual/output',
  // Baselines are committed per platform; darwin is the reference platform (13 §7.4).
  snapshotPathTemplate: '../test/visual/__screenshots__/{testFileName}/{arg}{-projectName}{-platform}{ext}',
  expect: {
    toHaveScreenshot: { ...VISUAL_TOLERANCE, animations: 'disabled', caret: 'hide', scale: 'device' },
    toMatchSnapshot: VISUAL_TOLERANCE,
  },
  // No retries: a screenshot that only matches on the second try is a determinism bug to fix.
  retries: 0,
  reporter: [[process.env.CI ? 'github' : 'list'], ['../test/visual/contact-sheet.ts']],
  projects: [
    {
      name: 'chromium',
      testDir: '../test/visual',
      testMatch: 'docs.visual.ts',
      timeout: 60_000,
      fullyParallel: true,
      use: { ...use, browserName: 'chromium' },
    },
    {
      name: 'webkit',
      testDir: '../test/visual',
      testMatch: 'docs.visual.ts',
      timeout: 60_000,
      fullyParallel: true,
      use: { ...use, browserName: 'webkit' },
    },
    {
      // Electron via the e2e harness: one app at a time, like the e2e project.
      name: 'app',
      testDir: '../test/visual',
      testMatch: 'app.visual.ts',
      timeout: 120_000,
      fullyParallel: false,
      use: { trace: 'retain-on-failure' },
    },
  ],
});
