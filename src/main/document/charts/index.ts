// ChartSpec -> static inline SVG at render time (07 §7.2); chart checks at build time (07 §5.2).
import type { ChartSpec } from '../../llm';
import { attrs, esc } from '../html';
import { renderBar, isHorizontal } from './bar';
import { CHART_WIDTH, formatValue, maxOf } from './common';
import { renderLine } from './line';
import { renderPie } from './pie';
import { renderScatter } from './scatter';

export { formatValue } from './common';
export { isHorizontal } from './bar';

const MAX_CATEGORIES = 30;
const MAX_LINE_SERIES = 6;
const MAX_PIE_SLICES = 6;

/**
 * 07 §5.2 chart checks. Returns null (drop) when a series length differs from the category count;
 * folds > 30 categories into "Other"; converts invalid pies to bars; caps line/area/scatter series.
 */
export function normalizeChart(input: ChartSpec, warn: (w: string) => void): ChartSpec | null {
  const n = input.categories.length;
  if (n === 0 || input.series.length === 0) return null;
  if (input.series.some((s) => s.values.length !== n)) {
    warn('chart-series-length');
    return null;
  }
  let chart: ChartSpec = { ...input, series: input.series.map((s) => ({ ...s, values: [...s.values] })) };
  if (n > MAX_CATEGORIES) {
    const first = chart.series[0]?.values ?? [];
    const keep = new Set(
      chart.categories
        .map((_, i) => i)
        .sort((a, b) => (first[b] ?? -Infinity) - (first[a] ?? -Infinity) || a - b)
        .slice(0, MAX_CATEGORIES - 1),
    );
    const idx = chart.categories.map((_, i) => i).filter((i) => keep.has(i));
    const rest = chart.categories.map((_, i) => i).filter((i) => !keep.has(i));
    chart = {
      ...chart,
      categories: [...idx.map((i) => chart.categories[i] ?? ''), 'Other'],
      series: chart.series.map((s) => {
        const folded = rest.map((i) => s.values[i] ?? null).filter((v): v is number => v !== null);
        return {
          ...s,
          values: [...idx.map((i) => s.values[i] ?? null), folded.length ? folded.reduce((a, b) => a + b, 0) : null],
        };
      }),
    };
    warn('chart-categories-folded');
  }
  if (chart.kind === 'pie') {
    const vals = chart.series[0]?.values ?? [];
    if (vals.some((v) => v !== null && v < 0) || chart.categories.length > MAX_PIE_SLICES) {
      chart = { ...chart, kind: 'bar', series: chart.series.slice(0, 1) };
      warn('pie-converted');
    }
  }
  if (
    (chart.kind === 'line' || chart.kind === 'area' || chart.kind === 'scatter') &&
    chart.series.length > MAX_LINE_SERIES
  ) {
    chart = { ...chart, series: chart.series.slice(0, MAX_LINE_SERIES) };
    warn('chart-series-capped');
  }
  return chart;
}

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
  return parts.join(', ');
}

/** The chart SVG alone (role=img, <title>, <desc>). `idBase` must be unique in the document. */
export function renderChartSvg(chart: ChartSpec, idBase: string): string {
  const { body, height } =
    chart.kind === 'bar' || chart.kind === 'stacked-bar'
      ? renderBar(chart)
      : chart.kind === 'pie'
        ? renderPie(chart)
        : chart.kind === 'scatter'
          ? renderScatter(chart)
          : renderLine(chart);
  const t = `${idBase}-t`;
  const d = `${idBase}-d`;
  return (
    `<svg${attrs([
      ['xmlns', 'http://www.w3.org/2000/svg'],
      ['viewBox', `0 0 ${CHART_WIDTH} ${height}`],
      ['role', 'img'],
      ['aria-labelledby', `${t} ${d}`],
      ['class', 'viz'],
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
        chart.series.map((s) => `<td class="num">${esc(formatValue(s.values[i] ?? null, chart.unit))}</td>`).join('') +
        '</tr>',
    )
    .join('');
  return `<details class="chart-data"><summary>Show data</summary><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

/** `<figure class="chart">` with takeaway headline, subtitle, SVG, source line and data table (07 §7.1, §7.2). */
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
    (chart.source ? `<p class="chart-source">Source: ${esc(chart.source)}</p>` : '') +
    renderChartData(chart) +
    '</figure>'
  );
}
