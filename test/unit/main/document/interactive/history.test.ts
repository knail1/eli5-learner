import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { parseDocument, renderDocument, sectionIdsOfTab, type DocRuntime } from '../../../../../src/main/document';
import { quoteLabel } from '../../../../../src/main/library';
import type {
  DocHistoryChangedEvent,
  DocVersionsChangedEvent,
  ScrollToEvent,
} from '../../../../../src/preload/contract';
import { fixture, rejection, req, sec, setup, type Setup } from './harness';

/** One-level undo/redo of a document (08 §6.7, 09 §4.1): labels, busy refusal, viewer refresh, events. */

async function runAction(s: Setup, over: Record<string, unknown> = {}): Promise<void> {
  const r = req(s, over);
  const { jobId } =
    r.action === ('eli5-tab' as string)
      ? await s.ir.actions.createSectionEli5({ ...r, action: undefined } as never)
      : await s.ir.actions.regenerateSection(r);
  await s.ir.runner(s.ctx(jobId).ctx);
  s.jobs.emit(jobId, 'done');
  // The viewer finishes the reload the update asked for.
  s.viewer.load();
}

const heading0 = async (s: Setup) => parseDocument(await s.read()).model.tabs[0]?.sections[0]?.heading;

function historyEvents(s: Setup): DocHistoryChangedEvent[] {
  const out: DocHistoryChangedEvent[] = [];
  s.ir.history.onChanged((e) => out.push(e));
  return out;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('history state (08 §6.7)', () => {
  it('a new document offers nothing; a section action offers Undo labelled with the action and heading', async () => {
    const s = await setup();
    expect(await s.ir.history.state(s.slug)).toEqual({ canUndo: false, canRedo: false, busy: false });
    const heading = s.model.tabs[0]?.sections[0]?.heading ?? '';
    await runAction(s, { action: 'reexplain' });
    expect(await s.ir.history.state(s.slug)).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: `re-explained '${quoteLabel(heading)}'`,
      busy: false,
    });
  });

  it('"Edit with my note" replaces only its section, is labelled "edited", and undo restores (08 §5.1)', async () => {
    const s = await setup();
    const before = parseDocument(await s.read()).model;
    const heading = before.tabs[0]?.sections[0]?.heading ?? '';
    await runAction(s, { action: 'revise', note: 'The average is twelve weeks' });
    const after = parseDocument(await s.read()).model;
    // The scripted revise response replaced the first section; every other section is unchanged.
    expect(after.tabs[0]?.sections[0]?.lastAction).toBe('revise');
    expect(after.tabs[0]?.sections.slice(1)).toEqual(before.tabs[0]?.sections.slice(1));
    expect(await s.ir.history.state(s.slug)).toMatchObject({
      canUndo: true,
      undoLabel: `edited '${quoteLabel(heading)}'`,
    });
    await s.ir.history.undo(s.slug);
    expect(parseDocument(await s.read()).model.tabs[0]?.sections[0]).toEqual(before.tabs[0]?.sections[0]);
  });

  it('labels an ELI5 tab add and a tab close', async () => {
    const s = await setup();
    await runAction(s, { action: 'eli5-tab' });
    const state = await s.ir.history.state(s.slug);
    const tab = parseDocument(await s.read()).model.tabs.at(-1);
    expect(state.undoLabel).toBe(`added ELI5 tab '${quoteLabel(tab?.label ?? '')}'`);
    await s.ir.actions.closeTab({ slug: s.slug, tabKey: tab?.key ?? '' });
    expect((await s.ir.history.state(s.slug)).undoLabel).toBe(`closed tab '${quoteLabel(tab?.label ?? '')}'`);
  });

  it('reports busy while a section job for the document is queued or running', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.regenerateSection(req(s));
    expect(await s.ir.history.state(s.slug)).toMatchObject({ busy: true });
    await s.ir.runner(s.ctx(jobId).ctx);
    s.jobs.emit(jobId, 'done');
    expect(await s.ir.history.state(s.slug)).toMatchObject({ busy: false, canUndo: true });
  });

  it('refuses an unknown document with E_NOT_FOUND', async () => {
    const s = await setup();
    expect(await rejection(s.ir.history.state('not-there'))).toMatchObject({ code: 'E_NOT_FOUND' });
    expect(await rejection(s.ir.history.undo('not-there'))).toMatchObject({ code: 'E_NOT_FOUND' });
  });
});

describe('undo / redo (08 §6.7)', () => {
  it('undo restores the prior version, reloads the viewer and emits updated; redo brings the change back', async () => {
    const s = await setup();
    const original = await s.read();
    await runAction(s);
    const changed = await s.read();
    const reloads = s.viewer.reloads;
    const updates = s.events.updated.length;

    expect(await s.ir.history.undo(s.slug)).toMatchObject({ canUndo: false, canRedo: true, busy: false });
    expect(await s.read()).toBe(original);
    expect(s.viewer.reloads).toBe(reloads + 1);
    // 09 §4.1: Undo lands where the undone change was made.
    expect(s.events.updated.slice(updates)).toEqual([
      { slug: s.slug, tabKey: 'indepth', sectionId: sec(s.model, 0, 0) },
    ]);
    s.viewer.load();

    expect(await s.ir.history.redo(s.slug)).toMatchObject({ canUndo: true, canRedo: false });
    expect(await s.read()).toBe(changed);
    expect(s.viewer.reloads).toBe(reloads + 2);
  });

  it('does not reload the viewer when it shows another document', async () => {
    const s = await setup();
    await runAction(s);
    s.viewer.slug = 'other-doc';
    const reloads = s.viewer.reloads;
    await s.ir.history.undo(s.slug);
    expect(s.viewer.reloads).toBe(reloads);
  });

  it('refuses with E_CONFLICT while any section job for the document is queued or running', async () => {
    const s = await setup();
    await runAction(s);
    const before = await s.read();
    // Another section of the same document is busy.
    const { jobId } = await s.ir.actions.regenerateSection(req(s, { sectionId: sec(s.model, 0, 1) }));
    for (const p of [s.ir.history.undo(s.slug), s.ir.history.redo(s.slug)]) {
      expect(await rejection(p)).toMatchObject({ code: 'E_CONFLICT' });
    }
    expect(await s.read()).toBe(before);
    s.jobs.emit(jobId, 'failed', 'INTERNAL');
    await s.ir.history.undo(s.slug);
    expect(await s.read()).not.toBe(before);
  });

  it('refuses with E_CONFLICT when there is nothing to undo or redo', async () => {
    const s = await setup();
    expect(await rejection(s.ir.history.undo(s.slug))).toMatchObject({
      code: 'E_CONFLICT',
      message: 'Nothing to undo',
    });
    expect(await rejection(s.ir.history.redo(s.slug))).toMatchObject({
      code: 'E_CONFLICT',
      message: 'Nothing to redo',
    });
  });

  it('a new section action after an undo drops the redo', async () => {
    const s = await setup();
    await runAction(s);
    await s.ir.history.undo(s.slug);
    expect(await heading0(s)).toBe(s.model.tabs[0]?.sections[0]?.heading);
    await runAction(s, { action: 'analogy' });
    expect(await s.ir.history.state(s.slug)).toMatchObject({ canUndo: true, canRedo: false });
  });
});

describe('eli5:doc:history-changed (08 §6.7)', () => {
  it('is emitted when the document changes, on undo, and when its busy state changes', async () => {
    const s = await setup();
    const events = historyEvents(s);
    const { jobId } = await s.ir.actions.regenerateSection(req(s));
    await settle();
    expect(events.at(-1)).toEqual({ slug: s.slug, state: { canUndo: false, canRedo: false, busy: true } });
    await s.ir.runner(s.ctx(jobId).ctx);
    s.jobs.emit(jobId, 'done');
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ slug: s.slug, state: { canUndo: true, busy: false } }),
    );
    await s.ir.history.undo(s.slug);
    // Poll rather than wait a fixed 10 ms: under a loaded machine the emit can land later.
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ slug: s.slug, state: { canUndo: false, canRedo: true, busy: false } }),
    );
  });
});

const NEW_RUNTIME: DocRuntime = {
  js: '(function(){document.documentElement.classList.add("js","v2")})();',
  css: ':root{--paper:#fefefe}body{background:var(--paper)}',
};

async function tree(s: Setup) {
  return s.ir.history.versions(s.slug);
}

describe('checkout (09 §4.1, D1)', () => {
  it('opens an older version, notifies with its scroll target and scrolls after the reload', async () => {
    const s = await setup();
    const original = await s.read();
    await runAction(s);
    const changed = await s.read();
    const t = await tree(s);
    const root = t.nodes.find((n) => n.parentId === null);
    const child = t.nodes.find((n) => n.parentId === root?.id);
    expect(t.currentId).toBe(child?.id);
    const at = { tabKey: 'indepth', sectionId: sec(s.model, 0, 0) };
    expect(child?.target).toEqual(at);

    const updates = s.events.updated.length;
    const back = await s.ir.history.checkout({ slug: s.slug, versionId: root?.id ?? '' });
    expect(back).toMatchObject({ slug: s.slug, currentId: root?.id, redoId: child?.id, busy: false });
    expect(await s.read()).toBe(original);
    expect(s.events.updated.slice(updates)).toEqual([{ slug: s.slug, ...at }]);
    s.viewer.load();
    expect(s.events.scroll.at(-1)).toMatchObject({ ...at, flash: true });

    await s.ir.history.checkout({ slug: s.slug, versionId: child?.id ?? '' });
    expect(await s.read()).toBe(changed);
    expect(s.events.updated.at(-1)).toEqual({ slug: s.slug, ...at });
  });

  it('is refused with E_CONFLICT while a section job of the document is busy, and writes nothing', async () => {
    const s = await setup();
    await runAction(s);
    const before = await s.read();
    const root = (await tree(s)).nodes.find((n) => n.parentId === null);
    const { jobId } = await s.ir.actions.regenerateSection(req(s, { sectionId: sec(s.model, 0, 1) }));
    expect(await rejection(s.ir.history.checkout({ slug: s.slug, versionId: root?.id ?? '' }))).toMatchObject({
      code: 'E_CONFLICT',
      message: 'Wait for the section update to finish',
    });
    expect(await s.read()).toBe(before);
    s.jobs.emit(jobId, 'failed', 'INTERNAL');
    await s.ir.history.checkout({ slug: s.slug, versionId: root?.id ?? '' });
    expect(await s.read()).not.toBe(before);
  });

  it('refuses an unknown version with VERSION_NOT_FOUND and an unknown document with E_NOT_FOUND', async () => {
    const s = await setup();
    expect(await rejection(s.ir.history.checkout({ slug: s.slug, versionId: 'v-0123456789ab' }))).toMatchObject({
      code: 'VERSION_NOT_FOUND',
    });
    expect(await rejection(s.ir.history.checkout({ slug: 'not-there', versionId: 'v-0123456789ab' }))).toMatchObject({
      code: 'E_NOT_FOUND',
    });
  });

  it('a corrupt snapshot is refused with VERSION_CORRUPT, writes nothing, and is not offered again', async () => {
    const s = await setup();
    await runAction(s);
    const before = await s.read();
    const t = await tree(s);
    const root = t.nodes.find((n) => n.parentId === null);
    const dir = path.join(path.dirname(s.lib.docPath(s.slug)), '.versions');
    const file = JSON.parse(await readFile(path.join(dir, 'tree.json'), 'utf8')) as {
      nodes: { id: string; sha256: string }[];
    };
    const sha = file.nodes.find((n) => n.id === root?.id)?.sha256 ?? '';
    await writeFile(path.join(dir, 'blobs', `${sha}.html.gz`), gzipSync('<!doctype html><p>not it</p>'));
    expect(await rejection(s.ir.history.checkout({ slug: s.slug, versionId: root?.id ?? '' }))).toMatchObject({
      code: 'VERSION_CORRUPT',
    });
    expect(await s.read()).toBe(before);
    const after = await tree(s);
    expect(after.nodes.find((n) => n.id === root?.id)).toMatchObject({ available: false });
    expect(await s.ir.history.state(s.slug)).toMatchObject({ canUndo: false });
  });

  it('Undo steps back from the version current when it gets the lock, not from an older read', async () => {
    const s = await setup();
    await runAction(s);
    const mid = await s.read();
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    let inLock = (): void => {};
    const entered = new Promise<void>((r) => (inLock = r));
    // Another write (a tab close, a merge accept) holds the lock while Undo is asked for.
    const other = s.lib.withDocLock(s.slug, async () => {
      inLock();
      await held;
      const cur = parseDocument(await s.read());
      const m = { ...cur.model, title: `${cur.model.title}!` };
      await s.lib.updateDocument(s.slug, {
        html: renderDocument(m, cur.assets, { runtime: cur.runtime, theme: cur.theme }),
        meta: (x) => x,
        label: 'retitled',
      });
    });
    await entered;
    const undo = s.ir.history.undo(s.slug);
    await settle();
    release();
    await other;
    await undo;
    // The write made under the lock is the one undone.
    expect(await s.read()).toBe(mid);
  });

  it('opening the version already shown only scrolls: no write, no reload', async () => {
    const s = await setup();
    await runAction(s);
    const before = await s.read();
    const t = await tree(s);
    const reloads = s.viewer.reloads;
    const updates = s.events.updated.length;
    const scrolls = s.events.scroll.length;
    expect(await s.ir.history.checkout({ slug: s.slug, versionId: t.currentId })).toMatchObject({
      currentId: t.currentId,
    });
    expect(await s.read()).toBe(before);
    expect(s.viewer.reloads).toBe(reloads);
    expect(s.events.updated.length).toBe(updates);
    expect(s.events.scroll.slice(scrolls)).toEqual([
      { tabKey: 'indepth', sectionId: sec(s.model, 0, 0), flash: true, loadSeq: expect.any(Number) as number },
    ]);
    // Not shown in the viewer: nothing to scroll.
    s.viewer.slug = 'other-doc';
    await s.ir.history.checkout({ slug: s.slug, versionId: t.currentId });
    expect(s.events.scroll.length).toBe(scrolls + 1);
  });

  it('carries an anchorId from the version node to the update and the scroll-to', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 1);
    await s.lib.withDocLock(s.slug, async () => {
      const cur = parseDocument(await s.read());
      const m = { ...cur.model, title: `${cur.model.title}!` };
      await s.lib.updateDocument(s.slug, {
        html: renderDocument(m, cur.assets, { runtime: cur.runtime, theme: cur.theme }),
        meta: (x) => x,
        label: "asked about 'Budget'",
        change: {
          kind: 'ask',
          topic: 'Budget',
          target: { tabKey: 'indepth', sectionId: id, anchorId: 'qa-0a1b2c3d' },
          undoTarget: { tabKey: 'indepth', sectionId: id },
        },
      });
    });
    const t = await tree(s);
    const asked = t.currentId;
    await s.ir.history.undo(s.slug);
    expect(s.events.updated.at(-1)).toEqual({ slug: s.slug, tabKey: 'indepth', sectionId: id });
    s.viewer.load();
    await s.ir.history.checkout({ slug: s.slug, versionId: asked });
    expect(s.events.updated.at(-1)).toEqual({
      slug: s.slug,
      tabKey: 'indepth',
      sectionId: id,
      anchorId: 'qa-0a1b2c3d',
    });
    s.viewer.load();
    expect(s.events.scroll.at(-1) as ScrollToEvent).toMatchObject({
      sectionId: id,
      anchorId: 'qa-0a1b2c3d',
      flash: true,
    });
  });

  it('retires the IDs of the version left behind, so a new branch never reuses them (D7)', async () => {
    const s = await setup();
    await runAction(s, { action: 'eli5-tab' });
    const added = parseDocument(await s.read()).model.tabs.at(-1);
    const addedIds = sectionIdsOfTab(parseDocument(await s.read()).model, added?.key ?? '');
    expect(addedIds.length).toBeGreaterThan(0);

    await s.ir.history.undo(s.slug);
    s.viewer.load();
    const retired = (await s.lib.getMeta(s.slug)).retiredIds;
    expect(retired).toEqual(expect.arrayContaining(addedIds));

    // Back on the version that has them: they are live again, so not retired.
    await s.ir.history.redo(s.slug);
    s.viewer.load();
    const again = (await s.lib.getMeta(s.slug)).retiredIds;
    for (const x of addedIds) expect(again).not.toContain(x);

    // A new branch from the root draws fresh IDs.
    await s.ir.history.undo(s.slug);
    s.viewer.load();
    await runAction(s, { action: 'eli5-tab' });
    const next = parseDocument(await s.read()).model;
    const fresh = sectionIdsOfTab(next, next.tabs.at(-1)?.key ?? '');
    for (const x of fresh) expect(addedIds).not.toContain(x);
    const t = await tree(s);
    const root = t.nodes.find((n) => n.parentId === null);
    expect(t.nodes.filter((n) => n.parentId === root?.id)).toHaveLength(2);
  });

  it('re-renders an old-runtime snapshot with the bundled runtime, same model (D12 c)', async () => {
    const g = fixture.model.generator;
    const old = { ...fixture.model, generator: { ...g, runtimeVersion: '0.9.0' } };
    const s = await setup({ model: old, deps: { bundledRuntime: () => NEW_RUNTIME } });
    await runAction(s);
    // The change itself is rendered with the bundled runtime (runtimeFor).
    expect(parseDocument(await s.read()).runtime).toEqual(NEW_RUNTIME);
    await s.ir.history.undo(s.slug);
    const back = parseDocument(await s.read());
    expect(back.runtime).toEqual(NEW_RUNTIME);
    expect(back.model.generator.runtimeVersion).not.toBe('0.9.0');
    expect(back.model.tabs).toEqual(parseDocument(s.html).model.tabs);
    // Still the same node (the root), now holding the upgraded snapshot.
    const t = await tree(s);
    expect(t.nodes).toHaveLength(2);
    expect(t.currentId).toBe(t.nodes.find((n) => n.parentId === null)?.id);
    expect(t.detached).toBe(false);
  });
});

describe('eli5:doc:versions-changed (09 §4.1)', () => {
  it('is pushed with busy and pending entries while a section job runs, then with the new node', async () => {
    const s = await setup();
    const events: DocVersionsChangedEvent[] = [];
    s.ir.history.onVersionsChanged((e) => events.push(e));
    const { jobId } = await s.ir.actions.regenerateSection(req(s));
    await settle();
    const heading = s.model.tabs[0]?.sections[0]?.heading ?? '';
    expect(events.at(-1)).toMatchObject({
      slug: s.slug,
      tree: { busy: true, pending: [{ sectionId: sec(s.model, 0, 0), action: 'expand', heading }] },
    });
    expect(events.at(-1)?.tree.nodes).toHaveLength(1);
    await s.ir.runner(s.ctx(jobId).ctx);
    s.jobs.emit(jobId, 'done');
    await settle();
    expect(events.at(-1)).toMatchObject({ slug: s.slug, tree: { busy: false, pending: [] } });
    expect(events.at(-1)?.tree.nodes).toHaveLength(2);
    expect(events.at(-1)?.tree.nodes.at(-1)).toMatchObject({
      kind: 'expand',
      label: `expanded '${quoteLabel(heading)}'`,
    });
  });
});
