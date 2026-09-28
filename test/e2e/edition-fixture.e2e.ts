import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Harness, TITLE, generate, openFromLibrary } from './harness';

/**
 * Cell F, "e2e E14 inverted" (13 §10.1): the enterprise build with the fixture overlay
 * (test/fixtures/overlay-fake) shows the drive and git publish buttons, and clicking them reaches
 * the overlay's recording publishers. Needs that build in out/:
 *   ELI5_TEST_BUILD=1 ELI5_EDITION=enterprise ELI5_OVERLAY_DIR=test/fixtures/overlay-fake npm run build
 * Skipped against any other build (the public E14 lives in m3.e2e.ts).
 */

interface BuildInfo {
  edition?: string;
  overlay?: string;
}

function buildInfo(): BuildInfo {
  try {
    return JSON.parse(readFileSync(path.resolve('out/main/build-info.json'), 'utf8')) as BuildInfo;
  } catch {
    return {};
  }
}

const info = buildInfo();
const fixtureBuild = info.edition === 'enterprise' && (info.overlay ?? '').includes('test/fixtures/overlay-fake');

interface Upload {
  targetId: string;
  slug: string;
  files: string[];
}

test.describe('cell F: fixture overlay (13 §10.1)', () => {
  test.skip(!fixtureBuild, 'needs the fixture-overlay enterprise test build in out/');

  const h = new Harness();
  test.afterEach(() => h.closeAll());
  test.afterAll(() => h.cleanup());

  test('E14 inverted: publish buttons are visible and wired to the fixture publishers', async () => {
    const l = await h.launch(await h.tempDirs('eli5-e2e-cell-f-'));
    const edition = await l.win.evaluate(() => window.eli5.edition.info());
    expect(edition).toMatchObject({ ok: true, value: { edition: 'enterprise', overlayLoaded: true } });
    expect(edition.ok && [...edition.value.uiFeatures].sort()).toEqual(['auth.signIn', 'publish.drive', 'publish.git']);

    const doc = await generate(l);
    await openFromLibrary(l.win, doc.title);
    await expect(l.win.locator('.doc-header h1')).toHaveText(TITLE);
    await expect(l.win.locator('.publish-controls > button')).toHaveText([
      'Export copy',
      'Share to cloud drive',
      'Push to Pages',
    ]);

    const uploads = () =>
      l.app.evaluate(() => {
        const rec = (globalThis as { __eli5FixtureRecorder?: { uploads: Upload[] } }).__eli5FixtureRecorder;
        return (rec?.uploads ?? []).map((u) => ({ targetId: u.targetId, slug: u.slug, files: [...u.files] }));
      });
    expect(await uploads()).toEqual([]);

    for (const [label, targetId, host] of [
      ['Share to cloud drive', 'drive', 'drive.example.test'],
      ['Push to Pages', 'git', 'pages.example.test'],
    ] as const) {
      await l.win.locator('.publish-controls').getByRole('button', { name: label, exact: true }).click();
      const chip = l.win.getByRole('group', { name: `${label} result` });
      // The chip truncates the link text; its title holds the full URL (10 §7 step 1).
      await expect(chip.locator('.chip-link')).toHaveAttribute(
        'title',
        new RegExp(`^https://${host.replace(/\./g, '\\.')}/`),
      );
      await expect
        .poll(async () => (await uploads()).filter((u) => u.targetId === targetId && u.slug === doc.topicSlug).length)
        .toBe(1);
    }
    // The documented file set reached the fakes (10 §3.3): index.html at least, never outside the slug.
    for (const u of await uploads()) {
      expect(u.files).toContain('index.html');
      for (const f of u.files) expect(path.isAbsolute(f) || f.startsWith('..'), f).toBe(false);
    }
  });
});
