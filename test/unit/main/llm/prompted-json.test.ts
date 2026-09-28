import { describe, expect, it } from 'vitest';
import {
  DRAFT_SCHEMAS,
  draftJsonSchema,
  toStrictJsonSchema,
  usesPromptedJson,
} from '../../../../src/main/llm/schemas/draft';
import { extractJsonText, generateStructured } from '../../../../src/main/llm/structured';
import { FakeProvider } from '../../../../src/main/llm/testing/fake';
import type { GenerationRequest, GenerationResult, LLMProvider } from '../../../../src/main/llm/types';

/**
 * The API compiles output_config schemas into a grammar with a size cap and at most 16 union-typed
 * parameters. The document and section drafts (a ten-shape block union nested in sections and
 * tabs) exceed both, so they use prompted JSON: the schema goes in the system prompt and the reply
 * is parsed and validated with the same zod schemas and single repair (02 §10). Found by the first
 * real-provider run.
 */

type Json = Record<string, unknown>;

const tab = {
  kind: 'indepth',
  title: 'Example Widgets explained',
  sections: [{ heading: 'Why it matters', blocks: [{ type: 'paragraph', md: 'Revenue doubled.' }] }],
};

function req(
  taskId: GenerationRequest['taskId'],
  system = 'Write the in-depth tab.',
): Omit<GenerationRequest, 'jsonSchema'> {
  return { taskId, system, messages: [{ role: 'user', text: 'source' }], maxOutputTokens: 4000 };
}

function textProvider(text: string): LLMProvider {
  const result = async (): Promise<GenerationResult> => ({
    text,
    stopReason: 'end',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'stub',
    provider: 'claude',
    latencyMs: 0,
    attempts: 1,
  });
  const fake = new FakeProvider({ responses: {} });
  return {
    id: 'claude',
    model: 'stub',
    limits: fake.limits,
    generate: result,
    generateWithImages: result,
    testConnection: fake.testConnection.bind(fake),
  };
}

describe('prompted JSON for large drafts (02 §10)', () => {
  it('uses prompted JSON only for the document and section drafts', () => {
    expect(usesPromptedJson('DocumentDraftTab')).toBe(true);
    expect(usesPromptedJson('SectionDraft')).toBe(true);
    for (const n of ['ChunkNotes', 'GlossaryDraft', 'SummaryDraft', 'MergeMatchDraft'] as const) {
      expect(usesPromptedJson(n)).toBe(false);
    }
  });

  it('sends no jsonSchema and puts the schema contract in the system prompt', async () => {
    const fake = new FakeProvider({ responses: { 'in-depth': JSON.stringify(tab) } });
    const r = await generateStructured({ provider: fake, schema: 'DocumentDraftTab', request: req('in-depth') });
    expect(r.data.sections[0]?.heading).toBe('Why it matters');
    const sent = fake.calls[0]!;
    expect(sent.jsonSchema).toBeUndefined();
    expect(sent.system.startsWith('Write the in-depth tab.')).toBe(true);
    expect(sent.system).toMatch(/Return only one JSON object/);
    expect(sent.system).toContain('"sections"');
  });

  it('small drafts still send the strict schema natively', async () => {
    const fake = new FakeProvider({
      responses: { summary: JSON.stringify({ title: 'T', topicSlugHint: 't', summary: 'S.' }) },
    });
    await generateStructured({ provider: fake, schema: 'SummaryDraft', request: req('summary', 'Summarize.') });
    expect(fake.calls[0]!.jsonSchema?.schema).toEqual(toStrictJsonSchema(DRAFT_SCHEMAS.SummaryDraft));
    expect(fake.calls[0]!.system).toBe('Summarize.');
  });

  it.each([
    ['plain', JSON.stringify(tab)],
    ['code fence', '```json\n' + JSON.stringify(tab) + '\n```'],
    ['prose around it', 'Here is the draft:\n' + JSON.stringify(tab) + '\nDone.'],
  ])('parses a reply with %s', async (_label, reply) => {
    // FakeProvider treats non-JSON-looking strings as fixture paths, so use a raw-text stub.
    const r = await generateStructured({
      provider: textProvider(reply),
      schema: 'DocumentDraftTab',
      request: req('in-depth'),
    });
    expect(r.repaired).toBe(false);
    expect(r.data.title).toBe('Example Widgets explained');
  });

  it('repairs once when the prompted reply fails validation', async () => {
    const fake = new FakeProvider({
      responses: { 'in-depth': [JSON.stringify({ kind: 'indepth', title: 'T', sections: [] }), JSON.stringify(tab)] },
    });
    const r = await generateStructured({ provider: fake, schema: 'DocumentDraftTab', request: req('in-depth') });
    expect(r.repaired).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.jsonSchema).toBeUndefined();
  });

  it('extractJsonText finds the outermost object and leaves plain JSON alone', () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonText('```json\n{"a":{"b":2}}\n```')).toBe('{"a":{"b":2}}');
    expect(extractJsonText('note {"a":"}"} tail')).toBe('{"a":"}"}');
    expect(extractJsonText('no json here')).toBe('no json here');
  });

  it('a nullable enum in a native schema is an anyOf with a null branch (the API rejects enum + type array)', () => {
    const bad: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (typeof node !== 'object' || node === null) return;
      const o = node as Json;
      if (Array.isArray(o.type) && Array.isArray(o.enum)) bad.push(path);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    for (const name of Object.keys(DRAFT_SCHEMAS) as (keyof typeof DRAFT_SCHEMAS)[]) {
      walk(toStrictJsonSchema(DRAFT_SCHEMAS[name]), name);
    }
    expect(bad).toEqual([]);
    expect(draftJsonSchema('SummaryDraft')).toEqual(toStrictJsonSchema(DRAFT_SCHEMAS.SummaryDraft));
  });
});
