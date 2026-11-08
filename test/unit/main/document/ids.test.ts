import { describe, expect, it } from 'vitest';
import { IdExhaustedError, QA_ID_RE, mintQaId } from '../../../../src/main/document';
import { SeededIdSource } from '../../../helpers/ids';

describe('mintQaId (07 §7.1)', () => {
  it("mints 'q-' + 8 hex", () => {
    const src = new SeededIdSource(3);
    for (let i = 0; i < 50; i++) expect(mintQaId(src, new Set())).toMatch(QA_ID_RE);
  });

  it('redraws on a taken id and gives up after the draw limit', () => {
    const first = mintQaId(new SeededIdSource(3), new Set());
    const next = mintQaId(new SeededIdSource(3), new Set([first]));
    expect(next).not.toBe(first);
    expect(next).toMatch(QA_ID_RE);
    expect(() => mintQaId({ hex: (n) => '0'.repeat(n) }, new Set(['q-00000000']))).toThrow(IdExhaustedError);
  });
});
