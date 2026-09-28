import { act, createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '../../../src/preload/contract';
import {
  button,
  click,
  flush,
  installFakeApi,
  key,
  loadRenderer,
  ok,
  render,
  type,
  type Component,
  type FakeApi,
} from './harness';

/** Find in document (11 §5.3 find bar, §9): the bar above the viewer slot and its shortcuts. */

interface FindBarHandle {
  focus(): void;
  next(): void;
  previous(): void;
}
const { FindBar } = await loadRenderer<{ FindBar: Component }>('viewer/FindBar.tsx');
const { App } = await loadRenderer<{ App: Component }>('App.tsx');

let fake: FakeApi;
const findMock = () => fake.api.viewer.find as unknown as { mock: { calls: unknown[][] }; mockClear(): void };
const stopMock = () => fake.api.viewer.stopFind as unknown as { mock: { calls: unknown[][] } };

/** Past the 150 ms search-as-you-type debounce. */
const debounce = () => act(async () => new Promise((r) => setTimeout(r, 200)));

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
  fake = installFakeApi();
});

async function mountBar(props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onQueryChange = vi.fn();
  const handle = createRef<FindBarHandle>();
  const host = await render(FindBar, { initialQuery: '', onClose, onQueryChange, handle, ...props });
  const input = host.querySelector<HTMLInputElement>('input');
  return { host, input, onClose, onQueryChange, handle };
}

const count = (host: HTMLElement) => host.querySelector('[role="status"]')?.textContent ?? '';

describe('FindBar', () => {
  it('is a labelled search region with a focused field, a live count, chevron buttons and Done', async () => {
    const { host, input } = await mountBar();
    expect(host.querySelector('[role="search"]')?.getAttribute('aria-label')).toBe('Find in document');
    expect(input?.getAttribute('aria-label')).toBe('Find in document');
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    for (const name of ['Previous match', 'Next match']) {
      expect(button(host, name)?.querySelector('svg[aria-hidden="true"]'), name).not.toBeNull();
    }
    expect(button(host, 'Done')).toBeDefined();
    expect(fake.api.viewer.find).not.toHaveBeenCalled();
  });

  it('searches as you type after a short debounce and shows "x of y" or "No matches"', async () => {
    const { host, input, onQueryChange } = await mountBar();
    await type(input, 'wid');
    await type(input, 'widget');
    expect(fake.api.viewer.find).not.toHaveBeenCalled();
    await debounce();
    expect(findMock().mock.calls).toEqual([['widget', { forward: true }]]);
    expect(onQueryChange).toHaveBeenLastCalledWith('widget');
    fake.emit('find-result', { kind: 'result', activeMatchOrdinal: 1, matches: 12, finalUpdate: false });
    fake.emit('find-result', { kind: 'result', activeMatchOrdinal: 3, matches: 12, finalUpdate: true });
    expect(count(host)).toBe('3 of 12');
    fake.emit('find-result', { kind: 'result', activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
    expect(count(host)).toBe('No matches');
  });

  it('Enter goes to the next match and Shift+Enter to the previous one', async () => {
    const { host, input } = await mountBar();
    await type(input, 'widget');
    await debounce();
    findMock().mockClear();
    await key(input, 'Enter');
    await key(input, 'Enter', { shiftKey: true });
    await click(button(host, 'Next match'));
    await click(button(host, 'Previous match'));
    expect(findMock().mock.calls).toEqual([
      ['widget', { forward: true, again: true }],
      ['widget', { forward: false, again: true }],
      ['widget', { forward: true, again: true }],
      ['widget', { forward: false, again: true }],
    ]);
  });

  it('Enter before the debounce fires starts the search at once', async () => {
    const { input } = await mountBar();
    await type(input, 'widget');
    await key(input, 'Enter');
    expect(findMock().mock.calls).toEqual([['widget', { forward: true }]]);
    await debounce();
    expect(findMock().mock.calls).toHaveLength(1);
  });

  it('clearing the field clears the highlight and the count', async () => {
    const { host, input } = await mountBar();
    await type(input, 'widget');
    await debounce();
    fake.emit('find-result', { kind: 'result', activeMatchOrdinal: 1, matches: 2, finalUpdate: true });
    await type(input, '');
    await debounce();
    expect(stopMock().mock.calls.length).toBeGreaterThan(0);
    expect(count(host)).toBe('');
  });

  it('Escape and Done close the bar', async () => {
    const { host, input, onClose } = await mountBar();
    await key(input, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(button(host, 'Done'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('reopens with the previous query selected and searches it again', async () => {
    const { input } = await mountBar({ initialQuery: 'widget' });
    expect(input?.value).toBe('widget');
    expect(document.activeElement).toBe(input);
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, 6]);
    expect(findMock().mock.calls).toEqual([['widget', { forward: true }]]);
  });

  it('a tab change re-runs the search; a reload clears the count and the next Enter starts over', async () => {
    const { host, input } = await mountBar({ initialQuery: 'widget' });
    fake.emit('find-result', { kind: 'result', activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    findMock().mockClear();
    fake.emit('find-result', { kind: 'reset', reason: 'tab' });
    expect(findMock().mock.calls).toEqual([['widget', { forward: true }]]);
    fake.emit('find-result', { kind: 'reset', reason: 'reload' });
    expect(count(host)).toBe('');
    findMock().mockClear();
    await key(input, 'Enter');
    expect(findMock().mock.calls).toEqual([['widget', { forward: true }]]);
  });

  it('the handle focuses the field and steps through matches (Cmd+G from anywhere)', async () => {
    const { input, handle } = await mountBar({ initialQuery: 'widget' });
    findMock().mockClear();
    input?.blur();
    act(() => handle.current?.focus());
    expect(document.activeElement).toBe(input);
    act(() => handle.current?.next());
    act(() => handle.current?.previous());
    expect(findMock().mock.calls).toEqual([
      ['widget', { forward: true, again: true }],
      ['widget', { forward: false, again: true }],
    ]);
  });
});

const entry = (title: string): CatalogEntry => ({
  id: `id-${title}`,
  title,
  topicSlug: title.toLowerCase().replace(/\W+/g, '-'),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  summary: '',
  summarySource: 'fallback',
  tabCount: 2,
  mergedFromCount: 0,
});

describe('find shortcuts in the app (11 §9)', () => {
  const findBar = (host: HTMLElement) => host.querySelector('[role="search"]');
  const filter = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input.filter');

  async function openDoc(): Promise<HTMLElement> {
    fake.api.library.list = async () => ok([entry('Topic A'), entry('Topic B')]);
    fake.api.library.open = vi.fn(async () => ok(undefined)) as typeof fake.api.library.open;
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    return host;
  }

  it('Cmd+F opens the find bar above the viewer slot; Escape closes it, clears the highlight and focuses the viewer', async () => {
    const host = await openDoc();
    await key(document.body, 'f', { metaKey: true });
    const bar = findBar(host);
    expect(bar).not.toBeNull();
    // Above the slot, so it takes layout space instead of sitting under the native view.
    expect(bar?.nextElementSibling?.getAttribute('data-testid')).toBe('viewer-slot');
    expect(document.activeElement).toBe(bar?.querySelector('input'));
    expect(document.activeElement).not.toBe(filter(host));
    await key(bar?.querySelector('input'), 'Escape');
    expect(findBar(host)).toBeNull();
    expect(fake.api.viewer.stopFind).toHaveBeenCalled();
    expect(fake.api.viewer.focus).toHaveBeenCalled();
  });

  it('Cmd+G steps through matches from the find field; the query survives closing', async () => {
    const host = await openDoc();
    await key(document.body, 'f', { metaKey: true });
    const input = findBar(host)?.querySelector('input');
    await type(input, 'widget');
    await debounce();
    findMock().mockClear();
    await key(input, 'g', { metaKey: true });
    await key(input, 'G', { metaKey: true, shiftKey: true });
    expect(findMock().mock.calls).toEqual([
      ['widget', { forward: true, again: true }],
      ['widget', { forward: false, again: true }],
    ]);
    await click(button(host, 'Done'));
    await key(document.body, 'f', { metaKey: true });
    expect(findBar(host)?.querySelector('input')?.value).toBe('widget');
  });

  it('Option+Cmd+F focuses the Library filter even with a document open', async () => {
    const host = await openDoc();
    await key(document.body, 'ƒ', { metaKey: true, altKey: true, code: 'KeyF' });
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(document.activeElement).toBe(filter(host));
    expect(findBar(host)).toBeNull();
  });

  it('Cmd+F falls back to the Library filter when no document is showing', async () => {
    fake.api.library.list = async () => ok([entry('Topic A')]);
    const host = await render(App);
    await key(document.body, 'f', { metaKey: true });
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(document.activeElement).toBe(filter(host));
    expect(findBar(host)).toBeNull();
  });

  it('follows the Edit > Find menu commands sent while the viewer has focus', async () => {
    const host = await openDoc();
    fake.emit('find-command', { command: 'find' });
    await flush();
    const input = findBar(host)?.querySelector('input');
    expect(document.activeElement).toBe(input);
    await type(input, 'widget');
    await debounce();
    findMock().mockClear();
    fake.emit('find-command', { command: 'find-next' });
    fake.emit('find-command', { command: 'find-previous' });
    expect(findMock().mock.calls).toEqual([
      ['widget', { forward: true, again: true }],
      ['widget', { forward: false, again: true }],
    ]);
    fake.emit('find-command', { command: 'find-in-library' });
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(document.activeElement).toBe(filter(host));
  });

  it('switching to another document closes the bar', async () => {
    const host = await openDoc();
    await key(document.body, 'f', { metaKey: true });
    expect(findBar(host)).not.toBeNull();
    await key(document.body, ']', { metaKey: true });
    expect(fake.api.library.open).toHaveBeenLastCalledWith('topic-b');
    expect(findBar(host)).toBeNull();
    expect(fake.api.viewer.stopFind).toHaveBeenCalled();
  });

  it('Cmd+Z in the find field stays text undo, not document undo', async () => {
    fake.api.doc.history = vi.fn(async () => ok({ canUndo: true, canRedo: false })) as typeof fake.api.doc.history;
    const host = await openDoc();
    await key(document.body, 'f', { metaKey: true });
    await key(findBar(host)?.querySelector('input'), 'z', { metaKey: true });
    expect(fake.api.doc.undo).not.toHaveBeenCalled();
  });
});
