import { describe, expect, it, vi } from 'vitest';
import {
  DOC_RUNTIME_VERSION,
  compareRuntimeVersions,
  parseDocument,
  runtimeFor,
  type DocRuntime,
  type SectionId,
} from '../../../../../src/main/document';
import type { DocumentPatch } from '../../../../../src/main/library';
import { STUB_RUNTIME } from '../../../../fixtures/documents/runtime';
import { fixture, req, sec, setup, type Setup } from './harness';

/** What each section job records on the version node it creates (09 §4.1), and runtimeFor (D12). */

const NEW_RUNTIME: DocRuntime = {
  js: '(function(){document.documentElement.classList.add("js","v2")})();',
  css: ':root{--paper:#fefefe}body{background:var(--paper)}',
};

/** Runs one section job and returns the patch it wrote. */
async function patchOf(s: Setup, start: () => Promise<{ jobId: string }>): Promise<DocumentPatch> {
  const spy = vi.spyOn(s.lib, 'updateDocument');
  const { jobId } = await start();
  await s.ir.runner(s.ctx(jobId).ctx);
  const patch = spy.mock.calls.at(-1)?.[1];
  if (!patch) throw new Error('no write');
  return patch;
}

describe('version change payloads (09 §4.1)', () => {
  it.each(['expand', 'reexplain', 'analogy', 'deeper'] as const)(
    '%s: the section is both the target and the undo target; topic = heading',
    async (action) => {
      const s = await setup();
      const sectionId = sec(s.model, 0, 1);
      const heading = s.model.tabs[0]?.sections[1]?.heading ?? '';
      const patch = await patchOf(s, () => s.ir.actions.regenerateSection(req(s, { action, sectionId })));
      const at = { tabKey: 'indepth', sectionId };
      expect(patch.change).toEqual({
        kind: action,
        topic: heading,
        heading,
        target: at,
        undoTarget: at,
        jobId: 'job-s1',
      });
    },
  );

  it('revise records an edit of its section', async () => {
    const s = await setup();
    const patch = await patchOf(s, () =>
      s.ir.actions.regenerateSection(req(s, { action: 'revise', note: 'Shorter please' })),
    );
    expect(patch.change).toMatchObject({
      kind: 'revise',
      target: { tabKey: 'indepth', sectionId: sec(s.model, 0, 0) },
    });
  });

  it('eli5-tab: lands on the new tab; undo lands on the source section; topic = tab label', async () => {
    const s = await setup();
    const sectionId = sec(s.model, 0, 0);
    const patch = await patchOf(s, () =>
      s.ir.actions.createSectionEli5({ slug: s.slug, tabKey: 'indepth', sectionId, selectionText: 'judges every' }),
    );
    const tab = parseDocument(await s.read()).model.tabs.at(-1);
    expect(patch.change).toEqual({
      kind: 'eli5-tab',
      topic: tab?.label,
      heading: s.model.tabs[0]?.sections[0]?.heading,
      target: { tabKey: tab?.key },
      undoTarget: { tabKey: 'indepth', sectionId },
      jobId: 'job-s1',
    });
  });

  it('eli5-selection: the same shape, kind eli5-selection', async () => {
    const s = await setup();
    const ids = [sec(s.model, 0, 0), sec(s.model, 0, 1)];
    const patch = await patchOf(s, () =>
      s.ir.actions.createSectionEli5({
        slug: s.slug,
        tabKey: 'indepth',
        sectionId: ids[0] as SectionId,
        selectionText: 'judges every channel by ROAS',
        scope: 'selection',
        sectionIds: ids,
      }),
    );
    const tab = parseDocument(await s.read()).model.tabs.at(-1);
    expect(patch.change).toMatchObject({
      kind: 'eli5-selection',
      topic: tab?.label,
      target: { tabKey: tab?.key },
      undoTarget: { tabKey: 'indepth', sectionId: ids[0] },
    });
  });

  it('closing a tab lands on the section it came from; undo lands on the restored tab', async () => {
    const s = await setup();
    const sectionId = sec(s.model, 0, 0);
    await patchOf(s, () =>
      s.ir.actions.createSectionEli5({ slug: s.slug, tabKey: 'indepth', sectionId, selectionText: 'judges every' }),
    );
    const tab = parseDocument(await s.read()).model.tabs.at(-1);
    const spy = vi.spyOn(s.lib, 'updateDocument');
    await s.ir.actions.closeTab({ slug: s.slug, tabKey: tab?.key ?? '' });
    expect(spy.mock.calls.at(-1)?.[1].change).toEqual({
      kind: 'close-tab',
      topic: tab?.label,
      target: { tabKey: 'indepth', sectionId },
      undoTarget: { tabKey: tab?.key },
    });
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes.at(-1)).toMatchObject({ kind: 'close-tab', target: { tabKey: 'indepth', sectionId } });
  });

  it('the node in the tree carries the kind, label and target', async () => {
    const s = await setup();
    await patchOf(s, () => s.ir.actions.regenerateSection(req(s, { action: 'deeper' })));
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.nodes.at(-1)).toMatchObject({
      kind: 'deeper',
      parentId: tree.nodes[0]?.id,
      target: { tabKey: 'indepth', sectionId: sec(s.model, 0, 0) },
      available: true,
    });
    expect(tree.currentId).toBe(tree.nodes.at(-1)?.id);
  });
});

describe('runtimeFor (D12)', () => {
  const g = fixture.model.generator;
  const parsed = (runtimeVersion: string) => ({
    model: { ...fixture.model, generator: { ...g, runtimeVersion } },
    runtime: STUB_RUNTIME,
  });

  it('compares dotted versions numerically', () => {
    expect(compareRuntimeVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareRuntimeVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareRuntimeVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareRuntimeVersions('1.0', '1.0.0')).toBe(0);
  });

  it('keeps the document runtime when it is current or newer', () => {
    const bundled = vi.fn(() => NEW_RUNTIME);
    for (const v of [DOC_RUNTIME_VERSION, '99.0.0']) {
      const rt = runtimeFor(parsed(v), bundled);
      expect(rt.runtime).toBe(STUB_RUNTIME);
      expect(rt.upgraded).toBe(false);
      const m = parsed(v).model;
      expect(rt.stamp(m)).toBe(m);
    }
    expect(bundled).not.toHaveBeenCalled();
  });

  it('takes the bundled runtime for an older document and stamps its version', () => {
    const rt = runtimeFor(parsed('0.9.0'), () => NEW_RUNTIME);
    expect(rt.upgraded).toBe(true);
    expect(rt.runtime).toBe(NEW_RUNTIME);
    expect(rt.stamp(parsed('0.9.0').model).generator.runtimeVersion).toBe(DOC_RUNTIME_VERSION);
  });

  it('keeps the old runtime when the bundled one is missing', () => {
    const rt = runtimeFor(parsed('0.9.0'), () => {
      throw new Error('missing');
    });
    expect(rt).toMatchObject({ runtime: STUB_RUNTIME, upgraded: false });
  });

  it('a section action on an older document renders with the bundled runtime', async () => {
    const s = await setup({
      model: { ...fixture.model, generator: { ...g, runtimeVersion: '0.9.0' } },
      deps: { bundledRuntime: () => NEW_RUNTIME },
    });
    await patchOf(s, () => s.ir.actions.regenerateSection(req(s)));
    const after = parseDocument(await s.read());
    expect(after.runtime).toEqual(NEW_RUNTIME);
    expect(after.model.generator.runtimeVersion).toBe(DOC_RUNTIME_VERSION);
  });

  it('a section action on a current document keeps its runtime', async () => {
    const s = await setup({ deps: { bundledRuntime: () => NEW_RUNTIME } });
    await patchOf(s, () => s.ir.actions.regenerateSection(req(s)));
    expect(parseDocument(await s.read()).runtime).toEqual(STUB_RUNTIME);
  });
});
