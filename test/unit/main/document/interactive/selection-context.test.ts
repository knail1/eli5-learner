import { describe, expect, it } from 'vitest';
import {
  SELECTION_CONTEXT_CHARS,
  blockIndexOfSelection,
  selectionContext,
  type DocumentModel,
} from '../../../../../src/main/document';
import { fixtureDocument } from '../../../../fixtures/documents/models';
import { sec } from './harness';

/** 08 §7.5: brief surrounding context for "ELI5 this selection" (grounding only). */

const { model } = fixtureDocument('full');

describe('selectionContext (08 §7.5)', () => {
  it('names the covered heading and the blocks just before and after the selection', () => {
    const ctx = selectionContext(model, [sec(model, 0, 0)], 'Paid search: intent is high');
    expect(ctx).toContain('Section: Why ad spend is judged by ROAS');
    expect(ctx).toMatch(/Just before the selection:\n.*judges every channel/);
    expect(ctx).toMatch(/Just after the selection:\n.*We stopped asking what a click costs/);
    expect(ctx).not.toContain('Paid search: intent is high');
  });

  it('lists every covered heading for a multi-section selection', () => {
    const ids = [sec(model, 0, 0), sec(model, 0, 1)];
    const ctx = selectionContext(
      model,
      ids,
      'A ROAS below 1 means the channel loses money. Budget shifted toward search',
    );
    expect(ctx).toContain('Sections: Why ad spend is judged by ROAS; 2. How the budget moved');
  });

  it('falls back to the opening of the first section when the selection cannot be located', () => {
    const ctx = selectionContext(model, [sec(model, 0, 0)], 'text that is nowhere in the document');
    expect(ctx).toMatch(/Section opening:\n.*judges every channel/);
  });

  it('caps each excerpt', () => {
    const first = model.tabs[0];
    if (!first) throw new Error('fixture');
    const long: DocumentModel = {
      ...model,
      tabs: [
        {
          ...first,
          sections: first.sections.map((s, j) =>
            j === 0
              ? {
                  ...s,
                  blocks: [
                    { type: 'paragraph', md: 'word '.repeat(400) },
                    { type: 'paragraph', md: 'target phrase here' },
                  ],
                }
              : s,
          ),
        },
        ...model.tabs.slice(1),
      ],
    };
    const ctx = selectionContext(long, [sec(long, 0, 0)], 'target phrase');
    const before = /Just before the selection:\n(.*)/.exec(ctx)?.[1] ?? '';
    expect(before.length).toBeLessThanOrEqual(SELECTION_CONTEXT_CHARS);
    expect(before.endsWith('…')).toBe(true);
  });
});

describe('blockIndexOfSelection (08 Ask)', () => {
  const asked = fixtureDocument('asked').model;
  const section = asked.tabs[0]?.sections[0];
  if (!section) throw new Error('fixture');
  const at = (sel: string): number | undefined => blockIndexOfSelection(asked, section, sel);

  it('returns the block where the selection ends, counting answer boxes', () => {
    expect(section.blocks.map((b) => b.type)).toEqual(['paragraph', 'qa', 'list', 'pullquote', 'callout', 'chart']);
    expect(at('judges every channel by ROAS')).toBe(0);
    expect(at('Social: cheap reach, weaker conversion')).toBe(2);
    expect(at('each dollar of spend brings back four in revenue')).toBe(1);
    expect(at('the revenue earned for each dollar spent. Paid search: intent is high')).toBe(2);
    expect(at('ROAS by channel')).toBe(5);
    expect(at('nothing like this appears anywhere')).toBeUndefined();
    expect(at('   ')).toBeUndefined();
  });

  it('falls back to the end of the selection when its start is not in the model text', () => {
    expect(at('Paid search Social Email. We stopped asking what a click costs')).toBe(3);
  });
});
