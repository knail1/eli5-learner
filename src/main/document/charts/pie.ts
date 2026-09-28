// Pie charts (07 §7.2 rule 7): <= 6 slices, largest first, clockwise from 12 o'clock, labels
// outside with percentages. Uses the first series only.
import { arc, pie } from 'd3-shape';
import type { ChartSpec } from '../../llm';
import { CHART_WIDTH, el, escSvg, formatValue, markAttrs, r2, seriesClass, truncate } from './common';
import { NOTE_BELOW, noteUnder } from './annotate';

interface Slice {
  label: string;
  value: number;
  index: number;
}

export function renderPie(chart: ChartSpec): { body: string; height: number } {
  const pieH = 300;
  const values = chart.series[0]?.values ?? [];
  const data: Slice[] = chart.categories
    .map((label, index) => ({ label, value: values[index] ?? 0, index }))
    .filter((d): d is Slice => d.value !== null && Number.isFinite(d.value) && d.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index);
  const total = data.reduce((s, d) => s + d.value, 0);
  const cx = CHART_WIDTH / 2;
  const cy = pieH / 2;
  const radius = 104;
  const arcs = pie<Slice>()
    .sort(null)
    .value((d) => d.value)(data);
  const shape = arc<(typeof arcs)[number]>().innerRadius(0).outerRadius(radius);
  const outer = arc<(typeof arcs)[number]>()
    .innerRadius(radius * 1.12)
    .outerRadius(radius * 1.12);
  let body = '';
  arcs.forEach((a, i) => {
    const d = a.data;
    const cls = chart.highlight
      ? d.label === chart.highlight.category
        ? 'viz-fill-accent'
        : 'viz-fill-muted'
      : seriesClass('fill', i);
    body += el('path', [
      ['d', shape(a) ?? ''],
      ['transform', `translate(${r2(cx)},${r2(cy)})`],
      ['class', `${cls} viz-slice`],
      ...markAttrs(d.label, formatValue(d.value, chart.unit)),
    ]);
    const [lx, ly] = outer.centroid(a);
    const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
    const right = lx >= 0;
    body += el('polyline', [
      [
        'points',
        `${r2(cx + lx * 0.9)},${r2(cy + ly * 0.9)} ${r2(cx + lx)},${r2(cy + ly)} ${r2(cx + lx + (right ? 10 : -10))},${r2(cy + ly)}`,
      ],
      ['fill', 'none'],
      ['class', 'viz-leader'],
    ]);
    body += el(
      'text',
      [
        ['x', r2(cx + lx + (right ? 14 : -14))],
        ['y', r2(cy + ly + 4)],
        ['text-anchor', right ? 'start' : 'end'],
        ['class', 'viz-ink viz-cat'],
      ],
      escSvg(`${truncate(d.label, 26)} ${pct}%`),
    );
  });
  // Rule 6: the note sits under the pie, below the lowest slice label.
  if (chart.highlight) body += noteUnder(chart.highlight.note, cx, pieH);
  return { body, height: pieH + (chart.highlight ? NOTE_BELOW : 0) };
}
