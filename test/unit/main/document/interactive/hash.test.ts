import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  mirrorTabs,
  parseDocument,
  renderDocument,
  replaceSection,
  sectionHash,
  type SectionId,
} from '../../../../../src/main/document';
import { fixtureDocument } from '../../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../../fixtures/documents/runtime';

const doc = fixtureDocument('with-tab');
const first = (): SectionId => {
  const id = doc.model.tabs[0]?.sections[0]?.id;
  if (!id) throw new Error('fixture has no section');
  return id;
};

describe('sectionHash (08 §6.3)', () => {
  it('is a sha256 hex of the canonical section, independent of key order', () => {
    const s = doc.model.tabs[0]?.sections[0];
    if (!s) throw new Error('no section');
    const h = sectionHash(s);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as typeof s;
    expect(sectionHash(reordered)).toBe(h);
  });

  it('is stable across a runtime-only re-render and changes on any mutation', () => {
    const html = renderDocument(doc.model, doc.assets, { runtime: STUB_RUNTIME, theme: doc.theme });
    const again = renderDocument(doc.model, doc.assets, {
      runtime: { js: STUB_RUNTIME.js + '/* v2 */', css: STUB_RUNTIME.css },
      theme: doc.theme,
    });
    expect(again).not.toBe(html);
    const a = parseDocument(html).model.tabs[0]?.sections[0];
    const b = parseDocument(again).model.tabs[0]?.sections[0];
    if (!a || !b) throw new Error('no section');
    expect(sectionHash(b)).toBe(sectionHash(a));
    const { model } = replaceSection(
      doc.model,
      first(),
      { heading: a.heading, blocks: [{ type: 'paragraph', md: 'Changed text for Example Widgets.' }] },
      'expand',
      '2026-09-28T10:00:00.000Z',
    );
    const c = model.tabs[0]?.sections[0];
    if (!c) throw new Error('no section');
    expect(sectionHash(c)).not.toBe(sectionHash(a));
  });
});

describe('RateLimiter (08 §6.1 step 1a)', () => {
  it('allows 10 per 60 s per key and frees slots as the window slides', () => {
    let t = 0;
    const rl = new RateLimiter({ max: 10, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 10; i++) {
      expect(rl.take('a')).toBe(true);
      t += 1000;
    }
    expect(rl.take('a')).toBe(false);
    expect(rl.take('b')).toBe(true);
    t = 60_001; // the first request (t=0) left the window
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });

  it('refunds a slot for a request that was not accepted', () => {
    const rl = new RateLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    expect(rl.take('a')).toBe(true);
    rl.refund('a');
    expect(rl.take('a')).toBe(true);
  });
});

describe('mirrorTabs (08 §6.6)', () => {
  it('maps each tab to the meta.json tab record', () => {
    const tabs = mirrorTabs(doc.model.tabs);
    expect(tabs.map((t) => t.kind)).toEqual(['indepth', 'eli5', 'section-eli5']);
    const sx = doc.model.tabs[2];
    expect(tabs[2]).toEqual({
      key: sx?.key,
      kind: 'section-eli5',
      label: sx?.label,
      sectionCount: sx?.sections.length,
      sourceSectionId: first(),
      createdAt: sx?.createdAt,
    });
    expect(tabs[0]).not.toHaveProperty('sourceSectionId');
  });
});
