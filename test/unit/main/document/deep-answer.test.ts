import { describe, expect, it } from 'vitest';
import {
  DEEP_ANSWER_BADGE_TEXT,
  DocumentModelSchema,
  MAX_QA_PARAGRAPH,
  canonicalJson,
  cleanAnswerWeb,
  deepAnswerBadge,
  deeperAnswerBadge,
  insertAnswer,
  linksToText,
  parseDocument,
  renderDocument,
  tabsForDeepAsk,
  webPageLabel,
  type DocumentModel,
  type QaDocBlock,
  type SectionId,
} from '../../../../src/main/document';
import { renderInline } from '../../../../src/main/document/inline-md';
import { fixtureDocument } from '../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { assertValidDocument } from '../../../helpers/doc-validity';
import { SeededIdSource } from '../../../helpers/ids';

/** Deep answer boxes in the document (07 §3, §6.5) and the Deep Ask material (08 §6.9). */

const LATER = '2026-09-28T10:00:00.000Z';
const base = fixtureDocument('with-tab');
const firstId = (m: DocumentModel): SectionId => {
  const id = m.tabs[0]?.sections[0]?.id;
  if (!id) throw new Error('no section');
  return id;
};
const answer = {
  question: 'What does the report say?',
  topic: 'The report',
  quote: 'judges every channel',
  paragraphs: ['Search took most of the spend, see [the report](https://example.com/r).'],
};
const boxOf = (m: DocumentModel, qaId: string): QaDocBlock => {
  const b = m.tabs.flatMap((t) => t.sections.flatMap((s) => s.blocks)).find((x) => x.type === 'qa' && x.id === qaId);
  if (b?.type !== 'qa') throw new Error('no box');
  return b;
};
const render = (m: DocumentModel): string =>
  renderDocument(m, base.assets, { runtime: STUB_RUNTIME, theme: base.theme });

describe('linksToText (08 §6.9 decision 10)', () => {
  it.each([
    ['See [the report](https://example.com/r).', 'See the report.'],
    ['[a](x) and [b](mailto:b@example.com)', 'a and b'],
    ['nested [[a](b)](c)', 'nested a'],
    ['escaped \\[not](a link) stays', 'escaped \\[not](a link) stays'],
    ['code `[x](y)` stays', 'code `[x](y)` stays'],
    ['**[bold](u)** text', '**bold** text'],
    ['no links here', 'no links here'],
  ])('%s', (input, out) => {
    expect(linksToText(input)).toBe(out);
  });

  it('never leaves a link behind, whatever the nesting', () => {
    const parse = (s: string) => /\[[^\]\n]+\]\([^()\s]+\)/.exec(s.replace(/\\./g, '').replace(/`[^`]*`/g, ''));
    for (const s of ['[[[a](b)](c)](d)', '[[x](y)](z) [p](q)', '[a]([b](c))']) {
      expect(parse(linksToText(s))).toBeNull();
    }
  });
});

describe('linksToText agrees with the renderer (08 §6.9 decision 10)', () => {
  const EVIL = 'https://evil.example/x';
  it.each([
    ['backtick inside bold', `**a\`b**[click](${EVIL})\`c`],
    ['backtick inside italic', `*a\`b*[click](${EVIL}) \`c`],
    ['backtick inside both', `***a\`b***[click](${EVIL})\`c`],
  ])('%s: no live link survives', (_name, input) => {
    expect(renderInline(input)).toContain('evil.example');
    const out = linksToText(input);
    expect(renderInline(out)).not.toContain('<a');
    expect(renderInline(out)).not.toContain('evil.example');
    expect(renderInline(out)).toContain('click');
  });
});

describe('insertAnswer with depth (07 §7.1, 08 §6.9)', () => {
  it('stores depth and sources and turns links into text', () => {
    const id = firstId(base.model);
    const { model, qaId } = insertAnswer(base.model, id, 0, { ...answer, depth: 'deep', sources: 'all' }, LATER, {
      idSource: new SeededIdSource(3),
    });
    expect(boxOf(model, qaId)).toMatchObject({
      depth: 'deep',
      sources: 'all',
      paragraphs: ['Search took most of the spend, see the report.'],
    });
  });

  it('strips links before the length cap, so the text gets the room', () => {
    const id = firstId(base.model);
    const long = `${'w '.repeat(590)}[x](https://example.com/${'p'.repeat(100)})`;
    const { model, qaId } = insertAnswer(base.model, id, 0, { ...answer, paragraphs: [long], depth: 'deep' }, LATER, {
      idSource: new SeededIdSource(3),
    });
    const [p] = boxOf(model, qaId).paragraphs;
    expect(p?.endsWith('x')).toBe(true);
    expect(p?.length).toBeLessThanOrEqual(MAX_QA_PARAGRAPH);
  });

  it('a length cut that drops the closing backtick of a code span cannot expose the link inside', () => {
    const id = firstId(base.model);
    const p0 = `\`[x](https://evil.example) ${'y'.repeat(1300)}\``;
    const { model, qaId } = insertAnswer(base.model, id, 0, { ...answer, paragraphs: [p0], depth: 'deep' }, LATER, {
      idSource: new SeededIdSource(3),
    });
    const [p] = boxOf(model, qaId).paragraphs;
    expect(p?.length).toBeLessThanOrEqual(MAX_QA_PARAGRAPH);
    expect(renderInline(p ?? '')).not.toContain('<a');
    expect(render(model)).not.toContain('href="https://evil.example');
  });

  it('a quick answer keeps its links and gets no depth or sources', () => {
    const id = firstId(base.model);
    const { model, qaId } = insertAnswer(base.model, id, 0, { ...answer, sources: 'all' }, LATER, {
      idSource: new SeededIdSource(3),
    });
    const box = boxOf(model, qaId);
    expect(box.paragraphs).toEqual(answer.paragraphs);
    expect(box).not.toHaveProperty('depth');
    expect(box).not.toHaveProperty('sources');
  });
});

describe('deep answer box render (07 §6.5)', () => {
  const deepModel = (sources?: QaDocBlock['sources']) => {
    const id = firstId(base.model);
    return insertAnswer(base.model, id, 0, { ...answer, depth: 'deep', ...(sources ? { sources } : {}) }, LATER, {
      idSource: new SeededIdSource(9),
    });
  };

  it.each(['all', 'excerpts', 'none'] as const)('mode %s: badge before .qa-a, outside it, marked noact', (mode) => {
    const { model, qaId } = deepModel(mode);
    const html = render(model);
    const start = html.indexOf(`<aside class="qa qa-deep" id="${qaId}" aria-label="Deep answer to a reader question">`);
    expect(start).toBeGreaterThan(-1);
    const box = html.slice(start, html.indexOf('</aside>', start));
    expect(box).toContain('<span class="qa-cap">You asked</span>');
    const badge = `<p class="qa-badge" data-eli5-noact>Deep answer · ${DEEP_ANSWER_BADGE_TEXT[mode]}</p>`;
    expect(box).toContain(`</details>${badge}<div class="qa-a">`);
    const qaA = box.slice(box.indexOf('<div class="qa-a">'));
    expect(qaA).not.toContain('qa-badge');
    assertValidDocument(html);
  });

  it('round-trips through parseDocument (postCheck and the D12 refresh compare canonical JSON)', () => {
    const { model, qaId } = deepModel('excerpts');
    const back = parseDocument(render(model)).model;
    expect(boxOf(back, qaId)).toMatchObject({ depth: 'deep', sources: 'excerpts' });
    expect(canonicalJson(back)).toBe(canonicalJson(model));
  });

  it('a non-deep box renders exactly as before (no badge, plain class and label)', () => {
    const asked = fixtureDocument('asked');
    const html = renderDocument(asked.model, asked.assets, { runtime: STUB_RUNTIME, theme: asked.theme });
    expect(html).not.toContain('qa-badge');
    expect(html).not.toContain('qa-deep');
    expect(html).toContain('<aside class="qa" id="');
    expect(html).toContain('aria-label="Answer to a reader question"');
  });

  it('a deep box never renders a link, even when its stored text holds one (hand-edited file)', () => {
    const { model, qaId } = deepModel('all');
    const tabs = model.tabs.map((t) => ({
      ...t,
      sections: t.sections.map((s) => ({
        ...s,
        blocks: s.blocks.map((b) =>
          b.type === 'qa' && b.id === qaId ? { ...b, paragraphs: ['See [here](https://evil.example/x).'] } : b,
        ),
      })),
    }));
    const html = render({ ...model, tabs });
    const start = html.indexOf(`id="${qaId}"`);
    const box = html.slice(start, html.indexOf('</aside>', start));
    expect(box).toContain('See here.');
    expect(box).not.toContain('<a');
  });

  it('badge text helper', () => {
    expect(deepAnswerBadge('all')).toBe('Deep answer · checked against the original sources');
    expect(deepAnswerBadge(undefined)).toBe('Deep answer');
  });
});

describe('qa schema (07 §3)', () => {
  const qa = (over: Record<string, unknown>) => {
    const { model, qaId } = insertAnswer(base.model, firstId(base.model), 0, answer, LATER, {
      idSource: new SeededIdSource(4),
    });
    const tabs = model.tabs.map((t) => ({
      ...t,
      sections: t.sections.map((s) => ({
        ...s,
        blocks: s.blocks.map((b) => (b.type === 'qa' && b.id === qaId ? { ...b, ...over } : b)),
      })),
    }));
    return { model: { ...model, tabs }, qaId };
  };

  it('accepts depth deep with each source mode, and an old box without them', () => {
    for (const over of [
      {},
      { depth: 'deep' },
      ...['all', 'excerpts', 'none'].map((m) => ({ depth: 'deep', sources: m })),
    ]) {
      expect(DocumentModelSchema.safeParse(qa(over).model).success).toBe(true);
    }
  });

  it('drops an unknown depth, source mode or reach instead of failing the parse (08 §6.10 item 9)', () => {
    const boxOfParsed = (over: Record<string, unknown>): Record<string, unknown> => {
      const parsed = DocumentModelSchema.parse(qa(over).model);
      const box = parsed.tabs.flatMap((t) => t.sections.flatMap((s) => s.blocks)).find((b) => b.type === 'qa');
      return box as unknown as Record<string, unknown>;
    };
    expect(boxOfParsed({ depth: 'quick' }).depth).toBeUndefined();
    expect(boxOfParsed({ depth: 'deepest', sources: 'all' }).depth).toBeUndefined();
    expect(boxOfParsed({ depth: 'deep', sources: 'some' })).toMatchObject({ depth: 'deep' });
    expect(boxOfParsed({ depth: 'deep', sources: 'some' }).sources).toBeUndefined();
    expect(boxOfParsed({ depth: 'deeper', reach: 'moon' }).reach).toBeUndefined();
    expect(boxOfParsed({ depth: 'deeper', reach: 'web' })).toMatchObject({ depth: 'deeper', reach: 'web' });
    // A page list with a non-http URL or a fragment is not a valid stored list: it is dropped whole.
    expect(boxOfParsed({ depth: 'deeper', web: [{ title: 'x', url: 'javascript:alert(1)' }] }).web).toBeUndefined();
    expect(boxOfParsed({ depth: 'deeper', web: [{ title: 'x', url: 'https://a.example/p#f' }] }).web).toBeUndefined();
  });
});

describe('tabsForDeepAsk (08 §6.9)', () => {
  it('every tab in document order, content sections only, no answer boxes', () => {
    const asked = fixtureDocument('asked').model;
    const tabs = tabsForDeepAsk(asked);
    expect(tabs.map((t) => t.key)).toEqual(asked.tabs.map((t) => t.key));
    for (const [i, t] of asked.tabs.entries()) {
      expect(tabs[i]).toMatchObject({ key: t.key, kind: t.kind, label: t.label });
      expect(tabs[i]?.sections.map((s) => s.heading)).toEqual(
        t.sections.filter((s) => s.kind === 'content').map((s) => s.heading),
      );
    }
    expect(asked.tabs.some((t) => t.sections.some((s) => s.kind === 'references'))).toBe(true);
    expect(asked.tabs.some((t) => t.sections.some((s) => s.blocks.some((b) => b.type === 'qa')))).toBe(true);
    expect(JSON.stringify(tabs)).not.toContain('"qa"');
  });

  it('leaves out the ELI5 placeholder (no real explanation in it)', () => {
    const ph = fixtureDocument('placeholder').model;
    const placeholderTab = ph.tabs.find((t) => t.placeholder);
    expect(placeholderTab).toBeDefined();
    expect(tabsForDeepAsk(ph).map((t) => t.key)).not.toContain(placeholderTab?.key);
  });
});

describe('deeper answer boxes (07 §6.5, 08 §6.10)', () => {
  const web = [
    { title: 'Guide', url: 'https://example.org/guides/roas/?ref=x#top' },
    { title: 'Bad', url: 'javascript:alert(1)' },
    { title: '  ', url: 'https://www.example.net/' },
    { title: 'Guide again', url: 'https://example.org/guides/roas/?ref=x' },
  ];

  it('insertAnswer stores depth, sources, reach and the cleaned page list; links become text', () => {
    const id = firstId(base.model);
    const { model, qaId } = insertAnswer(
      base.model,
      id,
      0,
      { ...answer, depth: 'deeper', sources: 'excerpts', reach: 'web', web },
      LATER,
      { idSource: new SeededIdSource(9) },
    );
    expect(boxOf(model, qaId)).toMatchObject({
      depth: 'deeper',
      sources: 'excerpts',
      reach: 'web',
      paragraphs: ['Search took most of the spend, see the report.'],
      web: [
        { title: 'Guide', url: 'https://example.org/guides/roas/?ref=x' },
        { title: 'www.example.net', url: 'https://www.example.net/' },
      ],
    });
    // Round trip: parse(render(model)) keeps every field; the markup has no link.
    const html = render(model);
    const back = parseDocument(html).model;
    expect(canonicalJson(boxOf(back, qaId))).toBe(canonicalJson(boxOf(model, qaId)));
    assertValidDocument(html);
    const aside = html.slice(html.indexOf(`id="${qaId}"`), html.indexOf('</aside>', html.indexOf(`id="${qaId}"`)));
    expect(aside).not.toContain('<a');
    expect(aside).toContain('<li>Guide — example.org/guides/roas</li><li>www.example.net — www.example.net</li>');
  });

  it('a deep box ignores reach and web; a quick box gets none of them', () => {
    const id = firstId(base.model);
    const deep = insertAnswer(base.model, id, 0, { ...answer, depth: 'deep', reach: 'web', web }, LATER, {
      idSource: new SeededIdSource(10),
    });
    expect(boxOf(deep.model, deep.qaId)).not.toHaveProperty('reach');
    expect(boxOf(deep.model, deep.qaId)).not.toHaveProperty('web');
    const quick = insertAnswer(base.model, id, 0, { ...answer, reach: 'web', web }, LATER, {
      idSource: new SeededIdSource(11),
    });
    expect(boxOf(quick.model, quick.qaId)).not.toHaveProperty('depth');
    expect(boxOf(quick.model, quick.qaId)).not.toHaveProperty('web');
  });

  it('cleanAnswerWeb keeps at most 6 http(s) pages once each', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `P${String(i)}`,
      url: `https://example.org/${String(i)}`,
    }));
    expect(cleanAnswerWeb(many)).toHaveLength(6);
    expect(cleanAnswerWeb([{ title: 'x', url: 'ftp://example.org/' }])).toEqual([]);
  });

  it('badges come from reach (never the model); a web answer without pages does not point at a list', () => {
    expect(deeperAnswerBadge('material')).toBe('Deeper answer · found in the document and its original sources');
    expect(deeperAnswerBadge('web')).toBe('Deeper answer · includes information from the web (pages listed below)');
    expect(deeperAnswerBadge('web', false)).toBe('Deeper answer · includes information from the web');
    expect(deeperAnswerBadge('general', false)).toBe(
      "Deeper answer · includes the AI's general knowledge, not from the document or the web",
    );
    // A general answer that also lists pages says both (seen on a real call: reach general + 3 pages).
    expect(deeperAnswerBadge('general', true)).toBe(
      "Deeper answer · includes information from the web (pages listed below) and the AI's general knowledge",
    );
    expect(deeperAnswerBadge(undefined)).toBe('Deeper answer');
  });

  it('webPageLabel shows host and path only', () => {
    expect(webPageLabel('https://Example.org/a/b/?q=1#f')).toBe('example.org/a/b');
    expect(webPageLabel('https://example.org/')).toBe('example.org');
    expect(webPageLabel('http://example.org:8080/x')).toBe('example.org:8080/x');
    expect(webPageLabel('not a url')).toBe('');
  });
});
