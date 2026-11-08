// ChartSpec -> static inline SVG at render time (07 §7.2); chart normalization at build time
// (07 §5.2, normalize.ts).
import type { ChartSpec } from '../../llm';
import { attrs, esc } from '../html';
import { renderBar, isHorizontal } from './bar';
import { CHART_WIDTH, COMPACT_WIDTH, NO_DATA, formatValue, maxOf } from './common';
import { AXIS_BREAK_NOTE, lineAxis, renderLine } from './line';
import { ANNOTATION_MARKS } from './annotate';
import { renderPie } from './pie';
import { renderScatter } from './scatter';

export { formatValue, niceScale, COMPACT_WIDTH, COMPACT_BELOW } from './common';
export { isHorizontal } from './bar';
export { renderExplorableFigure } from './explorable';
export { lineAxis } from './line';
export {
  normalizeChart,
  chartText,
  stripEmphasis,
  unshout,
  type ChartAsTable,
  MAX_LINE_SERIES,
  MAX_BAR_SERIES,
  MAX_PIE_SLICES,
} from './normalize';

const KIND_NAMES: Record<ChartSpec['kind'], string> = {
  bar: 'Bar chart',
  'stacked-bar': 'Stacked bar chart',
  line: 'Line chart',
  area: 'Area chart',
  pie: 'Pie chart',
  scatter: 'Scatter chart',
};

/** Generated `<desc>` summary, e.g. "Bar chart, 5 categories, highest: Paid search 4.2" (07 §7.2). */
export function chartSummary(chart: ChartSpec): string {
  const first = chart.series[0]?.values ?? [];
  const top = maxOf(first);
  const ti = top === undefined ? -1 : first.indexOf(top);
  const parts = [KIND_NAMES[chart.kind], `${chart.categories.length} categories`];
  if (chart.series.length > 1) parts.push(`${chart.series.length} series`);
  if (ti >= 0 && top !== undefined)
    parts.push(`highest: ${chart.categories[ti] ?? ''} ${formatValue(top, chart.unit)}`);
  // Rule 8: missing values are named, so a screen reader hears what the empty slot means.
  const gaps = chart.categories.flatMap((c, i) =>
    chart.series
      .filter((s) => s.values[i] === null || !Number.isFinite(s.values[i] ?? NaN))
      .map((s) => (chart.series.length > 1 ? `${c} · ${s.name}` : c)),
  );
  if (gaps.length) {
    const shown = gaps.slice(0, 3).join('; ');
    parts.push(`${NO_DATA.toLowerCase()}: ${shown}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}`);
  }
  return parts.join(', ');
}

/**
 * The chart SVG alone (role=img, <title>, <desc>). `idBase` must be unique in the document. `W` is
 * the viewBox width: CHART_WIDTH for the regular layout, COMPACT_WIDTH for the narrow one (rule 12).
 */
export function renderChartSvg(chart: ChartSpec, idBase: string, W: number = CHART_WIDTH): string {
  const { body, height } =
    chart.kind === 'bar' || chart.kind === 'stacked-bar'
      ? renderBar(chart, W)
      : chart.kind === 'pie'
        ? renderPie(chart, W)
        : chart.kind === 'scatter'
          ? renderScatter(chart, W)
          : renderLine(chart, W);
  const t = `${idBase}-t`;
  const d = `${idBase}-d`;
  return (
    `<svg${attrs([
      ['xmlns', 'http://www.w3.org/2000/svg'],
      ['viewBox', `0 0 ${W} ${height}`],
      ['role', 'img'],
      ['aria-labelledby', `${t} ${d}`],
      ['class', W < CHART_WIDTH ? 'viz viz--compact' : 'viz'],
    ])}>` +
    `<title id="${t}">${esc(chart.title)}</title><desc id="${d}">${esc(chartSummary(chart))}</desc>` +
    body +
    '</svg>'
  );
}

/** The data disclosure that follows every chart (07 §7.2). */
export function renderChartData(chart: ChartSpec): string {
  const head =
    `<th scope="col">${esc(chart.xLabel ?? 'Category')}</th>` +
    chart.series.map((s) => `<th scope="col" class="num">${esc(s.name)}</th>`).join('');
  const rows = chart.categories
    .map(
      (c, i) =>
        `<tr><th scope="row">${esc(c)}</th>` +
        chart.series
          .map((s) => {
            const v = s.values[i] ?? null;
            return v === null || !Number.isFinite(v)
              ? `<td class="num nodata">${NO_DATA}</td>`
              : `<td class="num">${esc(formatValue(v, chart.unit))}</td>`;
          })
          .join('') +
        '</tr>',
    )
    .join('');
  return `<details class="chart-data"><summary>Show data</summary><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

/**
 * Text under the plot (07 §7.2 rules 14, 15): one line per annotation ("¹ Category: text"), then
 * the note, which joins the chart's footnote with the renderer's own axis-break sentence (rule 2).
 */
export function chartNotes(chart: ChartSpec): string {
  let out = '';
  (chart.annotations ?? []).slice(0, ANNOTATION_MARKS.length).forEach((a, i) => {
    out += `<p class="chart-foot chart-ann"><span class="chart-ann-mark" aria-hidden="true">${ANNOTATION_MARKS[i]}</span> ${esc(a.category)}: ${esc(a.text)}</p>`;
  });
  const axis = chart.kind === 'line' && lineAxis(chart).broken ? AXIS_BREAK_NOTE : '';
  const foot = [chart.footnote?.trim() ?? '', axis].filter((x) => x !== '').join(' ');
  if (foot) out += `<p class="chart-foot">Note: ${esc(foot)}</p>`;
  return out;
}

/**
 * `<figure class="chart">` with takeaway headline, subtitle, SVG, source line and data table (07 §7.1,
 * §7.2). Two SVGs: the regular layout and a compact one (rule 12); CSS container queries show
 * exactly one, so the hidden one is out of the accessibility tree too.
 */
export function renderChartFigure(chart: ChartSpec, idBase: string): string {
  const orient = chart.kind === 'bar' || chart.kind === 'stacked-bar' ? (isHorizontal(chart) ? 'h' : 'v') : undefined;
  return (
    `<figure${attrs([
      ['class', 'chart'],
      ['data-chart-kind', chart.kind],
      ['data-orient', orient],
    ])}>` +
    `<h3 class="chart-title">${esc(chart.title)}</h3>` +
    (chart.subtitle ? `<p class="chart-sub">${esc(chart.subtitle)}</p>` : '') +
    renderChartSvg(chart, idBase) +
    renderChartSvg(chart, `${idBase}-c`, COMPACT_WIDTH) +
    chartNotes(chart) +
    (chart.source ? `<p class="chart-source">Source: ${esc(chart.source)}</p>` : '') +
    renderChartData(chart) +
    '</figure>'
  );
}
