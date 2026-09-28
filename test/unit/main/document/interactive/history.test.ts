import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../../../../src/main/document';
import { quoteLabel } from '../../../../../src/main/library';
import type { DocHistoryChangedEvent } from '../../../../../src/preload/contract';
import { rejection, req, sec, setup, type Setup } from './harness';

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
    expect(s.events.updated.slice(updates)).toEqual([{ slug: s.slug }]);
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
    await settle();
    expect(events.at(-1)).toMatchObject({ slug: s.slug, state: { canUndo: true, busy: false } });
    await s.ir.history.undo(s.slug);
    await settle();
    expect(events.at(-1)).toMatchObject({ slug: s.slug, state: { canUndo: false, canRedo: true, busy: false } });
  });
});
