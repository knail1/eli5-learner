import { describe, expect, it, vi } from 'vitest';
import type { FindResultEvent } from '../../../../src/preload/contract';
import { createFindInDocument, tabOfUrl, type FindViewer } from '../../../../src/main/shell/find';

/** Find in document (11 §5.3 find bar): findInPage on the viewer, results and resets to the app. */

type Listener = (...args: unknown[]) => void;

function fakeViewer(url = 'eli5doc://doc/widget-plan/index.html') {
  const listeners = new Map<string, Listener[]>();
  let nextId = 0;
  const v = {
    url,
    findInPage: vi.fn(
      (_text: string, _opts: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => ++nextId,
    ),
    stopFindInPage: vi.fn((_action: 'clearSelection' | 'keepSelection' | 'activateSelection') => {}),
    getURL: () => v.url,
    isDestroyed: () => false,
    on: (event: string, fn: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return v;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    found: (requestId: number, activeMatchOrdinal: number, matches: number, finalUpdate = true) =>
      v.emit('found-in-page', {}, { requestId, activeMatchOrdinal, matches, finalUpdate, selectionArea: {} }),
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
  };
  return v;
}

function setup(url?: string) {
  const viewer = fakeViewer(url);
  const sent: FindResultEvent[] = [];
  const find = createFindInDocument({ viewer: () => viewer as unknown as FindViewer, send: (e) => sent.push(e) });
  find.attach();
  return { viewer, sent, find };
}

describe('tabOfUrl', () => {
  it('reads the tab from the #tab= hash; no hash is the default tab; other fragments are unknown', () => {
    expect(tabOfUrl('eli5doc://doc/a/index.html')).toBe('');
    expect(tabOfUrl('eli5doc://doc/a/index.html#tab=eli5')).toBe('eli5');
    expect(tabOfUrl('eli5doc://doc/a/index.html#sec-intro-0123abcd')).toBeUndefined();
    expect(tabOfUrl('not a url')).toBeUndefined();
  });
});

describe('createFindInDocument', () => {
  it('starts a new case-insensitive search, then continues it forward or backward', () => {
    const { viewer, find } = setup();
    find.find({ text: 'widget' });
    expect(viewer.findInPage).toHaveBeenLastCalledWith('widget', { forward: true, findNext: true, matchCase: false });
    find.find({ text: 'widget', again: true });
    expect(viewer.findInPage).toHaveBeenLastCalledWith('widget', { forward: true, findNext: false, matchCase: false });
    find.find({ text: 'widget', again: true, forward: false });
    expect(viewer.findInPage).toHaveBeenLastCalledWith('widget', { forward: false, findNext: false, matchCase: false });
  });

  it('forwards found-in-page results of the latest request only', () => {
    const { viewer, sent, find } = setup();
    find.find({ text: 'wid' });
    find.find({ text: 'widget' });
    viewer.found(1, 1, 30);
    viewer.found(2, 1, 12, false);
    viewer.found(2, 3, 12);
    expect(sent).toEqual([
      { kind: 'result', activeMatchOrdinal: 1, matches: 12, finalUpdate: false },
      { kind: 'result', activeMatchOrdinal: 3, matches: 12, finalUpdate: true },
    ]);
  });

  it('stop clears the highlight and drops late results', () => {
    const { viewer, sent, find } = setup();
    find.find({ text: 'widget' });
    find.stop();
    expect(viewer.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    viewer.found(1, 1, 12);
    expect(sent).toEqual([]);
  });

  it('a reload during a search sends a reset; results from before it are dropped', () => {
    const { viewer, sent, find } = setup();
    find.find({ text: 'widget' });
    viewer.emit('did-finish-load');
    viewer.found(1, 1, 12);
    expect(sent).toEqual([{ kind: 'reset', reason: 'reload' }]);
  });

  it('a tab change in the document sends a reset; section fragments and the same tab do not', () => {
    const { viewer, sent, find } = setup();
    find.find({ text: 'widget' });
    const base = 'eli5doc://doc/widget-plan/index.html';
    viewer.emit('did-navigate-in-page', {}, `${base}#sec-intro-0123abcd`, true);
    viewer.emit('did-navigate-in-page', {}, base, true);
    expect(sent).toEqual([]);
    viewer.emit('did-navigate-in-page', {}, `${base}#tab=eli5`, false);
    expect(sent).toEqual([]);
    viewer.emit('did-navigate-in-page', {}, `${base}#tab=eli5`, true);
    expect(sent).toEqual([{ kind: 'reset', reason: 'tab' }]);
    viewer.emit('did-navigate-in-page', {}, `${base}#tab=eli5`, true);
    viewer.emit('did-navigate-in-page', {}, base, true);
    expect(sent).toEqual([
      { kind: 'reset', reason: 'tab' },
      { kind: 'reset', reason: 'tab' },
    ]);
  });

  it('sends nothing when no search is active', () => {
    const { viewer, sent } = setup();
    viewer.emit('did-finish-load');
    viewer.emit('did-navigate-in-page', {}, 'eli5doc://doc/widget-plan/index.html#tab=eli5', true);
    expect(sent).toEqual([]);
  });

  it('attaches its listeners once per viewer', () => {
    const { viewer, find } = setup();
    find.attach();
    find.find({ text: 'x' });
    expect(viewer.listenerCount('found-in-page')).toBe(1);
  });

  it('does nothing without a viewer', () => {
    const sent: FindResultEvent[] = [];
    const find = createFindInDocument({ viewer: () => undefined, send: (e) => sent.push(e) });
    expect(() => {
      find.attach();
      find.find({ text: 'x' });
      find.stop();
    }).not.toThrow();
    expect(sent).toEqual([]);
  });
});
