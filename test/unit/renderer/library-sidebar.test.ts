import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry, LibraryMoveReceipt, LibraryOrganization, TrashItem } from '../../../src/preload/contract';
import {
  button,
  click,
  installFakeApi,
  key,
  loadRenderer,
  ok,
  render,
  type,
  type Component,
  type FakeApi,
} from './harness';

/** Library folders, Archive, Trash, swipe and Undo (11 §5.2, §9; 09 §4.2). */

const { LibrarySidebar, TOAST_MS } = await loadRenderer<{ LibrarySidebar: Component; TOAST_MS: number }>(
  'library/LibrarySidebar.tsx',
);
const { TrashView, InTrash } = await loadRenderer<{ TrashView: Component; InTrash: Component }>(
  'library/TrashView.tsx',
);
const { HistoryButtons } = await loadRenderer<{ HistoryButtons: Component }>('viewer/HistoryButtons.tsx');
const { AnnouncerProvider } = await loadRenderer<{ AnnouncerProvider: Component }>('a11y/Announcer.tsx');

const withAnnouncer = (...children: [Component, Record<string, unknown>][]) =>
  function Wrapped() {
    return createElement(
      AnnouncerProvider,
      null,
      ...children.map(([c, props], i) => createElement(c, { key: i, ...props })),
    );
  };

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
  window.localStorage.clear();
});

const doc = (title: string): CatalogEntry => ({
  id: `id-${title}`,
  title,
  topicSlug: title.toLowerCase().replace(/\s+/g, '-'),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  summary: '',
  summarySource: 'llm',
  tabCount: 2,
  mergedFromCount: 0,
});

const trashItem = (over: Partial<TrashItem> = {}): TrashItem => ({
  trashId: 'old-plan--20260101T000000',
  docId: 'id-Old plan',
  title: 'Old plan',
  topicSlug: 'old-plan',
  summary: '',
  trashedAt: '2026-01-01T00:00:00.000Z',
  reason: 'trashed',
  from: 'unfiled',
  ...over,
});

const ORG: LibraryOrganization = {
  folders: [{ id: 'f-0000000a', name: 'Budgets', createdAt: '2026-01-01T00:00:00.000Z' }],
  placement: { 'id-Widget pricing': 'f-0000000a', 'id-Stock levels': 'archive' },
  trash: [trashItem()],
  trashRetentionDays: 30,
};
const ENTRIES = [doc('Widget pricing'), doc('Office plants'), doc('Stock levels')];

function sidebarProps(over: Record<string, unknown> = {}) {
  return {
    entries: ENTRIES,
    organization: ORG,
    error: null,
    selectedSlug: null,
    onOpen: vi.fn(),
    onOpenTrash: vi.fn(),
    onRetry: vi.fn(),
    ...over,
  };
}

const renderSidebar = (over: Record<string, unknown> = {}) =>
  render(withAnnouncer([LibrarySidebar, sidebarProps(over)]));

const titles = (root: ParentNode) => Array.from(root.querySelectorAll('.item-title')).map((e) => e.textContent);
const rowButton = (host: HTMLElement, title: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.library-item')).find(
    (b) => b.querySelector('.item-title')?.textContent === title,
  );

describe('grouping (11 §5.2)', () => {
  it('shows unfiled documents, collapsed folders with counts, the Archive and the Trash count', async () => {
    const p = sidebarProps();
    const host = await render(withAnnouncer([LibrarySidebar, p]));
    expect(titles(host)).toEqual(['Office plants']);
    const toggle = button(host, 'Budgets1');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(titles(host)).toEqual(['Office plants', 'Widget pricing']);
    await click(button(host, 'Archive1'));
    expect(titles(host)).toEqual(['Office plants', 'Widget pricing', 'Stock levels']);
    // Folder open state is a per-viewer convenience.
    expect(JSON.parse(window.localStorage.getItem('eli5.libraryExpanded') ?? '[]')).toEqual(['f-0000000a', 'archive']);
    await click(host.querySelector('.trash-row'));
    expect(p.onOpenTrash).toHaveBeenCalledOnce();
    expect(host.querySelector('.trash-row')?.textContent).toBe('Trash1');
  });

  it('the filter finds documents inside closed folders and opens them', async () => {
    const host = await renderSidebar();
    await type(host.querySelector('input[type="search"]'), 'pricing');
    expect(titles(host)).toEqual(['Widget pricing']);
    expect(button(host, 'Budgets1')?.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('folders (11 §5.2)', () => {
  it('+ New folder asks for a name inline and creates it', async () => {
    fake.api.library.createFolder = vi.fn(async (name: string) =>
      ok({ id: 'f-0000000b' as const, name, createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    const host = await renderSidebar();
    await click(button(host, 'New folder'));
    const field = host.querySelector<HTMLInputElement>('input[aria-label="New folder name"]');
    expect(document.activeElement).toBe(field);
    await type(field, 'Supply');
    await key(field, 'Enter');
    expect(fake.api.library.createFolder).toHaveBeenCalledWith('Supply');
    expect(host.querySelector('input[aria-label="New folder name"]')).toBeNull();
  });

  it('shows a refused name inline and keeps the field', async () => {
    fake.api.library.createFolder = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'E_CONFLICT' as const, message: 'A folder with that name already exists' },
    }));
    const host = await renderSidebar();
    await click(button(host, 'New folder'));
    await type(host.querySelector('input[aria-label="New folder name"]'), 'Budgets');
    await key(host.querySelector('input[aria-label="New folder name"]'), 'Enter');
    expect(host.textContent).toContain('A folder with that name already exists');
    expect(host.querySelector('input[aria-label="New folder name"]')).not.toBeNull();
  });

  it('renames and deletes a folder; deleting says how many went to the Trash', async () => {
    fake.api.library.renameFolder = vi.fn(async (id: string, name: string) =>
      ok({ id: id as `f-${string}`, name, createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    fake.api.library.deleteFolder = vi.fn(async () => ok({ trashed: 1 }));
    const host = await renderSidebar();
    await click(button(host, 'Rename folder Budgets'));
    const field = host.querySelector('input[aria-label="Rename folder Budgets"]');
    await type(field, 'Costs');
    await key(field, 'Enter');
    expect(fake.api.library.renameFolder).toHaveBeenCalledWith('f-0000000a', 'Costs');
    await click(button(host, 'Delete folder Budgets'));
    expect(fake.api.library.deleteFolder).toHaveBeenCalledWith('f-0000000a');
    expect(host.querySelector('.toast')?.textContent).toBe('Deleted folder “Budgets” · 1 moved to Trash');
  });
});

describe('moving, the toast and Undo (11 §5.2)', () => {
  const receipt = (over: Partial<LibraryMoveReceipt> = {}): LibraryMoveReceipt => ({
    slug: 'office-plants',
    docId: 'id-Office plants',
    title: 'Office plants',
    from: 'unfiled',
    to: 'archive',
    ...over,
  });

  it('Cmd+Backspace on a row moves it to the Trash', async () => {
    fake.api.library.move = vi.fn(async (slug: string, to) => ok(receipt({ slug, to })));
    const host = await renderSidebar();
    await key(rowButton(host, 'Office plants'), 'Backspace', { metaKey: true });
    expect(fake.api.library.move).toHaveBeenCalledWith('office-plants', 'trash');
  });

  it('every move shows "Moved to … · Undo"; Undo moves it back or puts it back', async () => {
    fake.api.library.move = vi.fn(async (slug: string, to) => ok(receipt({ slug, to })));
    fake.api.library.putBack = vi.fn(async () => ok({ slug: 'office-plants' }));
    const host = await renderSidebar();
    fake.emit('moved', receipt());
    expect(host.querySelector('.toast')?.textContent).toBe('Moved to ArchiveUndo');
    await click(button(host, 'Undo'));
    expect(fake.api.library.move).toHaveBeenCalledWith('office-plants', 'unfiled', { undo: true });
    expect(host.querySelector('.toast')).toBeNull();

    fake.emit('moved', receipt({ to: 'trash', trashId: 'office-plants--20260101T000000' }));
    expect(host.querySelector('.toast')?.textContent).toBe('Moved to TrashUndo');
    await click(button(host, 'Undo'));
    expect(fake.api.library.putBack).toHaveBeenCalledWith('office-plants--20260101T000000');

    // The move that undoes one shows no toast of its own.
    fake.emit('moved', receipt({ undo: true }));
    expect(host.querySelector('.toast')).toBeNull();
  });

  it('the toast leaves after a few seconds', async () => {
    const host = await renderSidebar();
    vi.useFakeTimers();
    try {
      fake.emit('moved', receipt());
      expect(host.querySelector('.toast')).not.toBeNull();
      act(() => void vi.advanceTimersByTime(TOAST_MS + 10));
      expect(host.querySelector('.toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Cmd+Z: a pending library Undo wins over the document; with none left the document gets it', async () => {
    fake.api.doc.history = vi.fn(async () => ok({ canUndo: true, canRedo: false, undoLabel: 'x' }));
    fake.api.doc.undo = vi.fn(async () => ok({ canUndo: false, canRedo: true }));
    fake.api.library.move = vi.fn(async (slug: string, to) => ok(receipt({ slug, to })));
    await render(withAnnouncer([LibrarySidebar, sidebarProps()], [HistoryButtons, { slug: 'widget-pricing' }]));
    fake.emit('moved', receipt());
    await key(document.body, 'z', { metaKey: true });
    expect(fake.api.library.move).toHaveBeenCalledWith('office-plants', 'unfiled', { undo: true });
    expect(fake.api.doc.undo).not.toHaveBeenCalled();

    await key(document.body, 'z', { metaKey: true });
    expect(fake.api.doc.undo).toHaveBeenCalledWith('widget-pricing');
    expect(fake.api.library.move).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Z in a text field is left to the field', async () => {
    fake.api.library.move = vi.fn(async (slug: string, to) => ok(receipt({ slug, to })));
    const host = await renderSidebar();
    fake.emit('moved', receipt());
    await key(host.querySelector('input[type="search"]'), 'z', { metaKey: true });
    expect(fake.api.library.move).not.toHaveBeenCalled();
  });
});

describe('swipe (11 §5.2)', () => {
  const wheel = async (el: Element | null | undefined, deltaX: number) => {
    await act(async () => {
      el?.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY: 0, bubbles: true, cancelable: true }));
    });
  };
  // Past the settle delay and the momentum lockout (SWIPE.wheelSettleMs + wheelLockoutMs).
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 600)));

  it('a long two-finger swipe left archives the row', async () => {
    fake.api.library.move = vi.fn(async (slug: string, to) =>
      ok({ slug, docId: 'x', title: 'x', from: 'unfiled' as const, to }),
    );
    const host = await renderSidebar();
    const li = rowButton(host, 'Office plants')?.closest('li');
    await wheel(li, 90);
    await wheel(li, 90);
    await settle();
    expect(fake.api.library.move).toHaveBeenCalledWith('office-plants', 'archive');
  });

  it('a long swipe right moves the row to the Trash', async () => {
    fake.api.library.move = vi.fn(async (slug: string, to) =>
      ok({ slug, docId: 'x', title: 'x', from: 'unfiled' as const, to }),
    );
    const host = await renderSidebar();
    await wheel(rowButton(host, 'Office plants')?.closest('li'), -200);
    await settle();
    expect(fake.api.library.move).toHaveBeenCalledWith('office-plants', 'trash');
  });

  it('a short swipe leaves the action button to click; Escape closes it', async () => {
    fake.api.library.move = vi.fn(async (slug: string, to) =>
      ok({ slug, docId: 'x', title: 'x', from: 'unfiled' as const, to }),
    );
    const host = await renderSidebar();
    const li = rowButton(host, 'Office plants')?.closest('li');
    await wheel(li, 50);
    await settle();
    expect(fake.api.library.move).not.toHaveBeenCalled();
    expect(button(host, 'Archive')).toBeDefined();
    expect(rowButton(host, 'Office plants')?.style.transform).toBe('translateX(-76px)');
    await key(document.body, 'Escape');
    expect(button(host, 'Archive')).toBeUndefined();

    await wheel(li, 50);
    await settle();
    await click(button(host, 'Archive'));
    await settle();
    expect(fake.api.library.move).toHaveBeenCalledWith('office-plants', 'archive');
  });

  it('vertical wheel scrolling is left alone', async () => {
    const host = await renderSidebar();
    const li = rowButton(host, 'Office plants')?.closest('li');
    const e = new WheelEvent('wheel', { deltaX: 1, deltaY: 30, bubbles: true, cancelable: true });
    await act(async () => void li?.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(false);
    await settle();
    expect(rowButton(host, 'Office plants')?.style.transform).toBe('');
  });
});

describe('Trash view (11 §5.2)', () => {
  const ORG2: LibraryOrganization = {
    ...ORG,
    trash: [
      trashItem(),
      trashItem({
        trashId: 'widget-roas--20260101T000000',
        title: 'Widget ROAS',
        reason: 'merged',
        mergedInto: 'Widget ad spend',
      }),
    ],
  };

  it('lists items with where they came from, and puts one back', async () => {
    fake.api.library.putBack = vi.fn(async () => ok({ slug: 'old-plan' }));
    const host = await render(withAnnouncer([TrashView, { organization: ORG2 }]));
    expect(Array.from(host.querySelectorAll('.trash-item .item-title')).map((e) => e.textContent)).toEqual([
      'Old plan',
      'Widget ROAS',
    ]);
    expect(host.textContent).toContain('Merged into “Widget ad spend”');
    expect(host.textContent).toContain('recoverable for 30 days');
    await click(button(host.querySelector('.trash-item')!, 'Put Back'));
    expect(fake.api.library.putBack).toHaveBeenCalledWith('old-plan--20260101T000000');
  });

  it('Delete Permanently and Empty Trash each ask once, inline; Cancel does nothing', async () => {
    fake.api.library.deletePermanently = vi.fn(async () => ok(undefined));
    fake.api.library.emptyTrash = vi.fn(async () => ok({ deleted: 2 }));
    const host = await render(withAnnouncer([TrashView, { organization: ORG2 }]));
    await click(button(host.querySelector('.trash-item')!, 'Delete Permanently'));
    expect(host.textContent).toContain('Delete “Old plan” permanently? This can’t be undone.');
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(button(host, 'Cancel'));
    expect(fake.api.library.deletePermanently).not.toHaveBeenCalled();
    await click(button(host.querySelector('.trash-item')!, 'Delete Permanently'));
    await click(button(host, 'Delete'));
    expect(fake.api.library.deletePermanently).toHaveBeenCalledWith('old-plan--20260101T000000');

    await click(button(host, 'Empty Trash'));
    expect(host.textContent).toContain('Permanently delete 2 documents in the Trash? This can’t be undone.');
    expect(host.querySelector('[role="dialog"], dialog')).toBeNull();
    const confirmButtons = host.querySelectorAll('.confirm button');
    await click(confirmButtons[1]);
    expect(fake.api.library.emptyTrash).toHaveBeenCalledOnce();
  });

  it('an empty Trash says so and cannot be emptied', async () => {
    const host = await render(withAnnouncer([TrashView, { organization: { ...ORG, trash: [] } }]));
    expect(host.textContent).toContain('The Trash is empty');
    expect(button(host, 'Empty Trash')?.disabled).toBe(true);
  });

  it('a document opened from elsewhere that is in the Trash offers Put Back', async () => {
    fake.api.library.putBack = vi.fn(async () => ok({ slug: 'old-plan' }));
    const onRestored = vi.fn();
    const host = await render(withAnnouncer([InTrash, { item: trashItem(), onRestored }]));
    expect(host.textContent).toContain('This document is in the Trash.');
    await click(button(host, 'Put Back'));
    expect(onRestored).toHaveBeenCalledWith('old-plan');
  });
});
