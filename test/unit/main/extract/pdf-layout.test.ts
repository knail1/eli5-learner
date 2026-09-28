import { describe, expect, it } from 'vitest';
import {
  assembleLines,
  detectGutter,
  headingLevels,
  linesToBlocks,
  makeLine,
  orderLines,
  removeRunningLines,
  type PItem,
  type PageGeom,
} from '../../../../src/main/extract/pdf-layout';

const G: PageGeom = { x0: 0, y0: 0, width: 612, height: 792 };
const it10 = (str: string, x: number, y: number, h = 10): PItem => ({ str, x, y, w: str.length * 5, h });

describe('pdf layout heuristics (04 §6.1)', () => {
  it('groups items by baseline and inserts spaces on gaps', () => {
    const lines = assembleLines([it10('world', 110, 700.2), it10('Hello', 72, 700), it10('Next', 72, 687)]);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next']);
    expect(makeLine([it10('ab', 72, 10), { str: 'cd', x: 82, y: 10, w: 10, h: 10 }]).text).toBe('abcd');
  });

  it('finds a gutter and reads the left band before the right', () => {
    const items: PItem[] = [];
    for (let i = 0; i < 6; i++) {
      items.push(it10(`left ${i}`, 72, 700 - i * 13), it10(`right ${i}`, 330, 700 - i * 13));
    }
    items.push(it10('A wide heading that spans both of the columns on the page', 72, 740, 12));
    const lines = assembleLines(items);
    expect(detectGutter(lines, G)).not.toBeNull();
    expect(orderLines(lines, G).map((l) => l.text)).toEqual([
      'A wide heading that spans both of the columns on the page',
      ...[0, 1, 2, 3, 4, 5].map((i) => `left ${i}`),
      ...[0, 1, 2, 3, 4, 5].map((i) => `right ${i}`),
    ]);
  });

  it('does not invent columns for single-column text', () => {
    const lines = assembleLines(
      [0, 1, 2, 3, 4].map((i) => it10('a long line of body text across the page width here', 72, 700 - i * 13)),
    );
    expect(detectGutter(lines, G)).toBeNull();
  });

  it('removes running lines only when they repeat on more than half the pages and at least 3', () => {
    const page = (n: number): { lines: ReturnType<typeof assembleLines>; geom: PageGeom } => ({
      lines: assembleLines([it10(`Report header`, 72, 770), it10(`Body ${n}`, 72, 400), it10(`Page ${n}`, 300, 20)]),
      geom: G,
    });
    const three = [page(1), page(2), page(3)];
    expect(removeRunningLines(three)).toBe(6);
    expect(three.map((p) => p.lines.map((l) => l.text))).toEqual([['Body 1'], ['Body 2'], ['Body 3']]);
    const two = [page(1), page(2)];
    expect(removeRunningLines(two)).toBe(0);
  });

  it('builds paragraphs, de-hyphenates, and finds headings and lists', () => {
    const lines = assembleLines([
      it10('Big Title', 72, 740, 20),
      it10('The plant expanded its manufac-', 72, 700),
      it10('turing floor.', 72, 687),
      it10('A new paragraph after a gap.', 72, 650),
      it10('• First', 72, 620),
      it10('– Nested', 84, 607),
      it10('• Second', 72, 594),
      it10('1) Ordered start', 72, 560),
    ]);
    const levels = headingLevels(
      lines.map((l) => l.h),
      10,
    );
    expect(linesToBlocks(lines, 10, levels)).toEqual([
      { kind: 'heading', level: 1, text: 'Big Title' },
      { kind: 'paragraph', text: 'The plant expanded its manufacturing floor.' },
      { kind: 'paragraph', text: 'A new paragraph after a gap.' },
      { kind: 'list', ordered: false, items: [{ text: 'First', children: [{ text: 'Nested' }] }, { text: 'Second' }] },
      { kind: 'list', ordered: true, items: [{ text: 'Ordered start' }] },
    ]);
  });

  it('keeps hyphens before capitals and digits', () => {
    const lines = assembleLines([it10('North-', 72, 700), it10('South link', 72, 687)]);
    expect(linesToBlocks(lines, 10, new Map())).toEqual([{ kind: 'paragraph', text: 'North- South link' }]);
  });
});
