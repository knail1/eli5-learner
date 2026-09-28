import { describe, expect, it, vi } from 'vitest';
import type { DocHistory, SectionActions } from '../../../../src/main/ipc';
import type {
  DocHistoryChangedEvent,
  DocUpdatedEvent as DocEvent,
  ScrollToEvent as ScrollTo,
  SectionBusyEvent as Busy,
} from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { PipelineRequestError } = await import('../../../../src/main/pipeline');
const { LibraryError } = await import('../../../../src/main/library');
const { SectionActionError } = await import('../../../../src/main/document');
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

  it('maps SectionActionError to its code and notice text (08 §9)', async () => {
    const { svc } = fakeActions();
    svc.regenerateSection.mockRejectedValueOnce(
      new SectionActionError('E_RATE_LIMITED', 'Too many requests; wait a moment'),
    );
    svc.closeTab.mockRejectedValueOnce(
      new SectionActionError('E_CONFLICT', 'Wait for the update in this tab to finish'),
    );
    const h = await setup({ services: { sectionActions: svc } });
    expect(await h.call(IPC.doc.regenerateSection, req(), 'viewer')).toEqual({
      ok: false,
      error: { code: 'E_RATE_LIMITED', message: 'Too many requests; wait a moment' },
    });
    expect(await h.call(IPC.doc.closeTab, { slug: 'solar-power', tabKey: 'sx0a1b2c' }, 'viewer')).toEqual({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'Wait for the update in this tab to finish' },
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
  it('passes any well-formed tab key to the service, which refuses non-section-ELI5 tabs', async () => {
    const { svc } = fakeActions();
    const h = await setup({ services: { sectionActions: svc } });
    expect(await h.call(IPC.doc.closeTab, { slug: 'solar-power', tabKey: 'sx0a1b2c' }, 'viewer')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(svc.closeTab).toHaveBeenCalledWith({ slug: 'solar-power', tabKey: 'sx0a1b2c' });
    // 08 §7.2: in-depth and ELI5 tabs reach the service, which answers E_FORBIDDEN.
    for (const tabKey of ['indepth', 'eli5']) {
      await h.call(IPC.doc.closeTab, { slug: 'solar-power', tabKey }, 'viewer');
      expect(svc.closeTab).toHaveBeenLastCalledWith({ slug: 'solar-power', tabKey });
    }
    for (const tabKey of ['sx0A1B2C', 'sx12', 'notes']) {
      expect(await h.call(IPC.doc.closeTab, { slug: 'solar-power', tabKey }, 'viewer')).toMatchObject({
        ok: false,
        error: { code: 'E_BAD_REQUEST' },
      });
    }
    expect(svc.closeTab).toHaveBeenCalledTimes(3);
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

describe('eli5:doc:history / undo / redo (09 §4.1, 01 §5.2)', () => {
  function fakeHistory() {
    const subs = new Set<(e: DocHistoryChangedEvent) => void>();
    const state = { canUndo: true, canRedo: false, undoLabel: "expanded 'Panels'", busy: false };
    const svc = {
      state: vi.fn(async (_slug: string) => state),
      undo: vi.fn(async (_slug: string) => ({
        canUndo: false,
        canRedo: true,
        redoLabel: "expanded 'Panels'",
        busy: false,
      })),
      redo: vi.fn(async (_slug: string) => state),
      onChanged: (cb: (e: DocHistoryChangedEvent) => void) => (subs.add(cb), () => subs.delete(cb)),
    } satisfies DocHistory;
    return { svc, subs, state };
  }

  it('answers the app window with the service result for a validated slug', async () => {
    const { svc, state } = fakeHistory();
    const h = await setup({ services: { docHistory: svc } });
    expect(await h.call(IPC.doc.history, { slug: 'solar-power' })).toEqual({ ok: true, value: state });
    expect(await h.call(IPC.doc.undo, { slug: 'solar-power' })).toMatchObject({ ok: true, value: { canRedo: true } });
    expect(await h.call(IPC.doc.redo, { slug: 'solar-power' })).toEqual({ ok: true, value: state });
    expect(svc.state).toHaveBeenCalledWith('solar-power');
    expect(svc.undo).toHaveBeenCalledWith('solar-power');
    expect(svc.redo).toHaveBeenCalledWith('solar-power');
  });

  it('is app-only: the viewer is refused with E_FORBIDDEN', async () => {
    const { svc } = fakeHistory();
    const h = await setup({ services: { docHistory: svc } });
    for (const ch of [IPC.doc.history, IPC.doc.undo, IPC.doc.redo]) {
      expect(await h.call(ch, { slug: 'solar-power' }, 'viewer')).toEqual(forbidden);
    }
    expect(svc.undo).not.toHaveBeenCalled();
  });

  it('rejects malformed slugs with E_BAD_REQUEST before the service', async () => {
    const { svc } = fakeHistory();
    const h = await setup({ services: { docHistory: svc } });
    for (const bad of [undefined, {}, { slug: '../x' }, { slug: 'Solar Power' }, { slug: '.prev' }, { slug: 1 }]) {
      expect(await h.call(IPC.doc.undo, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(svc.undo).not.toHaveBeenCalled();
  });

  it('passes the service refusals through (E_CONFLICT while busy, E_NOT_FOUND)', async () => {
    const { svc } = fakeHistory();
    svc.undo.mockRejectedValueOnce(new SectionActionError('E_CONFLICT', 'Wait for the section update to finish'));
    svc.redo.mockRejectedValueOnce(new LibraryError('NOT_FOUND'));
    svc.state.mockRejectedValueOnce(new LibraryError('HISTORY_EMPTY'));
    const h = await setup({ services: { docHistory: svc } });
    expect(await h.call(IPC.doc.undo, { slug: 'solar-power' })).toEqual({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'Wait for the section update to finish' },
    });
    expect(await h.call(IPC.doc.redo, { slug: 'solar-power' })).toMatchObject({
      ok: false,
      error: { code: 'E_NOT_FOUND' },
    });
    expect(await h.call(IPC.doc.history, { slug: 'solar-power' })).toMatchObject({
      ok: false,
      error: { code: 'E_CONFLICT' },
    });
  });

  it('pushes eli5:doc:history-changed to the app renderer only', async () => {
    const { svc, subs, state } = fakeHistory();
    const h = await setup({ services: { docHistory: svc } });
    subs.forEach((cb) => cb({ slug: 'solar-power', state }));
    expect(h.sent).toContainEqual({ channel: IPC.doc.historyChanged, payload: { slug: 'solar-power', state } });
    expect(h.viewerSent).toEqual([]);
    h.dispose();
    expect(subs.size).toBe(0);
  });

  it('answers "Not implemented yet" without a service', async () => {
    const h = await setup();
    expect(await h.call(IPC.doc.undo, { slug: 'solar-power' })).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});
