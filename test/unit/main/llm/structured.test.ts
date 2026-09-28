import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLMError } from '../../../../src/main/llm/errors';
import {
  DRAFT_SCHEMAS,
  draftJsonSchema,
  stripNullProperties,
  type DraftSchemaName,
} from '../../../../src/main/llm/schemas/draft';
import { generateStructured, OutputTruncated, repairPrompt, validateDraft } from '../../../../src/main/llm/structured';
import { FakeProvider } from '../../../../src/main/llm/testing/fake';
import type { PromptId } from '../../../../src/main/llm/types';
import { REPO } from './helpers';

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
    const e = await generateStructured({ provider: fake, schema: 'SummaryDraft', request: req('summary') }).catch(
      (x: unknown) => x,
    );
    expect((e as LLMError).kind).toBe('invalid_output');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('non-JSON text goes to repair; refusal and max_tokens do not', async () => {
    const ok = await generateStructured({
      provider: new FakeProvider({
        responses: { summary: ['"not an object"', { title: 't', topicSlugHint: 's', summary: 'x' }] },
      }),
      schema: 'SummaryDraft',
      request: req('summary'),
    });
    expect(ok.repaired).toBe(true);
    const trunc = await generateStructured({
      provider: new FakeProvider({ responses: { summary: '{"title":"t"}' }, truncateTask: 'summary' }),
      schema: 'SummaryDraft',
      request: req('summary'),
    }).catch((x: unknown) => x);
    expect(trunc).toBeInstanceOf(OutputTruncated);
  });

  it('repair prompt lists at most 20 errors and asks for JSON only', () => {
    const p = repairPrompt(Array.from({ length: 25 }, (_, i) => `e${i}`));
    expect(p).toContain('- e19');
    expect(p).not.toContain('- e20');
    expect(p).toContain('...and 5 more');
    expect(p.endsWith('Return corrected JSON only.')).toBe(true);
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
      'section-eli5-tab': 'DocumentDraftTab',
      summary: 'SummaryDraft',
      'merge-match': 'MergeMatchDraft',
    };
    for (const [id, schema] of Object.entries(schemaFor)) {
      const r = validateDraft(schema, script.responses[id]);
      expect(r.ok ? [] : r.errors, id).toEqual([]);
      expect(r.ok && r.dropped).toEqual([]);
    }
  });
});
