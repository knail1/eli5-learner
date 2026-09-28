/**
 * Geometry checks for the highlight note (07 §7.2 rule 6): the note must never sit on a bar, a
 * point, a value label or any other chart text, and must stay inside the viewBox. Text boxes use
 * the renderer's own width estimate (12 px font, 0.56 em per character) plus a small margin.
 */
import { describe, expect, it } from 'vitest';
import { renderChartSvg } from '../../../../src/main/document/charts';
import type { ChartSpec } from '../../../../src/main/llm';

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  what: string;
}

const num = (tag: string, name: string): number => {
  const m = new RegExp(`\\s${name}="(-?[\\d.]+)"`).exec(tag);
  return m?.[1] === undefined ? NaN : Number(m[1]);
};

const unescape = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

function textBoxes(svg: string): (Box & { cls: string })[] {
  const out: (Box & { cls: string })[] = [];
  for (const m of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const tag = m[1] ?? '';
    const text = unescape(m[2] ?? '');
    const x = num(tag, 'x');
    const y = num(tag, 'y');
    const w = text.length * 12 * 0.56;
    const anchor = /text-anchor="(\w+)"/.exec(tag)?.[1] ?? 'start';
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? '';
    out.push({ x0, x1: x0 + w, y0: y - 10, y1: y + 3, what: `text "${text}"`, cls });
  }
  return out;
}

function markBoxes(svg: string): Box[] {
  const out: Box[] = [];
  for (const m of svg.matchAll(/<rect([^>]*)\/>/g)) {
    const tag = m[1] ?? '';
    if (!tag.includes('data-value')) continue;
    const x = num(tag, 'x');
    const y = num(tag, 'y');
    out.push({ x0: x, y0: y, x1: x + num(tag, 'width'), y1: y + num(tag, 'height'), what: `bar ${tag}` });
  }
  for (const m of svg.matchAll(/<circle([^>]*)\/>/g)) {
    const tag = m[1] ?? '';
    const cx = num(tag, 'cx');
    const cy = num(tag, 'cy');
    const r = num(tag, 'r');
    out.push({ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, what: `point ${tag}` });
  }
  return out;
}

function leaderSegments(svg: string): { x1: number; y1: number; x2: number; y2: number }[] {
  const g = /<g class="viz-annotation">([\s\S]*?)<\/g>/.exec(svg)?.[1] ?? '';
  return [...g.matchAll(/<line([^>]*)\/>/g)].map((m) => {
    const t = m[1] ?? '';
    return { x1: num(t, 'x1'), y1: num(t, 'y1'), x2: num(t, 'x2'), y2: num(t, 'y2') };
  });
}

const overlaps = (a: Box, b: Box, pad = 1): boolean =>
  a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

/** A leader segment (axis-aligned) crossing the inside of a box. */
function crosses(s: { x1: number; y1: number; x2: number; y2: number }, b: Box): boolean {
  const lx0 = Math.min(s.x1, s.x2);
  const lx1 = Math.max(s.x1, s.x2);
  const ly0 = Math.min(s.y1, s.y2);
  const ly1 = Math.max(s.y1, s.y2);
  return lx0 < b.x1 - 0.5 && b.x0 + 0.5 < lx1 + 0.01 && ly0 < b.y1 - 0.5 && b.y0 + 0.5 < ly1 + 0.01;
}

function checkNote(chart: ChartSpec): void {
  const svg = renderChartSvg(chart, 'x');
  const height = Number(/viewBox="0 0 640 ([\d.]+)"/.exec(svg)?.[1]);
  const texts = textBoxes(svg);
  const notes = texts.filter((t) => t.cls.includes('viz-note'));
  expect(notes, 'exactly one note').toHaveLength(1);
  const note = notes[0]!;
  expect(note.x0).toBeGreaterThanOrEqual(0);
  expect(note.x1).toBeLessThanOrEqual(640);
  expect(note.y0).toBeGreaterThanOrEqual(0);
  expect(note.y1).toBeLessThanOrEqual(height);
  for (const t of texts) {
    if (t === note) continue;
    expect(overlaps(note, t), `note overlaps ${t.what}`).toBe(false);
  }
  const ms = markBoxes(svg);
  for (const m of ms) expect(overlaps(note, m), `note overlaps ${m.what}`).toBe(false);
  const leaders = leaderSegments(svg);
  expect(leaders.length).toBeGreaterThan(0);
  for (const s of leaders) {
    for (const m of ms) expect(crosses(s, m), `leader crosses ${m.what}`).toBe(false);
    for (const t of texts) if (t !== note) expect(crosses(s, t), `leader crosses ${t.what}`).toBe(false);
  }
}

const LONG_CATS = ['Sent to a shared team channel', 'Forwarded to the service desk', 'Sent to a general email inbox'];

describe('highlight note layout (07 §7.2 rule 6)', () => {
  it('horizontal bars: the reported case (note on the longest bar, value 3) collides with nothing', () => {
    checkNote({
      kind: 'bar',
      title: 'Most reports go to the inbox',
      categories: LONG_CATS,
      series: [{ name: 'Reports', values: [1, 2, 3] }],
      highlight: { category: 'Sent to a general email inbox', note: 'Sent to a general email inbox' },
    });
  });

  it.each([0, 1, 2])('horizontal bars: highlight on row %i with a 60-character note', (row) => {
    checkNote({
      kind: 'bar',
      title: 't',
      categories: LONG_CATS,
      series: [{ name: 'Reports', values: [3, 12.5, 7] }],
      unit: '$',
      highlight: { category: LONG_CATS[row]!, note: 'A long annotation that runs right up to the sixty char cap!' },
    });
  });

  it('horizontal bars: negative values, two series and an x label', () => {
    checkNote({
      kind: 'bar',
      title: 't',
      categories: LONG_CATS,
      series: [
        { name: 'A', values: [-4, 2, 9] },
        { name: 'B', values: [3, -1, 8] },
      ],
      xLabel: 'Change',
      highlight: { category: LONG_CATS[2]!, note: 'Biggest mover this quarter' },
    });
  });

  it('horizontal stacked bars (no value labels)', () => {
    checkNote({
      kind: 'stacked-bar',
      title: 't',
      categories: LONG_CATS,
      series: [
        { name: 'A', values: [4, 2, 9] },
        { name: 'B', values: [3, 1, 8] },
      ],
      highlight: { category: LONG_CATS[0]!, note: 'Mostly one kind' },
    });
  });

  it.each([
    ['tallest', 'C', [1, 2, 9]],
    ['shortest between tall neighbours', 'B', [9, 1, 9]],
    ['middle', 'B', [2, 5, 9]],
  ] as const)('vertical bars: highlight on the %s bar', (_, category, values) => {
    checkNote({
      kind: 'bar',
      title: 't',
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S', values: [...values] }],
      yLabel: 'Count',
      highlight: { category, note: 'A fairly long note that spans several bars' },
    });
  });

  it('vertical bars: two series with value labels', () => {
    checkNote({
      kind: 'bar',
      title: 't',
      categories: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [
        { name: 'A', values: [100, 250, 300, 1200] },
        { name: 'B', values: [900, 1100, 50, 1250] },
      ],
      unit: '$',
      highlight: { category: 'Q3', note: 'Dip after the price change' },
    });
  });

  it('vertical bars: negative highlighted value', () => {
    checkNote({
      kind: 'bar',
      title: 't',
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S', values: [5, -3, 8] }],
      highlight: { category: 'B', note: 'The only loss' },
    });
  });

  it.each(['line', 'area'] as const)('%s: note above the plot, clear of points and direct labels', (kind) => {
    checkNote({
      kind,
      title: 't',
      categories: ['Jan', 'Feb', 'Mar', 'Apr'],
      series: [
        { name: 'North', values: [1, 9, 3, 8] },
        { name: 'South', values: [8, 2, 9, 9] },
      ],
      highlight: { category: 'Apr', note: 'Both regions peak in April this year' },
    });
  });

  it('scatter: the note is drawn and clears every point', () => {
    checkNote({
      kind: 'scatter',
      title: 't',
      categories: ['1', '2', '3', '4'],
      series: [{ name: 'S', values: [2, 9, 4, 9] }],
      highlight: { category: '3', note: 'Outlier below the trend' },
    });
  });

  it('pie: the note is drawn below the pie, clear of the slice labels', () => {
    const chart: ChartSpec = {
      kind: 'pie',
      title: 't',
      categories: ['Email', 'Chat', 'Phone'],
      series: [{ name: 'S', values: [6, 3, 1] }],
      highlight: { category: 'Email', note: 'Most contacts arrive by email' },
    };
    const svg = renderChartSvg(chart, 'x');
    const texts = textBoxes(svg);
    const note = texts.find((t) => t.cls.includes('viz-note'));
    expect(note).toBeDefined();
    for (const t of texts) if (t !== note) expect(overlaps(note!, t), `note overlaps ${t.what}`).toBe(false);
    const height = Number(/viewBox="0 0 640 ([\d.]+)"/.exec(svg)?.[1]);
    expect(note!.y1).toBeLessThanOrEqual(height);
    expect(note!.x0).toBeGreaterThanOrEqual(0);
    expect(note!.x1).toBeLessThanOrEqual(640);
  });

  it('a note too long for the space is truncated with an ellipsis, never clipped', () => {
    const svg = renderChartSvg(
      {
        kind: 'bar',
        title: 't',
        categories: ['An extremely long category label that is truncated', 'B', 'C'],
        series: [{ name: 'S', values: [1, 2, 3] }],
        highlight: {
          category: 'An extremely long category label that is truncated',
          note: 'x'.repeat(120),
        },
      },
      'x',
    );
    const note = textBoxes(svg).find((t) => t.cls.includes('viz-note'));
    expect(note?.what).toMatch(/…"$/);
    expect(note!.x1).toBeLessThanOrEqual(640);
  });

  it('no note, no reserved space: a chart without highlight keeps its height', () => {
    const plain: ChartSpec = {
      kind: 'bar',
      title: 't',
      categories: LONG_CATS,
      series: [{ name: 'S', values: [1, 2, 3] }],
    };
    const h = (c: ChartSpec): number => Number(/viewBox="0 0 640 ([\d.]+)"/.exec(renderChartSvg(c, 'x'))?.[1]);
    expect(h(plain)).toBe(28 * 3 + 10 + 12);
    expect(h({ ...plain, highlight: { category: LONG_CATS[0]!, note: 'n' } })).toBeGreaterThan(h(plain));
  });
});
