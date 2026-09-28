import { act, createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EditionInfo,
  IpcResult,
  PublishProgressEvent,
  PublishResult,
  PublishTarget,
} from '../../../src/preload/contract';
import {
  PUBLIC_EDITION,
  button,
  click,
  flush,
  installFakeApi,
  loadRenderer,
  ok,
  render,
  type FakeApi,
} from './harness';

/** Publish slot in the document header (10 §7, 11 §5.3, HOOK-UI-01). */

const { PublishControls, truncateMiddle, linkText } = await loadRenderer<{
  PublishControls: (p: { slug: string; onOpenSettings?: () => void }) => unknown;
  truncateMiddle: (s: string, max?: number) => string;
  linkText: (url: string) => string;
}>('viewer/PublishControls.tsx');
const { EditionProvider } = await loadRenderer<{ EditionProvider: (p: { children: unknown }) => unknown }>(
  'edition/FeatureGate.tsx',
);

const FILE_URL = 'file:///Users/someone/Documents/ELI5%20Learner/widget-pricing/index.html';

const local = (over: Partial<PublishTarget> = {}): PublishTarget => ({
  id: 'local',
  kind: 'local',
  label: 'Export copy',
  available: true,
  destinationPreview: '~/Documents/ELI5 Learner/widget-pricing/',
  requiresSignIn: false,
  ...over,
});
const stub = (id: 'drive' | 'git', available = false): PublishTarget => ({
  id,
  kind: id,
  label: id === 'git' ? 'Push to Pages' : 'Share to cloud drive',
  available,
  requiresSignIn: id === 'drive',
});
const result = (over: Partial<PublishResult> = {}): PublishResult => ({
  targetId: 'local',
  kind: 'local',
  slug: 'widget-pricing',
  publishedAt: '2026-02-01T00:00:00.000Z',
  files: ['index.html'],
  links: [{ kind: 'file', url: FILE_URL, label: 'Open copy', primary: true }],
  warnings: [],
  ...over,
});

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
  fake.api.publish.targets = vi.fn(async () => ok([local(), stub('drive'), stub('git')]));
  fake.api.publish.copyLink = vi.fn(async () => ok(undefined));
  fake.api.publish.openLink = vi.fn(async () => ok(undefined));
  fake.api.publish.reveal = vi.fn(async () => ok(undefined));
  fake.api.publish.cancel = vi.fn(async () => ok(undefined));
});

let setSlug: (s: string) => void = () => {};

function mount(edition?: EditionInfo, extra: { onOpenSettings?: () => void } = {}) {
  if (edition) {
    const targets = fake.api.publish.targets;
    fake = installFakeApi(edition);
    fake.api.publish.targets = targets;
  }
  return render(function Harness() {
    const [slug, set] = useState('widget-pricing');
    setSlug = set;
    return createElement(EditionProvider as never, null, createElement(PublishControls as never, { slug, ...extra }));
  });
}

async function switchTo(slug: string) {
  await act(async () => setSlug(slug));
  await flush();
}

/** A run() whose result the test releases. */
function pendingRun() {
  let finish: (r: IpcResult<PublishResult>) => void = () => {};
  fake.api.publish.run = vi.fn(
    () => new Promise<IpcResult<PublishResult>>((r) => (finish = r)),
  ) as unknown as typeof fake.api.publish.run;
  return (r: IpcResult<PublishResult>) => finish(r);
}

describe('helpers', () => {
  it('truncateMiddle keeps both ends', () => {
    expect(truncateMiddle('short', 10)).toBe('short');
    const t = truncateMiddle('abcdefghijklmnopqrstuvwxyz', 11);
    expect(t).toHaveLength(11);
    expect(t).toBe('abcde…vwxyz');
  });

  it('linkText shows a decoded path for file: links and the URL otherwise', () => {
    expect(linkText(FILE_URL)).toBe('/Users/someone/Documents/ELI5 Learner/widget-pricing/index.html');
    expect(linkText('https://pages.example.com/a/')).toBe('https://pages.example.com/a/');
  });
});

describe('PublishControls (10 §7)', () => {
  it('public build: only Export copy is rendered; stubs and ungated targets are absent', async () => {
    fake.api.publish.targets = vi.fn(async () => ok([local(), stub('drive'), stub('git', true)]));
    const host = await mount();
    expect(fake.api.publish.targets).toHaveBeenCalledWith('widget-pricing');
    const labels = Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Export copy']);
    expect(host.textContent).not.toMatch(/Pages|cloud drive/);
  });

  it('an enterprise target mounts only when its UiFeature is enabled (HOOK-UI-01)', async () => {
    fake.api.publish.targets = vi.fn(async () => ok([local(), stub('drive', true), stub('git', true)]));
    const host = await mount({ ...PUBLIC_EDITION, edition: 'enterprise', uiFeatures: ['publish.git'] });
    expect(button(host, 'Push to Pages')).toBeDefined();
    expect(button(host, 'Share to cloud drive')).toBeUndefined();
  });

  it('Export copy runs local without a picker, shows progress and Cancel, then the result chip', async () => {
    const finish = pendingRun();
    const host = await mount();
    await click(button(host, 'Export copy'));
    expect(fake.api.publish.run).toHaveBeenCalledWith('widget-pricing', 'local');
    expect(button(host, 'Export copy')?.disabled).toBe(true);
    fake.emit('publish', {
      slug: 'widget-pricing',
      targetId: 'local',
      stage: 'preparing',
    } satisfies PublishProgressEvent);
    expect(host.textContent).toContain('Preparing…');
    // Another document's progress is ignored.
    fake.emit('publish', { slug: 'other-doc', targetId: 'local', stage: 'scanning' } satisfies PublishProgressEvent);
    expect(host.textContent).not.toContain('Checking for secrets');
    await click(button(host, 'Cancel'));
    expect(fake.api.publish.cancel).toHaveBeenCalledWith('widget-pricing', 'local');

    finish(ok(result()));
    await click(host); // flush
    const chip = host.querySelector('.result-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('Export copy');
    expect(chip?.querySelector('.chip-link')?.getAttribute('title')).toBe(FILE_URL);
    expect(chip?.querySelector('.chip-link')?.textContent).toContain('…');
    expect(button(host, 'Cancel')).toBeUndefined();
    // Targets are refreshed so "Last published" survives.
    expect(fake.api.publish.targets).toHaveBeenCalledTimes(2);
  });

  it('chip actions: Copy link (then "Copied"), Open, Show in Finder', async () => {
    const finish = pendingRun();
    const host = await mount();
    await click(button(host, 'Export copy'));
    finish(ok(result()));
    await click(host);
    await click(button(host, 'Copy link'));
    expect(fake.api.publish.copyLink).toHaveBeenCalledWith(FILE_URL);
    expect(host.querySelector('.result-chip')?.textContent).toContain('Copied');
    await click(button(host, 'Open'));
    expect(fake.api.publish.openLink).toHaveBeenCalledWith(FILE_URL);
    await click(button(host, 'Show in Finder'));
    expect(fake.api.publish.reveal).toHaveBeenCalledWith(FILE_URL);
  });

  it('an https primary link has no Show in Finder; warnings are listed', async () => {
    fake.api.publish.targets = vi.fn(async () => ok([local(), stub('git', true)]));
    const host = await mount({ ...PUBLIC_EDITION, edition: 'enterprise', uiFeatures: ['publish.git'] });
    const finish = pendingRun();
    await click(button(host, 'Push to Pages'));
    finish(
      ok(
        result({
          targetId: 'git',
          kind: 'git',
          links: [
            { kind: 'site', url: 'https://pages.example.com/widget-pricing/', label: 'Pages URL', primary: true },
          ],
          warnings: ['Site is still deploying; the link will work shortly'],
        }),
      ),
    );
    await click(host);
    expect(button(host, 'Show in Finder')).toBeUndefined();
    expect(button(host, 'Open')).toBeDefined();
    expect(host.textContent).toContain('Site is still deploying');
  });

  it('a failure shows its message inline; a secret-scan block lists masked findings', async () => {
    const finish = pendingRun();
    const host = await mount();
    await click(button(host, 'Export copy'));
    finish({
      ok: false,
      error: {
        code: 'E_PUBLISH_FAILED',
        message: 'This document contains something that looks like a secret.',
        detailCode: 'E_PUBLISH_SECRET_FOUND',
        findings: [{ relPath: 'index.html', line: 12, rule: 'code-host-token', preview: 'ghp_****' }],
      },
    });
    await click(host);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('looks like a secret');
    const items = Array.from(host.querySelectorAll('.publish-findings li')).map((li) => li.textContent);
    expect(items).toEqual(['index.html line 12: code-host-token ghp_****']);
    expect(host.querySelector('.result-chip')).toBeNull();
  });

  it('a sign-in failure offers Sign in only when auth.signIn is enabled', async () => {
    fake.api.publish.targets = vi.fn(async () => ok([local(), stub('drive', true)]));
    const host = await mount({
      ...PUBLIC_EDITION,
      edition: 'enterprise',
      uiFeatures: ['publish.drive', 'auth.signIn'],
    });
    const finish = pendingRun();
    await click(button(host, 'Share to cloud drive'));
    finish({
      ok: false,
      error: { code: 'E_PUBLISH_FAILED', message: 'Sign in to publish', detailCode: 'E_PUBLISH_SIGN_IN_REQUIRED' },
    });
    await click(host);
    await click(button(host, 'Sign in'));
    expect(fake.api.auth.signIn).toHaveBeenCalled();
  });

  it('shows "Last published" with its actions and "Changed since last publish"', async () => {
    fake.api.publish.targets = vi.fn(async () =>
      ok([
        local({
          lastPublished: {
            targetId: 'local',
            kind: 'local',
            publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            primaryUrl: FILE_URL,
            contentSha256: 'a'.repeat(64),
          },
          changedSincePublish: true,
        }),
      ]),
    );
    const host = await mount();
    const row = host.querySelector('.last-published');
    expect(row?.textContent).toContain('Last published 3d ago');
    expect(row?.textContent).toContain('Changed since last publish');
    await click(button(row as HTMLElement, 'Copy link'));
    expect(fake.api.publish.copyLink).toHaveBeenCalledWith(FILE_URL);
    await click(button(row as HTMLElement, 'Show in Finder'));
    expect(fake.api.publish.reveal).toHaveBeenCalledWith(FILE_URL);
  });

  it('refreshes targets when the Library changes (regenerated sections)', async () => {
    await mount();
    expect(fake.api.publish.targets).toHaveBeenCalledTimes(1);
    fake.emit('library', { entries: [] });
    await click(document.body);
    expect(fake.api.publish.targets).toHaveBeenCalledTimes(2);
  });

  it('a failed link action shows its message', async () => {
    fake.api.publish.targets = vi.fn(async () =>
      ok([
        local({
          lastPublished: {
            targetId: 'local',
            kind: 'local',
            publishedAt: new Date().toISOString(),
            primaryUrl: FILE_URL,
            contentSha256: 'a'.repeat(64),
          },
        }),
      ]),
    );
    fake.api.publish.openLink = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'E_NOT_FOUND' as const, message: 'The exported copy is no longer there' },
    }));
    const host = await mount();
    await click(button(host, 'Open'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('no longer there');
  });
  it('a feature-enabled target that is not configured shows disabled with its reason and Open settings', async () => {
    fake.api.publish.targets = vi.fn(async () =>
      ok([local(), { ...stub('git', false), unavailableReason: 'Not configured' }, stub('drive', false)]),
    );
    const onOpenSettings = vi.fn();
    const host = await mount(
      { ...PUBLIC_EDITION, edition: 'enterprise', uiFeatures: ['publish.git'] },
      { onOpenSettings },
    );
    expect(button(host, 'Push to Pages')?.disabled).toBe(true);
    expect(host.textContent).toContain('Not configured');
    // drive's feature is off: still absent.
    expect(button(host, 'Share to cloud drive')).toBeUndefined();
    await click(button(host, 'Open settings'));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(button(host, 'Export copy')?.disabled).toBe(false);
  });

  it('without an Open settings handler the reason still shows, with no dead button', async () => {
    fake.api.publish.targets = vi.fn(async () =>
      ok([local({ available: false, unavailableReason: 'Folder missing' })]),
    );
    const host = await mount();
    expect(button(host, 'Export copy')?.disabled).toBe(true);
    expect(host.textContent).toContain('Folder missing');
    expect(button(host, 'Open settings')).toBeUndefined();
  });

  it('switching away from a running publish and back restores its progress and Cancel', async () => {
    const finish = pendingRun();
    const host = await mount();
    await click(button(host, 'Export copy'));
    fake.emit('publish', {
      slug: 'widget-pricing',
      targetId: 'local',
      stage: 'preparing',
    } satisfies PublishProgressEvent);
    await switchTo('other-doc');
    expect(button(host, 'Export copy')?.disabled).toBe(false);
    expect(button(host, 'Cancel')).toBeUndefined();
    await switchTo('widget-pricing');
    expect(button(host, 'Export copy')?.disabled).toBe(true);
    expect(host.textContent).toContain('Preparing…');
    await click(button(host, 'Cancel'));
    expect(fake.api.publish.cancel).toHaveBeenCalledWith('widget-pricing', 'local');
    // The finished publish, reported by its 'done' event, clears progress and shows the chip.
    fake.emit('publish', {
      slug: 'widget-pricing',
      targetId: 'local',
      stage: 'done',
      result: result(),
    } satisfies PublishProgressEvent);
    finish(ok(result()));
    await flush();
    expect(button(host, 'Cancel')).toBeUndefined();
    expect(button(host, 'Export copy')?.disabled).toBe(false);
    expect(host.querySelector('.result-chip')?.textContent).toContain('Export copy');
  });

  it('a publish that is progressing while another document is shown is picked up on return', async () => {
    const finish = pendingRun();
    const host = await mount();
    await click(button(host, 'Export copy'));
    await switchTo('other-doc');
    fake.emit('publish', {
      slug: 'widget-pricing',
      targetId: 'local',
      stage: 'preparing',
    } satisfies PublishProgressEvent);
    expect(host.textContent).not.toContain('Preparing…');
    await switchTo('widget-pricing');
    expect(host.textContent).toContain('Preparing…');
    fake.emit('publish', {
      slug: 'widget-pricing',
      targetId: 'local',
      stage: 'failed',
      error: { code: 'E_PUBLISH_FAILED', message: 'Folder is not available.' },
    } satisfies PublishProgressEvent);
    finish({ ok: false, error: { code: 'E_PUBLISH_FAILED', message: 'Folder is not available.' } });
    await flush();
    expect(button(host, 'Cancel')).toBeUndefined();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Folder is not available.');
  });
});
