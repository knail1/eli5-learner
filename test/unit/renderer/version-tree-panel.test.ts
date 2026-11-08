import { act, createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocVersionTree, IpcResult, SectionId } from '../../../src/preload/contract';
import {
  button,
  click,
  flush,
  installFakeApi,
  key,
  loadRenderer,
  ok,
  render,
  versionNode,
  versionTree,
  type Component,
  type FakeApi,
} from './harness';

const { VersionTreePanel, useVersionTree } = await loadRenderer<{
  VersionTreePanel: Component;
  useVersionTree(slug: string | null): [DocVersionTree | null, (t: DocVersionTree) => void];
}>('viewer/VersionTreePanel.tsx');

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
});

const at = (min: number) => `2026-01-01T00:${String(min).padStart(2, '0')}:00.000Z`;

/** v0 ─ a ─ b, with a later branch a ─ x (an Ask). Current: b. */
const tree = (over: Partial<DocVersionTree> = {}): DocVersionTree =>
  versionTree('doc-a', {
    nodes: [
      versionNode({ id: 'v0', topic: 'The original', createdAt: at(0) }),
      versionNode({
        id: 'a',
        parentId: 'v0',
        kind: 'expand',
        topic: 'Pricing',
        label: "expanded 'Pricing'",
        heading: 'Pricing',
        createdAt: at(1),
        published: true,
      }),
      versionNode({ id: 'b', parentId: 'a', kind: 'analogy', topic: 'Pricing analogy', createdAt: at(2) }),
      versionNode({
        id: 'x',
        parentId: 'a',
        kind: 'ask',
        topic: 'Why tiers',
        label: "asked about 'Pricing'",
        question: 'Why three tiers?',
        createdAt: at(3),
      }),
    ],
    currentId: 'b',
    ...over,
  });

const mount = (t: DocVersionTree | null, over: Record<string, unknown> = {}) => {
  const onTree = vi.fn();
  const onClose = vi.fn();
  return render(VersionTreePanel, { slug: 'doc-a', tree: t, width: 300, onTree, onClose, ...over }).then((host) => ({
    host,
    onTree,
    onClose,
  }));
};

const items = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]'));
const item = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[role="treeitem"][data-id="${id}"]`);
const rowOf = (host: HTMLElement, id: string) => item(host, id)?.querySelector('.version-row');

describe('VersionTreePanel (11 §5.7)', () => {
  it('renders a labelled tree with levels, the current version and chips', async () => {
    const { host } = await mount(tree());
    const aside = host.querySelector('aside#version-panel');
    expect(aside?.getAttribute('data-region')).toBe('versions');
    expect(aside?.getAttribute('aria-label')).toBe('Versions');
    expect(host.querySelector('h2')?.textContent).toBe('Versions');
    expect(host.querySelector('ul[role="tree"]')?.getAttribute('aria-label')).toBe('Document versions');
    expect(items(host).map((i) => i.dataset.id)).toEqual(['v0', 'a', 'x', 'b']);
    expect(item(host, 'b')?.getAttribute('aria-current')).toBe('true');
    expect(item(host, 'a')?.getAttribute('aria-current')).toBeNull();
    // The branch point carries aria-expanded and owns a nested group.
    expect(item(host, 'a')?.getAttribute('aria-expanded')).toBe('true');
    expect(item(host, 'v0')?.hasAttribute('aria-expanded')).toBe(false);
    expect(item(host, 'a')?.querySelector('ul[role="group"] [data-id="x"]')).not.toBeNull();
    expect(item(host, 'x')?.getAttribute('aria-level')).toBe('2');
    expect(item(host, 'b')?.getAttribute('aria-posinset')).toBe('3');
    expect(item(host, 'b')?.getAttribute('aria-setsize')).toBe('3');
    expect(item(host, 'b')?.textContent).toContain('Current');
    expect(item(host, 'a')?.querySelector(':scope > .version-row')?.textContent).toContain('Published');
    expect(rowOf(host, 'a')?.textContent).toContain('Expanded · ');
    expect(rowOf(host, 'x')?.textContent).toContain('Asked');
    expect(rowOf(host, 'x')?.textContent).toContain('“Why three tiers?”');
    expect(item(host, 'b')?.classList.contains('on-path')).toBe(true);
    expect(item(host, 'x')?.classList.contains('off-path')).toBe(true);
    // The current version has the roving tab stop; no native title tooltips on rows.
    expect(item(host, 'b')?.tabIndex).toBe(0);
    expect(item(host, 'a')?.tabIndex).toBe(-1);
    expect(host.querySelector('[role="treeitem"][title]')).toBeNull();
    // The detail strip shows the focused (here current) row.
    expect(host.querySelector('.version-detail')?.textContent).toContain('Original');
  });

  it('opens a version on click and hands the returned tree up', async () => {
    const next = tree({ currentId: 'a' });
    fake.api.doc.checkout = vi.fn(async () => ok(next)) as typeof fake.api.doc.checkout;
    const { host, onTree } = await mount(tree());
    await click(rowOf(host, 'a'));
    expect(fake.api.doc.checkout).toHaveBeenCalledWith('doc-a', 'a');
    expect(onTree).toHaveBeenCalledWith(next);
    expect(host.querySelector('.version-detail')?.textContent).toContain("expanded 'Pricing'");
    expect(host.querySelector('.version-detail')?.textContent).toContain('Section: Pricing');
  });

  it('shows a spinner while the checkout runs and the refusal inline in the footer', async () => {
    let finish: (r: IpcResult<DocVersionTree>) => void = () => {};
    fake.api.doc.checkout = vi.fn(
      () => new Promise<IpcResult<DocVersionTree>>((r) => (finish = r)),
    ) as unknown as typeof fake.api.doc.checkout;
    const { host, onTree } = await mount(tree());
    await click(rowOf(host, 'v0'));
    expect(item(host, 'v0')?.querySelector('.spinner')).not.toBeNull();
    expect(item(host, 'a')?.getAttribute('aria-disabled')).toBe('true');
    await act(async () =>
      finish({ ok: false, error: { code: 'E_NOT_FOUND', message: 'That version is no longer available' } }),
    );
    await flush();
    expect(host.querySelector('.version-footer [role="alert"]')?.textContent).toBe(
      'That version is no longer available',
    );
    expect(host.querySelector('.spinner')).toBeNull();
    expect(onTree).not.toHaveBeenCalled();
  });

  it('a checkout that throws shows an inline error and frees the rows', async () => {
    fake.api.doc.checkout = vi.fn(async () => {
      throw new Error('IPC went away');
    }) as unknown as typeof fake.api.doc.checkout;
    const { host, onTree } = await mount(tree());
    await click(rowOf(host, 'a'));
    await flush();
    expect(host.querySelector('.version-footer [role="alert"]')?.textContent).toBe('IPC went away');
    expect(item(host, 'a')?.hasAttribute('aria-disabled')).toBe(false);
    expect(host.querySelector('.spinner')).toBeNull();
    expect(onTree).not.toHaveBeenCalled();
  });

  it('a Back that throws shows an inline error', async () => {
    fake.api.doc.undo = vi.fn(async () => {
      throw new Error('IPC went away');
    }) as unknown as typeof fake.api.doc.undo;
    const { host } = await mount(tree());
    await click(button(host, 'Back to previous version'));
    await flush();
    expect(host.querySelector('.version-footer [role="alert"]')?.textContent).toBe('IPC went away');
    expect(button(host, 'Back to previous version')?.disabled).toBe(false);
  });

  it('a removed snapshot is disabled, chipped and says so instead of calling main', async () => {
    const t = tree();
    t.nodes[0] = { ...t.nodes[0]!, available: false };
    const { host } = await mount(t);
    expect(item(host, 'v0')?.getAttribute('aria-disabled')).toBe('true');
    expect(rowOf(host, 'v0')?.textContent).toContain('(snapshot removed)');
    await click(rowOf(host, 'v0'));
    expect(fake.api.doc.checkout).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('That version is no longer available');
  });

  it('keyboard follows the tree pattern: arrows, Home/End, collapse, expand, type-ahead, Enter', async () => {
    fake.api.doc.checkout = vi.fn(async () => ok(tree())) as typeof fake.api.doc.checkout;
    const { host } = await mount(tree());
    const focused = () => (document.activeElement as HTMLElement | null)?.dataset.id;
    item(host, 'b')?.focus();
    await key(document.activeElement, 'Home');
    expect(focused()).toBe('v0');
    await key(document.activeElement, 'ArrowDown');
    expect(focused()).toBe('a');
    await key(document.activeElement, 'ArrowRight');
    expect(focused()).toBe('x');
    await key(document.activeElement, 'ArrowLeft');
    expect(focused()).toBe('a');
    // Left on an expanded branch point collapses it; Right expands it again.
    await key(document.activeElement, 'ArrowLeft');
    expect(item(host, 'a')?.getAttribute('aria-expanded')).toBe('false');
    expect(item(host, 'x')).toBeNull();
    await key(document.activeElement, 'ArrowRight');
    expect(item(host, 'a')?.getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe('a');
    await key(document.activeElement, 'End');
    expect(focused()).toBe('b');
    await key(document.activeElement, 'ArrowUp');
    expect(focused()).toBe('x');
    expect(host.querySelector('.version-detail')?.textContent).toContain('Question: “Why three tiers?”');
    await key(document.activeElement, 't');
    expect(focused()).toBe('v0'); // "The original"
    await key(document.activeElement, 'Enter');
    expect(fake.api.doc.checkout).toHaveBeenLastCalledWith('doc-a', 'v0');
    await key(document.activeElement, ' ');
    expect(fake.api.doc.checkout).toHaveBeenCalledTimes(2);
  });

  it('a branch holding the current version cannot collapse', async () => {
    const { host } = await mount(tree({ currentId: 'x' }));
    item(host, 'a')?.focus();
    await key(document.activeElement, 'ArrowLeft');
    expect(item(host, 'a')?.getAttribute('aria-expanded')).toBe('true');
    // A top-level row has no parent to move to.
    expect((document.activeElement as HTMLElement).dataset.id).toBe('a');
  });

  it('while busy every row is disabled, with the busy line, a pending row and no Back/Forward', async () => {
    const { host } = await mount(
      tree({
        busy: true,
        redoId: undefined,
        pending: [{ sectionId: 's1' as SectionId, action: 'ask', heading: 'Pricing' }],
      }),
    );
    expect(items(host).every((i) => i.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(host.textContent).toContain('Wait for the update to finish');
    expect(item(host, 'b')?.querySelector('.version-pending')?.textContent).toBe('Answering… · Pricing');
    expect(button(host, 'Back to previous version')?.disabled).toBe(true);
    expect(button(host, 'Forward to next version')?.disabled).toBe(true);
    await click(rowOf(host, 'a'));
    expect(fake.api.doc.checkout).not.toHaveBeenCalled();
  });

  it('shows the detached and degraded banners in a polite live region', async () => {
    const { host } = await mount(tree({ detached: true, degraded: true }));
    const live = host.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain(
      'This document changed outside the app; it will be saved as a version on the next change.',
    );
    expect(live?.textContent).toContain('Version history couldn’t be saved for the last change.');
  });

  it('Back and Forward run undo and redo, with the version labels in their tooltips', async () => {
    fake.api.doc.undo = vi.fn(async () => ok({ canUndo: true, canRedo: true })) as typeof fake.api.doc.undo;
    fake.api.doc.redo = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'E_BUSY' as const, message: 'Busy' },
    })) as unknown as typeof fake.api.doc.redo;
    const { host, onClose } = await mount(tree({ currentId: 'a', redoId: 'b' }));
    const back = button(host, 'Back to previous version');
    const fwd = button(host, 'Forward to next version');
    expect(back?.title).toBe("Back: undo expanded 'Pricing'");
    expect(fwd?.title).toContain('Forward: ');
    await click(back);
    expect(fake.api.doc.undo).toHaveBeenCalledWith('doc-a');
    await click(fwd);
    expect(fake.api.doc.redo).toHaveBeenCalledWith('doc-a');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Busy');
    await click(button(host, 'Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Back and Forward are disabled at the ends and with a read-only library', async () => {
    const { host } = await mount(tree({ currentId: 'v0' }));
    expect(button(host, 'Back to previous version')?.disabled).toBe(true);
    expect(button(host, 'Forward to next version')?.disabled).toBe(true);
    const ro = await mount(tree({ currentId: 'a', redoId: 'b', readOnly: true }));
    expect(button(ro.host, 'Back to previous version')?.disabled).toBe(true);
    expect(button(ro.host, 'Forward to next version')?.disabled).toBe(true);
    expect(item(ro.host, 'v0')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('fades in versions that arrive after the first load', async () => {
    let setTree: (t: DocVersionTree) => void = () => {};
    const host = await render(function Harness() {
      const [t, set] = useState<DocVersionTree>(tree());
      setTree = set;
      return createElement(VersionTreePanel, { slug: 'doc-a', tree: t, width: 300, onTree: vi.fn(), onClose: vi.fn() });
    });
    expect(host.querySelector('.version-new')).toBeNull();
    const t = tree();
    t.nodes.push(versionNode({ id: 'c', parentId: 'b', kind: 'deeper', topic: 'Deeper', createdAt: at(4) }));
    await act(async () => setTree({ ...t, currentId: 'c' }));
    expect(Array.from(host.querySelectorAll<HTMLElement>('.version-new')).map((e) => e.dataset.id)).toEqual(['c']);
    // A re-render that keeps the tree (moving focus) does not cut the fade short.
    await act(async () => item(host, 'v0')?.focus());
    expect(Array.from(host.querySelectorAll<HTMLElement>('.version-new')).map((e) => e.dataset.id)).toEqual(['c']);
  });

  it('shows a loading line until the tree arrives', async () => {
    const { host } = await mount(null);
    expect(host.textContent).toContain('Loading versions…');
    expect(host.querySelector('[role="tree"]')).toBeNull();
  });
});

describe('useVersionTree (11 §5.7 data)', () => {
  const Probe = (p: Record<string, unknown>) => {
    const [t] = useVersionTree(p.slug as string | null);
    return createElement('output', null, t ? `${t.slug}:${t.nodes.length}` : 'none');
  };

  it('loads on slug change, follows pushes for the open slug only, and drops stale answers', async () => {
    const resolvers: Record<string, (r: IpcResult<DocVersionTree>) => void> = {};
    fake.api.doc.versions = vi.fn(
      (slug: string) => new Promise<IpcResult<DocVersionTree>>((r) => (resolvers[slug] = r)),
    ) as unknown as typeof fake.api.doc.versions;
    let setSlug: (s: string | null) => void = () => {};
    const host = await render(function Harness() {
      const [slug, set] = useState<string | null>('doc-a');
      setSlug = set;
      return createElement(Probe, { slug });
    });
    await act(async () => setSlug('doc-b'));
    await flush();
    // doc-a's answer arrives after switching: dropped.
    await act(async () => resolvers['doc-a']?.(ok(versionTree('doc-a'))));
    await flush();
    expect(host.textContent).toBe('none');
    await act(async () => resolvers['doc-b']?.(ok(versionTree('doc-b'))));
    await flush();
    expect(host.textContent).toBe('doc-b:1');
    fake.emit('doc-versions', { slug: 'doc-a', tree: versionTree('doc-a', { nodes: [versionNode(), versionNode()] }) });
    expect(host.textContent).toBe('doc-b:1');
    fake.emit('doc-versions', {
      slug: 'doc-b',
      tree: versionTree('doc-b', { nodes: [versionNode(), versionNode({ id: 'v1', parentId: 'v0' })] }),
    });
    expect(host.textContent).toBe('doc-b:2');
    await act(async () => setSlug(null));
    expect(host.textContent).toBe('none');
  });
});
