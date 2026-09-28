import { describe, expect, it, vi } from 'vitest';
import type { PublishService, PublishServiceProgress as ServiceProgress } from '../../../../src/main/ipc';
import type { PublishResult } from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { PublishError } = await import('../../../../src/main/publish');
const { NotAvailableInEdition } = await import('../../../../src/main/editions');
const { setup } = await import('./harness');

/** `eli5:publish:*` (10 §6, §7). */

const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };
const result: PublishResult = {
  targetId: 'local',
  kind: 'local',
  slug: 'solar-power',
  publishedAt: '2026-01-02T03:04:05.000Z',
  files: ['index.html'],
  links: [
    {
      kind: 'file',
      url: 'file:///Users/me/Documents/ELI5%20Learner/solar-power/index.html',
      label: 'Open',
      primary: true,
    },
  ],
  warnings: [],
};

function fakePublish() {
  const progress = new Set<(e: ServiceProgress) => void>();
  const svc = {
    targets: vi.fn(async () => []),
    run: vi.fn(async () => result),
    history: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    copyLink: vi.fn(async () => {}),
    openLink: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
    onProgress: (cb: (e: ServiceProgress) => void) => (progress.add(cb), () => progress.delete(cb)),
  } satisfies PublishService;
  return { svc, progress };
}

describe('eli5:publish:* (10 §6)', () => {
  it('targets, run, history and cancel delegate with validated slugs and target ids', async () => {
    const { svc } = fakePublish();
    const h = await setup({ services: { publish: svc } });
    expect(await h.call(IPC.publish.targets, { slug: 'solar-power' })).toEqual({ ok: true, value: [] });
    expect(svc.targets).toHaveBeenCalledWith('solar-power');
    expect(await h.call(IPC.publish.run, { slug: 'solar-power', targetId: 'local' })).toEqual({
      ok: true,
      value: result,
    });
    expect(svc.run).toHaveBeenCalledWith('solar-power', 'local');
    expect(await h.call(IPC.publish.history, { slug: 'solar-power' })).toEqual({ ok: true, value: [] });
    expect(await h.call(IPC.publish.cancel, { slug: 'solar-power', targetId: 'local' })).toMatchObject({ ok: true });
    expect(svc.cancel).toHaveBeenCalledWith('solar-power', 'local');
    for (const [ch, bad] of [
      [IPC.publish.targets, { slug: '../x' }],
      [IPC.publish.run, { slug: 'solar-power' }],
      [IPC.publish.run, { slug: 'solar-power', targetId: 'Local Dir' }],
      [IPC.publish.cancel, { slug: 'solar-power', targetId: 'x'.repeat(65) }],
    ] as const) {
      expect(await h.call(ch, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(await h.call(IPC.publish.run, { slug: 'solar-power', targetId: 'local' }, 'viewer')).toEqual(forbidden);
  });

  it('maps PublishError to E_PUBLISH_FAILED with the publish code and masked findings, never the detail', async () => {
    const { svc } = fakePublish();
    const findings = [{ relPath: 'index.html', line: 3, rule: 'generic-high-entropy', preview: 'abcd****' }];
    svc.run.mockRejectedValueOnce(
      new PublishError('E_PUBLISH_SECRET_FOUND', 'Found something that looks like a secret', { raw: 'x' }, findings),
    );
    svc.run.mockRejectedValueOnce(new PublishError('E_PUBLISH_DESTINATION', 'Cannot write to the folder'));
    svc.run.mockRejectedValueOnce(new NotAvailableInEdition('publisher:drive', 'HOOK-PUB-01', 'public'));
    const h = await setup({ services: { publish: svc } });
    const p = { slug: 'solar-power', targetId: 'local' };
    expect(await h.call(IPC.publish.run, p)).toEqual({
      ok: false,
      error: {
        code: 'E_PUBLISH_FAILED',
        message: 'Found something that looks like a secret',
        detailCode: 'E_PUBLISH_SECRET_FOUND',
        findings,
      },
    });
    expect(await h.call(IPC.publish.run, p)).toEqual({
      ok: false,
      error: { code: 'E_PUBLISH_FAILED', message: 'Cannot write to the folder', detailCode: 'E_PUBLISH_DESTINATION' },
    });
    expect(await h.call(IPC.publish.run, p)).toMatchObject({
      ok: false,
      error: { code: 'E_NOT_AVAILABLE_IN_EDITION', hookId: 'HOOK-PUB-01' },
    });
  });

  it('link actions: open allows https and file; reveal allows file only; others are E_FORBIDDEN (10 §7)', async () => {
    const { svc } = fakePublish();
    const h = await setup({ services: { publish: svc } });
    const file = 'file:///Users/me/Documents/ELI5%20Learner/solar-power/index.html';
    const https = 'https://example.com/solar-power/';
    expect(await h.call(IPC.publish.openLink, { url: https })).toMatchObject({ ok: true });
    expect(await h.call(IPC.publish.openLink, { url: file })).toMatchObject({ ok: true });
    expect(await h.call(IPC.publish.reveal, { url: file })).toMatchObject({ ok: true });
    expect(await h.call(IPC.publish.copyLink, { url: https })).toMatchObject({ ok: true });
    expect(await h.call(IPC.publish.copyLink, { url: file })).toMatchObject({ ok: true });
    expect(svc.openLink.mock.calls).toEqual([[https], [file]]);
    expect(svc.reveal).toHaveBeenCalledWith(file);
    for (const [ch, url] of [
      [IPC.publish.openLink, 'http://example.com/'],
      [IPC.publish.openLink, 'javascript:alert(1)'],
      [IPC.publish.openLink, 'smb://server/share'],
      [IPC.publish.reveal, https],
      [IPC.publish.copyLink, 'javascript:alert(1)'],
    ] as const) {
      expect(await h.call(ch, { url })).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } });
    }
    for (const bad of [{ url: 'not a url' }, { url: `https://e.com/${'x'.repeat(5000)}` }, {}]) {
      expect(await h.call(IPC.publish.openLink, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(svc.openLink).toHaveBeenCalledTimes(2);
  });

  it('forwards progress to the app, mapping a failure through the IPC error mapping', async () => {
    const { svc, progress } = fakePublish();
    const h = await setup({ services: { publish: svc } });
    progress.forEach((cb) => cb({ slug: 'solar-power', targetId: 'local', stage: 'scanning' }));
    progress.forEach((cb) => cb({ slug: 'solar-power', targetId: 'local', stage: 'done', result }));
    progress.forEach((cb) =>
      cb({
        slug: 'solar-power',
        targetId: 'local',
        stage: 'failed',
        error: new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled', { secret: 'detail' }),
      }),
    );
    progress.forEach((cb) =>
      cb({ slug: 'solar-power', targetId: 'local', stage: 'failed', error: new Error('boom /Users/me/x') }),
    );
    expect(h.sent).toEqual([
      { channel: IPC.publish.progress, payload: { slug: 'solar-power', targetId: 'local', stage: 'scanning' } },
      { channel: IPC.publish.progress, payload: { slug: 'solar-power', targetId: 'local', stage: 'done', result } },
      {
        channel: IPC.publish.progress,
        payload: {
          slug: 'solar-power',
          targetId: 'local',
          stage: 'failed',
          error: { code: 'E_PUBLISH_FAILED', message: 'Publish cancelled', detailCode: 'E_PUBLISH_CANCELLED' },
        },
      },
      {
        channel: IPC.publish.progress,
        payload: {
          slug: 'solar-power',
          targetId: 'local',
          stage: 'failed',
          error: { code: 'E_INTERNAL', message: 'Something went wrong' },
        },
      },
    ]);
    h.dispose();
    expect(progress.size).toBe(0);
  });

  it('answers "Not implemented yet" until a PublishService is plugged in', async () => {
    const h = await setup();
    expect(await h.call(IPC.publish.targets, { slug: 'solar-power' })).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});
