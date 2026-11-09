import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLMError } from '../../../../src/main/llm/errors';
import {
  DRAFT_SCHEMAS,
  draftJsonSchema,
  draftPromptSchema as draftPromptSchemaText,
  stripNullProperties,
  usesPromptedJson,
  type DraftSchemaName,
} from '../../../../src/main/llm/schemas/draft';
import {
  generateStructured,
  listErrors,
  OutputTruncated,
  usageOf,
  validateDraft,
} from '../../../../src/main/llm/structured';
import { FakeProvider } from '../../../../src/main/llm/testing/fake';
import type { PromptId } from '../../../../src/main/llm/types';
import { REPO } from './helpers';
import { defaultCatalogue, structuredTexts } from '../../../helpers/prompts';

const para = (md = 'p'): object => ({ type: 'paragraph', md });
const tab = (blocks: object[][]): object => ({
  kind: 'indepth',
  title: 'T',
  sections: blocks.map((b, i) => ({ heading: `H${i}`, blocks: b })),
});
const badChart = {
  type: 'chart',
  chart: { kind: 'bar', title: 'c', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] },
};

describe('validateDraft semantic checks and block dropping (02 §10.1)', () => {
  it('drops a malformed block when ≤ 20% fail and the rest is valid', () => {
    const r = validateDraft(
      'DocumentDraftTab',
      tab([
        [para(), para(), badChart],
        [para(), para()],
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dropped).toEqual(['sections[0].blocks[2]']);
      expect(r.data.sections[0]?.blocks).toHaveLength(2);
    }
  });

  it('fails when more than 20% of blocks fail, or a section would be emptied', () => {
    expect(
      validateDraft(
        'DocumentDraftTab',
        tab([
          [para(), badChart],
          [badChart, para()],
        ]),
      ).ok,
    ).toBe(false);
    const many = Array.from({ length: 9 }, () => para());
    const r = validateDraft('DocumentDraftTab', tab([[badChart], many]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('values');
  });

  it('checks figure labels, table widths and SVG shape/size', () => {
    const fig = { type: 'figure', imageLabel: 'shot.png', caption: 'c' };
    expect(
      validateDraft('SectionDraft', { heading: 'h', blocks: [fig] }, { imageLabels: new Set(['shot.png']) }).ok,
    ).toBe(true);
    const errs = (b: object): string[] => {
      const r = validateDraft('SectionDraft', { heading: 'h', blocks: [b] });
      return r.ok ? [] : r.errors;
    };
    expect(errs(fig)[0]).toContain('not a supplied image label');
    expect(errs({ type: 'table', header: ['a', 'b'], rows: [['1']] })[0]).toContain('1 cells');
    expect(errs({ type: 'diagram', title: 't', alt: 'a', svg: '<div/>' })[0]).toContain('<svg');
    expect(errs({ type: 'diagram', title: 't', alt: 'a', svg: `<svg>${'x'.repeat(100 * 1024)}</svg>` })[0]).toContain(
      '100 KB',
    );
  });

  it('strips strict-mode nulls for optional fields but keeps null chart values', () => {
    const r = validateDraft('DocumentDraftTab', {
      kind: 'indepth',
      title: 'T',
      dek: null,
      sections: [
        {
          heading: 'H',
          blocks: [
            {
              type: 'chart',
              chart: {
                kind: 'line',
                title: 't',
                subtitle: null,
                categories: ['a', 'b'],
                series: [{ name: 's', values: [1, null] }],
                highlight: null,
              },
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(stripNullProperties({ a: null, b: [null, { c: null }] })).toEqual({ b: [null, {}] });
  });

  it('drops malformed chart candidates from chunk notes', () => {
    const r = validateDraft('ChunkNotes', {
      notes: 'n',
      keyFacts: [],
      tables: [],
      chartCandidates: [badChart.chart],
      jargon: [],
      sourceRefs: [],
    });
    expect(r.ok && r.data.chartCandidates).toEqual([]);
  });
});

describe('chart validation is structural only (02 §10.1)', () => {
  const chart = (c: object): object => ({
    type: 'chart',
    chart: { kind: 'bar', title: 'Sales rose', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }], ...c },
  });
  const errors = (c: object): string[] => {
    const r = validateDraft('SectionDraft', { heading: 'H', blocks: [chart(c)] });
    return r.ok ? [] : r.errors;
  };

  it('never asks for a repair for a blank title or duplicate categories (fixed in code, 07 §5.2)', () => {
    expect(errors({ title: '  ' })).toEqual([]);
    expect(errors({ categories: ['a', 'a'] })).toEqual([]);
    expect(errors({ kind: 'line', title: '', categories: ['a', 'a'] })).toEqual([]);
    // A pie with a negative value is normalized to a bar chart (07 §5.2), never repaired.
    expect(errors({ kind: 'pie', series: [{ name: 's', values: [1, -2] }] })).toEqual([]);
    // Structure still counts: a series shorter than the categories asks for a repair.
    expect(errors({ series: [{ name: 's', values: [1] }] })).toHaveLength(1);
  });

  it('keeps chunk-note chart candidates with a blank title or repeated categories', () => {
    const r = validateDraft('ChunkNotes', {
      notes: 'n',
      keyFacts: [],
      tables: [],
      chartCandidates: [{ kind: 'bar', title: '', categories: ['a', 'a'], series: [{ name: 's', values: [1, 2] }] }],
      jargon: [],
      sourceRefs: [],
    });
    expect(r.ok && r.data.chartCandidates).toHaveLength(1);
  });

  it('accepts presentation problems the renderer normalizes: shouting, many series, sparse values, annotations', () => {
    expect(
      errors({
        title: 'SALES ROSE EVERYWHERE',
        categories: ['a', 'b', 'c', 'd', 'e'],
        series: Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, values: [i, null, null, null, 1] })),
        annotations: [
          { category: 'zz', text: 'x'.repeat(300) },
          { category: 'a', text: 'b' },
          { category: 'b', text: 'c' },
          { category: 'c', text: 'd' },
        ],
        footnote: 'f'.repeat(500),
        order: 'value',
      }),
    ).toEqual([]);
    // Scatter x values may repeat; pies may hold nulls.
    expect(errors({ kind: 'scatter', categories: ['1', '1'] })).toEqual([]);
    expect(errors({ kind: 'pie', series: [{ name: 's', values: [1, null] }] })).toEqual([]);
  });

  it('chart candidates use the narrower ChartCandidate shape in the native ChunkNotes schema', () => {
    const json = JSON.stringify(draftJsonSchema('ChunkNotes'));
    expect(json).not.toContain('annotations');
    expect(json).not.toContain('footnote');
    expect(draftPromptSchemaText('SectionDraft')).toContain('annotations');
  });
});

describe('SectionAnswerDraft (08 Ask)', () => {
  it('goes through native strict output with a closed topic + paragraphs object', () => {
    expect(usesPromptedJson('SectionAnswerDraft')).toBe(false);
    const s = draftJsonSchema('SectionAnswerDraft');
    expect(s).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { topic: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } },
    });
    expect([...(s.required as string[])].sort()).toEqual(['paragraphs', 'topic']);
  });

  it('accepts 1-4 paragraphs and rejects 5, empty or blank ones and a short or blank topic', () => {
    const ok = validateDraft('SectionAnswerDraft', { topic: 'safety stock', paragraphs: ['a', 'b'] });
    expect(ok.ok && ok.data.paragraphs).toEqual(['a', 'b']);
    const five = validateDraft('SectionAnswerDraft', { topic: 'safety stock', paragraphs: ['a', 'b', 'c', 'd', 'e'] });
    expect(five.ok).toBe(false);
    expect(validateDraft('SectionAnswerDraft', { topic: 'safety stock', paragraphs: [] }).ok).toBe(false);
    expect(validateDraft('SectionAnswerDraft', { topic: 'safety stock', paragraphs: [''] }).ok).toBe(false);
    expect(validateDraft('SectionAnswerDraft', { topic: 'ab', paragraphs: ['a'] }).ok).toBe(false);
    expect(validateDraft('SectionAnswerDraft', { topic: 'safety stock', paragraphs: ['a', ' \n '] }).ok).toBe(false);
    expect(validateDraft('SectionAnswerDraft', { topic: '    ', paragraphs: ['a'] }).ok).toBe(false);
    expect(JSON.stringify(draftJsonSchema('SectionAnswerDraft'))).not.toContain('pattern');
    expect(validateDraft('SectionAnswerDraft', { topic: 'x'.repeat(49), paragraphs: ['a'] }).ok).toBe(false);
  });
});

describe('strict JSON Schema export', () => {
  it.each(Object.keys(DRAFT_SCHEMAS).map((n) => [n as DraftSchemaName]))(
    '%s: every object is closed and fully required',
    (name) => {
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n !== 'object' || n === null) return;
        const o = n as Record<string, unknown>;
        for (const k of ['oneOf', 'minItems', 'maxItems', 'maxLength', 'minimum', 'maximum', 'const'])
          expect(o).not.toHaveProperty(k);
        if (o.type === 'object') {
          expect(o.additionalProperties).toBe(false);
          expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
        }
        Object.values(o).forEach(walk);
      };
      walk(draftJsonSchema(name));
    },
  );
});

describe('generateStructured (02 §10.1)', () => {
  const req = (taskId: PromptId) => ({
    taskId,
    system: 's',
    messages: [{ role: 'user' as const, text: 'u' }],
    maxOutputTokens: 100,
  });

  it('second validation failure is invalid_output after exactly one repair', async () => {
    const fake = new FakeProvider({ responses: { summary: ['{"title":1}', '{"still":"bad"}'] } });
    const e = await generateStructured({
      ...structuredTexts(),
      provider: fake,
      schema: 'SummaryDraft',
      request: req('summary'),
    }).catch((x: unknown) => x);
    expect((e as LLMError).kind).toBe('invalid_output');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it("a repair send that throws still carries the first call's billed tokens (D25)", async () => {
    // Call 0 returns invalid JSON (billed); call 1, the repair, fails with a network error.
    const errors = { summary: [undefined, 'network'] as unknown as 'network'[] };
    const fake = new FakeProvider({ responses: { summary: '{"title":1}' }, errors });
    const e = (await generateStructured({
      ...structuredTexts(),
      provider: fake,
      schema: 'SummaryDraft',
      request: req('summary'),
    }).catch((x: unknown) => x)) as LLMError;
    expect(e.kind).toBe('network');
    expect(fake.calls).toHaveLength(2);
    expect(usageOf(e)?.outputTokens).toBeGreaterThan(0);
    expect(usageOf(e)?.inputTokens).toBeGreaterThan(0);
  });

  it('non-JSON text goes to repair; refusal and max_tokens do not', async () => {
    const ok = await generateStructured({
      ...structuredTexts(),
      provider: new FakeProvider({
        responses: { summary: ['"not an object"', { title: 't', topicSlugHint: 's', summary: 'x' }] },
      }),
      schema: 'SummaryDraft',
      request: req('summary'),
    });
    expect(ok.repaired).toBe(true);
    const trunc = await generateStructured({
      ...structuredTexts(),
      provider: new FakeProvider({ responses: { summary: '{"title":"t"}' }, truncateTask: 'summary' }),
      schema: 'SummaryDraft',
      request: req('summary'),
    }).catch((x: unknown) => x);
    expect(trunc).toBeInstanceOf(OutputTruncated);
  });

  it('repair prompt lists at most 20 errors and asks for JSON only (json-repair fragment)', async () => {
    const p = structuredTexts().repairText(listErrors(Array.from({ length: 25 }, (_, i) => `e${i}`)));
    expect(p.startsWith('The JSON above failed validation:\n- e0\n')).toBe(true);
    expect(p).toContain('- e19');
    expect(p).not.toContain('- e20');
    expect(p).toContain('...and 5 more');
    expect(p.endsWith('Return corrected JSON only.')).toBe(true);
    // The provider receives exactly the fragment text; an empty first reply becomes "(no output)".
    const fake = new FakeProvider(
      { responses: { summary: ['EMPTY', { title: 't', topicSlugHint: 's', summary: 'x' }] } },
      { readFile: () => '' },
    );
    await generateStructured({ ...structuredTexts(), provider: fake, schema: 'SummaryDraft', request: req('summary') });
    const repair = fake.calls[1]?.messages ?? [];
    expect(repair[1]?.text).toBe(defaultCatalogue().fragment('json-no-output').text);
    expect(repair[2]?.text).toBe(structuredTexts().repairText(listErrors(['(root): output is not valid JSON'])));
  });
});

describe('default FakeProvider script (13 §6.1)', () => {
  it('has a schema-valid response for every PromptId', () => {
    const script = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/llm/default.json'), 'utf8')) as {
      responses: Record<string, unknown>;
    };
    const schemaFor: Record<PromptId, DraftSchemaName> = {
      'in-depth': 'DocumentDraftTab',
      eli5: 'DocumentDraftTab',
      glossary: 'GlossaryDraft',
      'chunk-notes': 'ChunkNotes',
      'section-expand': 'SectionDraft',
      'section-reexplain': 'SectionDraft',
      'section-analogy': 'SectionDraft',
      'section-deeper': 'SectionDraft',
      'section-revise': 'SectionDraft',
      'section-ask': 'SectionAnswerDraft',
      'section-eli5-tab': 'DocumentDraftTab',
      'selection-eli5-tab': 'DocumentDraftTab',
      summary: 'SummaryDraft',
      'merge-match': 'MergeMatchDraft',
      'photo-pick': 'PhotoPickDraft',
      'merge-weave': 'MergePlanDraft',
      ste: 'SteDraft',
      'eli5-critique': 'DocumentDraftTab',
    };
    for (const [id, schema] of Object.entries(schemaFor)) {
      const r = validateDraft(schema, script.responses[id]);
      expect(r.ok ? [] : r.errors, id).toEqual([]);
      expect(r.ok && r.dropped).toEqual([]);
    }
  });
});
