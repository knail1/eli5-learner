import { describe, expect, it, vi } from 'vitest';
import type { SectionActions } from '../../../../src/main/ipc';
import type {
  DocUpdatedEvent as DocEvent,
  ScrollToEvent as ScrollTo,
  SectionBusyEvent as Busy,
} from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { PipelineRequestError } = await import('../../../../src/main/pipeline');
const { LibraryError } = await import('../../../../src/main/library');
const { setup } = await import('./harness');

/** `eli5:doc:*` (08 §3, 01 §5.2). The harness viewer shows eli5doc://doc/solar-power/index.html. */

const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };
const req = (over: Record<string, unknown> = {}) => ({
  slug: 'solar-power',
  tabKey: 'indepth',
  sectionId: 'sec-indepth-3f9a1c2e',
  action: 'expand',
  selectionText: 'Panels turn light into current.',
  ...over,
});

function fakeActions() {
  const subs = { updated: new Set<(e: DocEvent) => void>(), scroll: new Set<(e: ScrollTo) => void>() };
  const busy = new Set<(e: Busy) => void>();
  const svc = {
    regenerateSection: vi.fn(async () => ({ jobId: 'job-s1' })),
    createSectionEli5: vi.fn(async () => ({ jobId: 'job-s2' })),
    closeTab: vi.fn(async () => {}),
    onUpdated: (cb: (e: DocEvent) => void) => (subs.updated.add(cb), () => subs.updated.delete(cb)),
    onScrollTo: (cb: (e: ScrollTo) => void) => (subs.scroll.add(cb), () => subs.scroll.delete(cb)),
    onSectionBusy: (cb: (e: Busy) => void) => (busy.add(cb), () => busy.delete(cb)),
  } satisfies SectionActions;
  return { svc, subs, busy };
}

describe('eli5:doc:regenerate-section / create-section-eli5 (08 §3, §6.1)', () => {
  it('passes a validated request to SectionActions and returns the job id', async () => {
    const { svc } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    expect(await h.call(IPC.doc.regenerateSection, req({ note: 'shorter please' }), 'viewer')).toEqual({
      ok: true,
      value: { jobId: 'job-s1' },
    });
    expect(svc.regenerateSection).toHaveBeenCalledWith(req({ note: 'shorter please' }));
    expect(await h.call(IPC.doc.createSectionEli5, req({ action: undefined }), 'viewer')).toEqual({
      ok: true,
      value: { jobId: 'job-s2' },
    });
    const { action: _drop, ...eli5 } = req();
    expect(svc.createSectionEli5).toHaveBeenCalledWith(eli5);
  });

  it('accepts section ELI5 tab keys and sections inside them', async () => {
    const { svc } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    const r = await h.call(
      IPC.doc.regenerateSection,
      req({ tabKey: 'sx0a1b2c', sectionId: 'sec-sx0a1b2c-0000beef' }),
      'viewer',
    );
    expect(r).toMatchObject({ ok: true });
  });

  it('accepts only the viewer; the app renderer is refused (01 §5.1)', async () => {
    const { svc } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    expect(await h.call(IPC.doc.regenerateSection, req(), 'app')).toEqual(forbidden);
    expect(await h.call(IPC.doc.createSectionEli5, req(), 'app')).toEqual(forbidden);
    expect(await h.call(IPC.doc.closeTab, { slug: 'solar-power', tabKey: 'sx0a1b2c' }, 'app')).toEqual(forbidden);
    expect(svc.regenerateSection).not.toHaveBeenCalled();
  });

  it('refuses a slug other than the document loaded in the viewer (08 §4.3 step 1)', async () => {
    const { svc } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    expect(await h.call(IPC.doc.regenerateSection, req({ slug: 'tax-basics' }), 'viewer')).toEqual(forbidden);
    expect(await h.call(IPC.doc.closeTab, { slug: 'tax-basics', tabKey: 'sx0a1b2c' }, 'viewer')).toEqual(forbidden);
    expect(svc.regenerateSection).not.toHaveBeenCalled();
    expect(svc.closeTab).not.toHaveBeenCalled();
  });

  it('rejects malformed requests with E_BAD_REQUEST (08 §3)', async () => {
    const { svc } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    for (const bad of [
      undefined,
      req({ sectionId: 'sec-indepth-XYZ' }),
      req({ sectionId: 'sec-eli5-3f9a1c2e' }), // tab key segment must equal tabKey
      req({ tabKey: 'notes', sectionId: 'sec-notes-3f9a1c2e' }),
      req({ action: 'eli5-tab' }),
      req({ action: 'summarize' }),
      req({ selectionText: 'ab' }),
      req({ selectionText: '  a  ' }),
      req({ selectionText: 'x'.repeat(4001) }),
      req({ note: 'x'.repeat(201) }),
      req({ note: 'two\nlines' }),
      req({ slug: '../etc' }),
    ]) {
      expect(await h.call(IPC.doc.regenerateSection, bad, 'viewer')).toMatchObject({
        ok: false,
        error: { code: 'E_BAD_REQUEST' },
      });
    }
    expect(svc.regenerateSection).not.toHaveBeenCalled();
  });

  it('maps service errors at the boundary', async () => {
    const { svc } = fakeActions();
    svc.regenerateSection.mockRejectedValueOnce(new PipelineRequestError('E_CONFLICT', 'That section is busy'));
    svc.createSectionEli5.mockRejectedValueOnce(new LibraryError('NOT_FOUND'));
    const h = await setup({ services: { sectionActions: svc } });
    expect(await h.call(IPC.doc.regenerateSection, req(), 'viewer')).toEqual({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'That section is busy' },
    });
    expect(await h.call(IPC.doc.createSectionEli5, req(), 'viewer')).toMatchObject({
      ok: false,
      error: { code: 'E_NOT_FOUND' },
    });
  });

  it('answers "Not implemented yet" until a SectionActions service is plugged in', async () => {
    const h = await setup();
    expect(await h.call(IPC.doc.regenerateSection, req(), 'viewer')).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});

describe('eli5:doc:close-tab (08 §7.2)', () => {
  it('closes Section ELI5 tabs only', async () => {
    const { svc } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    expect(await h.call(IPC.doc.closeTab, { slug: 'solar-power', tabKey: 'sx0a1b2c' }, 'viewer')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(svc.closeTab).toHaveBeenCalledWith({ slug: 'solar-power', tabKey: 'sx0a1b2c' });
    for (const tabKey of ['indepth', 'eli5', 'sx0A1B2C', 'sx12']) {
      expect(await h.call(IPC.doc.closeTab, { slug: 'solar-power', tabKey }, 'viewer')).toMatchObject({
        ok: false,
        error: { code: 'E_BAD_REQUEST' },
      });
    }
    expect(svc.closeTab).toHaveBeenCalledTimes(1);
  });
});

describe('doc events (08 §4.1, §7.4)', () => {
  it('forwards updated to the app and scroll-to / section-busy to the viewer only', async () => {
    const { svc, subs, busy } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    const updated = { slug: 'solar-power', sectionId: 'sec-indepth-3f9a1c2e' } as DocEvent;
    const scroll = { sectionId: 'sec-indepth-3f9a1c2e', flash: true, loadSeq: 3 } as ScrollTo;
    const list = { busy: [{ sectionId: 'sec-indepth-3f9a1c2e', action: 'expand' }] } as Busy;
    subs.updated.forEach((cb) => cb(updated));
    subs.scroll.forEach((cb) => cb(scroll));
    busy.forEach((cb) => cb(list));
    expect(h.sent.filter((s) => s.channel.startsWith('eli5:doc:'))).toEqual([
      { channel: IPC.doc.updated, payload: updated },
    ]);
    expect(h.viewerSent).toEqual([
      { channel: IPC.doc.scrollTo, payload: scroll },
      { channel: IPC.doc.sectionBusy, payload: list },
    ]);
    h.dispose();
    expect(subs.updated.size + subs.scroll.size + busy.size).toBe(0);
  });
});
