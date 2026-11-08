import { describe, expect, it, vi } from 'vitest';
import { DOC_RUNTIME_VERSION, parseDocument, sectionHash, type DocRuntime } from '../../../../../src/main/document';
import type { Logger } from '../../../../../src/main/security';
import { STUB_RUNTIME } from '../../../../fixtures/documents/runtime';
import { fixture, rejection, req, sec, setup, type Setup } from './harness';

/** The Ask channel of the service (08 Ask) and the runtime refresh on open (D12 a, 07 §5.5). */

const NEW_RUNTIME: DocRuntime = {
  js: '(function(){document.documentElement.classList.add("js","v2")})();',
  css: ':root{--paper:#fefefe}body{background:var(--paper)}',
};

const askReq = (s: Setup, over: Record<string, unknown> = {}) => ({
  slug: s.slug,
  tabKey: 'indepth',
  sectionId: sec(s.model, 0, 0),
  selectionText: 'judges every channel',
  question: 'Why ROAS and not reach?',
  ...over,
});

describe('askSection (08 Ask)', () => {
  it('enqueues an ask job carrying the question, the heading and the baseHash', async () => {
    const s = await setup();
    const section = s.model.tabs[0]?.sections[0];
    if (!section) throw new Error('fixture');
    expect(await s.ir.actions.askSection(askReq(s))).toEqual({ jobId: 'job-s1' });
    expect(s.jobs.enqueueSection).toHaveBeenCalledWith({
      slug: s.slug,
      tabKey: 'indepth',
      sectionId: section.id,
      action: 'ask',
      selectionText: 'judges every channel',
      question: 'Why ROAS and not reach?',
      heading: section.heading,
      baseHash: sectionHash(section),
    });
    // The section shows as busy with the ask action.
    expect(s.events.busy.at(-1)).toEqual({ busy: [{ sectionId: section.id, action: 'ask' }] });
  });

  it('shares the busy key with the other actions: one action per section', async () => {
    const s = await setup();
    await s.ir.actions.regenerateSection(req(s));
    expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({
      code: 'E_CONFLICT',
      message: 'This section is already being updated',
    });
    const t = await setup();
    await t.ir.actions.askSection(askReq(t));
    expect(await rejection(t.ir.actions.regenerateSection(req(t)))).toMatchObject({ code: 'E_CONFLICT' });
    // Another section is free.
    expect(await t.ir.actions.askSection(askReq(t, { sectionId: sec(t.model, 0, 1) }))).toMatchObject({
      jobId: 'job-s2',
    });
  });

  it('shares the rate limit with the other channels (10 per document per minute)', async () => {
    const s = await setup();
    for (let i = 0; i < 10; i++) {
      const start = i % 2 ? s.ir.actions.askSection(askReq(s)) : s.ir.actions.regenerateSection(req(s));
      const { jobId } = await start;
      s.jobs.emit(jobId, 'done');
    }
    expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({ code: 'E_RATE_LIMITED' });
  });

  it('refuses another document than the viewer, a missing API key and a blank question', async () => {
    const s = await setup();
    s.viewer.slug = 'someone-else';
    expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({ code: 'E_FORBIDDEN' });
    s.viewer.slug = s.slug;
    s.hasApiKey.mockResolvedValueOnce(false);
    expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({ code: 'E_NO_API_KEY' });
    expect(await rejection(s.ir.actions.askSection(askReq(s, { question: '   ' })))).toMatchObject({
      code: 'E_BAD_REQUEST',
    });
    expect(s.jobs.enqueueSection).not.toHaveBeenCalled();
    // A refused request frees its reservation.
    expect(await s.ir.actions.askSection(askReq(s))).toMatchObject({ jobId: 'job-s1' });
  });

  it('refuses a section that is gone or a references section', async () => {
    const s = await setup();
    expect(await rejection(s.ir.actions.askSection(askReq(s, { sectionId: 'sec-indepth-00000000' })))).toMatchObject({
      code: 'E_NOT_FOUND',
    });
    const refs = s.model.tabs[0]?.sections.find((x) => x.kind === 'references');
    if (refs) {
      expect(await rejection(s.ir.actions.askSection(askReq(s, { sectionId: refs.id })))).toMatchObject({
        code: 'E_BAD_REQUEST',
      });
    }
  });
});

describe('refreshRuntimeOnOpen (D12 a)', () => {
  const g = fixture.model.generator;
  const old = { ...fixture.model, generator: { ...g, runtimeVersion: '0.9.0' } };
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

  it('re-renders an older document with the bundled runtime; same model, same version node', async () => {
    const log = logger();
    const s = await setup({ model: old, deps: { bundledRuntime: () => NEW_RUNTIME, log } });
    const before = await s.ir.history.versions(s.slug);
    const metaBefore = await s.lib.getMeta(s.slug);
    await s.ir.refreshRuntimeOnOpen(s.slug);
    const after = parseDocument(await s.read());
    expect(after.runtime).toEqual(NEW_RUNTIME);
    expect(after.model.generator.runtimeVersion).toBe(DOC_RUNTIME_VERSION);
    expect(after.model.tabs).toEqual(old.tabs);
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    expect(tree.currentId).toBe(before.currentId);
    expect(tree.detached).toBe(false);
    expect((await s.lib.getMeta(s.slug)).tabs).toEqual(metaBefore.tabs);
    expect(log.info).toHaveBeenCalledWith('document.runtime-refreshed', { slug: s.slug });
    // Nothing to undo: the refresh is not a change.
    expect((await s.ir.history.state(s.slug)).canUndo).toBe(false);
  });

  it('does nothing for a document on the current runtime', async () => {
    const s = await setup({ deps: { bundledRuntime: () => NEW_RUNTIME } });
    const spy = vi.spyOn(s.lib, 'refreshRuntime');
    const lock = vi.spyOn(s.lib, 'withDocLock');
    const html = await s.read();
    await s.ir.refreshRuntimeOnOpen(s.slug);
    expect(spy).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(await s.read()).toBe(html);
    expect(parseDocument(html).runtime).toEqual(STUB_RUNTIME);
  });

  it('skips a document with a busy section', async () => {
    const s = await setup({ model: old, deps: { bundledRuntime: () => NEW_RUNTIME } });
    const spy = vi.spyOn(s.lib, 'refreshRuntime');
    await s.ir.actions.askSection(askReq(s));
    await s.ir.refreshRuntimeOnOpen(s.slug);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips a read-only library', async () => {
    const s = await setup({ model: old, deps: { bundledRuntime: () => NEW_RUNTIME } });
    const spy = vi.spyOn(s.lib, 'refreshRuntime');
    s.lib.enterReadOnly('locked');
    await s.ir.refreshRuntimeOnOpen(s.slug);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips an unparseable document and an unknown slug without rejecting', async () => {
    const s = await setup({ model: old, deps: { bundledRuntime: () => NEW_RUNTIME } });
    const spy = vi.spyOn(s.lib, 'refreshRuntime');
    await s.write('<!doctype html><p>edited by hand</p>');
    await expect(s.ir.refreshRuntimeOnOpen(s.slug)).resolves.toBeUndefined();
    await expect(s.ir.refreshRuntimeOnOpen('no-such-doc')).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(await s.read()).toBe('<!doctype html><p>edited by hand</p>');
  });

  it('keeps the old runtime when the bundled one is missing', async () => {
    const s = await setup({
      model: old,
      deps: {
        bundledRuntime: () => {
          throw new Error('missing');
        },
      },
    });
    const html = await s.read();
    await s.ir.refreshRuntimeOnOpen(s.slug);
    expect(await s.read()).toBe(html);
  });

  it('swallows a failed write; the document keeps working', async () => {
    const log = logger();
    const s = await setup({ model: old, deps: { bundledRuntime: () => NEW_RUNTIME, log } });
    vi.spyOn(s.lib, 'refreshRuntime').mockRejectedValueOnce(new Error('disk full'));
    await expect(s.ir.refreshRuntimeOnOpen(s.slug)).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith('document.runtime-refresh-skipped', { slug: s.slug, kind: 'Error' });
  });
});
