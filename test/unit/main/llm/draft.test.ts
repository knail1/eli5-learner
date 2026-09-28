import { describe, expect, it } from 'vitest';
import { DocumentDraftTabSchema, SummaryDraftSchema } from '../../../../src/main/llm/schemas/draft';

describe('DocumentDraft schemas (02 §10)', () => {
  it('accepts a minimal valid tab and rejects an empty section list', () => {
    const tab = {
      kind: 'indepth',
      title: 'T',
      sections: [{ heading: 'H', blocks: [{ type: 'paragraph', md: 'x' }] }],
    };
    expect(DocumentDraftTabSchema.safeParse(tab).success).toBe(true);
    expect(DocumentDraftTabSchema.safeParse({ ...tab, sections: [] }).success).toBe(false);
  });

  it('caps summary length at 300 chars', () => {
    const base = { title: 't', topicSlugHint: 's' };
    expect(SummaryDraftSchema.safeParse({ ...base, summary: 'a'.repeat(300) }).success).toBe(true);
    expect(SummaryDraftSchema.safeParse({ ...base, summary: 'a'.repeat(301) }).success).toBe(false);
  });
});
