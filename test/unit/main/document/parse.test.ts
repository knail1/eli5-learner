import { describe, expect, it } from 'vitest';
import {
  DocumentFormatError,
  locateModelJson,
  locateSection,
  parseDocument,
  renderDocument,
  spliceSection,
} from '../../../../src/main/document';
import { fixtureDocument } from '../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';

const doc = fixtureDocument('with-tab');
const html = renderDocument(doc.model, doc.assets, { runtime: STUB_RUNTIME, theme: doc.theme });

function formatCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DocumentFormatError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('parseDocument (07 §8)', () => {
  it('recovers the model, asset bytes, theme and runtime', () => {
    const p = parseDocument(html);
    expect(p.model).toEqual(doc.model);
    expect([...p.assets.keys()]).toEqual([...doc.assets.keys()]);
    for (const [k, v] of doc.assets) expect(Buffer.from(p.assets.get(k) ?? []).equals(Buffer.from(v))).toBe(true);
    expect(p.runtime).toEqual(STUB_RUNTIME);
    expect(p.theme.footer).toBe('Made with ELI5 Learner');
  });

  it('render(parse(render(m))) === render(m) for every fixture, including themed', () => {
    for (const name of ['full', 'placeholder', 'themed', 'with-tab'] as const) {
      const d = fixtureDocument(name);
      const once = renderDocument(d.model, d.assets, { runtime: STUB_RUNTIME, theme: d.theme });
      const p = parseDocument(once);
      expect(renderDocument(p.model, p.assets, { runtime: p.runtime, theme: p.theme })).toBe(once);
    }
  });

  it('throws no_model, invalid_model and bad_version', () => {
    expect(formatCode(() => parseDocument('<!doctype html><html><body>hi</body></html>'))).toBe('no_model');
    const swap = (json: string): string =>
      html.replace(/(<script type="application\/json" id="eli5-model">)[^]*?(<\/script>)/, `$1${json}$2`);
    expect(formatCode(() => parseDocument(swap('{not json')))).toBe('invalid_model');
    expect(formatCode(() => parseDocument(swap('{"formatVersion":1}')))).toBe('invalid_model');
    expect(formatCode(() => parseDocument(swap('{"formatVersion":2}')))).toBe('bad_version');
  });

  it('rejects a model whose section ids are malformed', () => {
    const bad = structuredClone(doc.model);
    const s = bad.tabs[0]?.sections[0];
    if (s) (s as { id: string }).id = 'sec-indepth-XYZ';
    const out = renderDocument(bad, doc.assets, { runtime: STUB_RUNTIME });
    expect(formatCode(() => parseDocument(out))).toBe('invalid_model');
  });
});

describe('locate / splice primitives (08 §6.4)', () => {
  it('locates a section by id exactly', () => {
    const id = doc.model.tabs[1]?.sections[0]?.id ?? '';
    const span = locateSection(html, id);
    expect(span).toBeDefined();
    const text = html.slice(span?.start, span?.end);
    expect(text.startsWith(`<section id="${id}" data-section-id="${id}"`)).toBe(true);
    expect(text.endsWith('</section>')).toBe(true);
    expect(locateSection(html, 'sec-indepth-00000000')).toBeUndefined();
    expect(locateSection(html, 'tab-indepth')).toBeUndefined();
  });

  it('locates the model JSON body', () => {
    const span = locateModelJson(html);
    expect(JSON.parse(html.slice(span?.start, span?.end))).toEqual(JSON.parse(JSON.stringify(doc.model)));
  });

  it('splices a changed section so the result equals a full re-render', () => {
    const next = structuredClone(doc.model);
    const target = next.tabs[1]?.sections[1];
    if (!target) throw new Error('fixture');
    target.heading = 'A new heading';
    target.blocks = [{ type: 'paragraph', md: 'New **content**.' }];
    next.updatedAt = '2026-09-28T00:00:00.000Z';
    const spliced = spliceSection(html, next, target.id, doc.assets);
    expect(spliced).toBe(renderDocument(next, doc.assets, { runtime: STUB_RUNTIME, theme: doc.theme }));
  });
});
