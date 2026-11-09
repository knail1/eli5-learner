import { describe, expect, it } from 'vitest';
import { splitSentences, stripMarkdown, wordCount } from '../../../../../src/main/llm/lint/sentences';

describe('sentence splitter (02 §12.2)', () => {
  it('strips inline Markdown', () => {
    expect(stripMarkdown('A **bold** _word_ and `code` [link](https://x.y).')).toBe('A bold word and code link.');
  });

  it('splits at sentence ends but not at abbreviations, initials or decimals', () => {
    expect(splitSentences('Example Widgets Inc. sells widgets. Growth was 3.5 percent! Why? Ask Dr. Smith.')).toEqual([
      'Example Widgets Inc. sells widgets.',
      'Growth was 3.5 percent!',
      'Why?',
      'Ask Dr. Smith.',
    ]);
    expect(splitSentences('Costs rose, e.g. Rent and food. J. Smith agreed.')).toEqual([
      'Costs rose, e.g. Rent and food.',
      'J. Smith agreed.',
    ]);
    expect(splitSentences('He said "Stop." Then he left.')).toEqual(['He said "Stop."', 'Then he left.']);
    expect(splitSentences('')).toEqual([]);
  });

  it('ends a sentence at "No." and at a letter before a sentence opener (audit round 3)', () => {
    expect(splitSentences('Is it hot? No. It is cold.')).toEqual(['Is it hot?', 'No.', 'It is cold.']);
    expect(splitSentences('We chose plan A. Then we built it.')).toEqual(['We chose plan A.', 'Then we built it.']);
    expect(splitSentences('See No. 5 on the list. It is red.')).toEqual(['See No. 5 on the list.', 'It is red.']);
    expect(splitSentences('The book is by J. R. Tolkien. It is long.')).toEqual([
      'The book is by J. R. Tolkien.',
      'It is long.',
    ]);
  });

  it('counts words with letters or digits only', () => {
    expect(wordCount('The plan - in 2 steps - works.')).toBe(6);
  });
});
