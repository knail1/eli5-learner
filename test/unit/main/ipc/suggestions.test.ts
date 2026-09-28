import { describe, expect, it, vi } from 'vitest';
import type { MergeSuggestions } from '../../../../src/main/ipc';
import type { DocUpdatedEvent as DocEvent, MergeSuggestion } from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { LibraryError } = await import('../../../../src/main/library');
const { setup } = await import('./harness');

/** `eli5:suggestions:*` (09 §11). */

const ID = '0f8b6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };

function suggestion(): MergeSuggestion {
  return {
    id: ID,
    createdAt: '2026-01-02T03:04:05.000Z',
    status: 'pending',
    source: { id: 'id-new', slug: 'tax-basics', title: 'Tax basics' },
    target: { id: 'id-old', slug: 'solar-power', title: 'Solar power' },
    score: 0.9,
    reason: 'Same topic',
    scorer: 'lexical+llm',
  };
}

function fakeSuggestions() {
  const changed = new Set<(l: MergeSuggestion[]) => void>();
  const docs = new Set<(e: DocEvent) => void>();
  const svc = {
    list: vi.fn(async () => [suggestion()]),
    accept: vi.fn(async () => ({ targetSlug: 'solar-power' })),
    dismiss: vi.fn(async () => {}),
    onChanged: (cb: (l: MergeSuggestion[]) => void) => (changed.add(cb), () => changed.delete(cb)),
    onDocUpdated: (cb: (e: DocEvent) => void) => (docs.add(cb), () => docs.delete(cb)),
  } satisfies MergeSuggestions;
  return { svc, changed, docs };
}

describe('eli5:suggestions:* (09 §11)', () => {
  it('lists, accepts and dismisses through the MergeSuggestions service', async () => {
    const { svc } = fakeSuggestions();
    const h = await setup({ services: { suggestions: svc } });
    expect(await h.call(IPC.suggestions.list)).toEqual({ ok: true, value: [suggestion()] });
    expect(await h.call(IPC.suggestions.accept, { suggestionId: ID })).toEqual({
      ok: true,
      value: { targetSlug: 'solar-power' },
    });
    expect(svc.accept).toHaveBeenCalledWith(ID);
    expect(await h.call(IPC.suggestions.dismiss, { suggestionId: ID })).toEqual({ ok: true, value: undefined });
    expect(svc.dismiss).toHaveBeenCalledWith(ID);
  });

  it('rejects ids that are not UUIDs, and the viewer', async () => {
    const { svc } = fakeSuggestions();
    const h = await setup({ services: { suggestions: svc } });
    for (const bad of [undefined, {}, { suggestionId: '../x' }, { suggestionId: 'abc' }]) {
      expect(await h.call(IPC.suggestions.accept, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(await h.call(IPC.suggestions.dismiss, { suggestionId: ID }, 'viewer')).toEqual(forbidden);
    expect(svc.accept).not.toHaveBeenCalled();
    expect(svc.dismiss).not.toHaveBeenCalled();
  });

  it('maps LibraryError codes (01 §5.1)', async () => {
    const { svc } = fakeSuggestions();
    const h = await setup({ services: { suggestions: svc } });
    for (const [lib, code] of [
      ['SUGGESTION_STALE', 'E_SUGGESTION_STALE'],
      ['MERGE_FAILED', 'E_MERGE_FAILED'],
      ['LIBRARY_READ_ONLY', 'E_LIBRARY_READ_ONLY'],
    ] as const) {
      svc.accept.mockRejectedValueOnce(new LibraryError(lib));
      expect(await h.call(IPC.suggestions.accept, { suggestionId: ID })).toMatchObject({ ok: false, error: { code } });
    }
  });

  it('pushes suggestions:changed and doc:updated to the app; dispose unsubscribes', async () => {
    const { svc, changed, docs } = fakeSuggestions();
    const h = await setup({ services: { suggestions: svc } });
    changed.forEach((cb) => cb([suggestion()]));
    docs.forEach((cb) => cb({ slug: 'solar-power' }));
    expect(h.sent).toEqual([
      { channel: IPC.suggestions.changed, payload: { suggestions: [suggestion()] } },
      { channel: IPC.doc.updated, payload: { slug: 'solar-power' } },
    ]);
    h.dispose();
    expect(changed.size + docs.size).toBe(0);
  });

  it('answers "Not implemented yet" until a service is plugged in', async () => {
    const h = await setup();
    expect(await h.call(IPC.suggestions.list)).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});
