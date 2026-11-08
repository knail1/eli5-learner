// Explorable block -> static figure (07 §7.1 explorable, design D7-D9): a deterministic SVG of each
// preset's run, direct labels and a details table with outcomes computed by the shared math (never
// model words), plus `data-params` the doc-runtime reads to animate it. No script is emitted here.
import {
  FRAME,
  MH_X,
  clampSim,
  fmtNum,
  gdFrame,
  gdPoint,
  logDensity,
  mhFrame,
  outcomeRows,
  runGD,
  runMH,
  settingName,
  type ExplorableSim,
  type GdSim,
  type MhSim,
  type OutcomeRow,
} from '../../../shared/explorable';
import { canonicalJson } from '../canonical-json';
import { attrs, esc } from '../html';
import type { DocBlock } from '../types';
import { el, r2, seriesClass } from './common';

type ExplorableBlock = Extract<DocBlock, { type: 'explorable' }>;

/** At most this many dots per drawn run. */
const MAX_DOTS = 40;
const LABEL_Y0 = 14;
const LABEL_DY = 18;

/** Signed number with a true minus sign for axis labels. */
function tick(n: number): string {
  return fmtNum(n).replace(/^-/, '−');
}

/** Evenly spaced indices of `n` items, first and last always included. */
function sample(n: number, max = MAX_DOTS): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return [...new Set(out)];
}

function directLabels(rows: readonly OutcomeRow[]): string {
  return rows
    .map((r, i) => {
      const y = LABEL_Y0 + i * LABEL_DY;
      return (
        el('circle', [
          ['cx', FRAME.left + 5],
          ['cy', y - 4],
          ['r', 5],
          ['class', seriesClass('fill', i)],
        ]) +
        el(
          'text',
          [
            ['x', FRAME.left + 16],
            ['y', y],
            ['class', 'viz-ink viz-direct'],
          ],
          esc(r.label),
        )
      );
    })
    .join('');
}

function axis(y: number, ticks: readonly [number, number][]): string {
  return (
    el('line', [
      ['x1', FRAME.left],
      ['x2', FRAME.W - FRAME.right],
      ['y1', r2(y)],
      ['y2', r2(y)],
      ['class', 'viz-axis'],
    ]) +
    ticks
      .map(([v, x], i) =>
        el(
          'text',
          [
            ['x', r2(x)],
            ['y', r2(y + 16)],
            ['text-anchor', i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'],
            ['class', 'viz-tick'],
          ],
          esc(tick(v)),
        ),
      )
      .join('')
  );
}

function pathOf(points: readonly [number, number][]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${r2(x)},${r2(y)}`).join('');
}

function gdBody(sim: GdSim, rows: readonly OutcomeRow[]): string {
  const f = gdFrame(sim);
  const curve: [number, number][] = [];
  for (let i = 0; i <= 120; i++) curve.push(gdPoint(sim, f, f.x0 + ((f.x1 - f.x0) * i) / 120));
  let body = directLabels(rows);
  body += axis(FRAME.H - FRAME.bottom, [
    [f.x0, f.px(f.x0)],
    [0, f.px(0)],
    [f.x1, f.px(f.x1)],
  ]);
  body += el('path', [
    ['d', pathOf(curve)],
    ['fill', 'none'],
    ['class', 'viz-line viz-stroke-muted explorable-curve'],
  ]);
  rows.forEach((row, i) => {
    const run = runGD(sim, row.setting);
    // A run that leaves the plot is drawn up to the edge it leaves through (clipped there).
    const out = run.xs.findIndex((x) => x < f.x0 || x > f.x1);
    const xs = out < 0 ? run.xs : run.xs.slice(0, out + 1);
    const pts = sample(xs.length).map((k) => gdPoint(sim, f, xs[k] ?? sim.start));
    let g = el('path', [
      ['d', pathOf(pts)],
      ['fill', 'none'],
      ['class', `explorable-path ${seriesClass('stroke', i)}`],
    ]);
    pts.forEach(([x, y], k) => {
      g += el('circle', [
        ['cx', r2(x)],
        ['cy', r2(y)],
        ['r', k === pts.length - 1 ? 5 : 2.5],
        ['class', seriesClass('fill', i)],
      ]);
    });
    body += el('g', [['class', 'explorable-run']], g);
  });
  const [sx, sy] = gdPoint(sim, f, sim.start);
  body += el('circle', [
    ['cx', r2(sx)],
    ['cy', r2(sy)],
    ['r', 7],
    ['fill', 'none'],
    ['class', 'viz-stroke-ink explorable-start'],
  ]);
  return body;
}

/** Visited positions per bin: one strip of shaded cells per preset under the density curve. */
const MH_BINS = 64;

function mhBody(sim: MhSim, rows: readonly OutcomeRow[]): string {
  const f = mhFrame(sim, rows.length);
  const [x0, x1] = MH_X;
  const curve: [number, number][] = [];
  for (let i = 0; i <= 160; i++) {
    const x = x0 + ((x1 - x0) * i) / 160;
    curve.push([f.px(x), f.py(Math.exp(logDensity(sim.target, x)))]);
  }
  let body = directLabels(rows);
  body += el('path', [
    ['d', pathOf(curve)],
    ['fill', 'none'],
    ['class', 'viz-line viz-stroke-muted explorable-curve'],
  ]);
  body += el('line', [
    ['x1', FRAME.left],
    ['x2', FRAME.W - FRAME.right],
    ['y1', r2(f.base)],
    ['y2', r2(f.base)],
    ['class', 'viz-axis'],
  ]);
  const cellW = (FRAME.W - FRAME.left - FRAME.right) / MH_BINS;
  rows.forEach((row, i) => {
    const run = runMH(sim, row.setting);
    const bins = new Array<number>(MH_BINS).fill(0);
    for (const x of run.xs) {
      const b = Math.floor(((Math.min(x1, Math.max(x0, x)) - x0) / (x1 - x0)) * MH_BINS);
      bins[Math.min(MH_BINS - 1, b)]! += 1;
    }
    const top = Math.max(...bins);
    let g = '';
    bins.forEach((n, b) => {
      if (n === 0) return;
      g += el('rect', [
        ['x', r2(FRAME.left + b * cellW)],
        ['y', r2(f.rowY(i) - 6)],
        ['width', r2(cellW)],
        ['height', 12],
        ['fill-opacity', r2(0.2 + (0.8 * n) / top)],
        ['class', seriesClass('fill', i)],
      ]);
    });
    body += el('g', [['class', 'explorable-run']], g);
  });
  body += axis(FRAME.H - FRAME.bottom, [
    [x0, f.px(x0)],
    [0, f.px(0)],
    [x1, f.px(x1)],
  ]);
  return body;
}

/** The static picture (role=img): title, alt plus the computed outcomes as its description. */
export function renderExplorableSvg(
  sim: ExplorableSim,
  rows: readonly OutcomeRow[],
  title: string,
  alt: string,
  idBase: string,
): string {
  const t = `${idBase}-t`;
  const d = `${idBase}-d`;
  const desc = [alt, ...rows.map((r) => r.label)].filter((x) => x !== '').join('. ');
  return (
    `<svg${attrs([
      ['xmlns', 'http://www.w3.org/2000/svg'],
      ['viewBox', `0 0 ${FRAME.W} ${FRAME.H}`],
      ['role', 'img'],
      ['aria-labelledby', `${t} ${d}`],
      ['class', 'viz explorable-svg'],
    ])}>` +
    `<title id="${t}">${esc(title)}</title><desc id="${d}">${esc(desc)}</desc>` +
    (sim.kind === 'gradient-descent' ? gdBody(sim, rows) : mhBody(sim, rows)) +
    '</svg>'
  );
}

/** The outcome table under the picture. */
export function renderExplorableData(sim: ExplorableSim, rows: readonly OutcomeRow[]): string {
  const name = settingName(sim);
  const head =
    `<th scope="col">${esc(name.charAt(0).toUpperCase() + name.slice(1))}</th>` +
    '<th scope="col">Outcome</th><th scope="col" class="num">Steps</th><th scope="col">Result</th>';
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row">${esc(fmtNum(r.setting))}</th><td>${esc(r.outcome)}</td>` +
        `<td class="num">${r.steps}</td><td>${esc(r.result)}</td></tr>`,
    )
    .join('');
  return (
    '<details class="chart-data explorable-data"><summary>Show outcomes</summary><div class="table-wrap"><table>' +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></details>`
  );
}

/**
 * `<figure class="explorable">` (07 §7.1). Numbers are re-clamped here, so a hand-edited model can
 * never make the static simulation unbounded; an unusable one keeps only its text.
 */
export function renderExplorableFigure(b: ExplorableBlock, idBase: string): string {
  const sim = clampSim(b.sim);
  const open = (extra: [string, string][]): string =>
    `<figure${attrs([['class', 'explorable'], ...extra])}>` +
    `<h3 class="chart-title">${esc(b.title)}</h3>` +
    (b.caption ? `<p class="chart-sub explorable-cap">${esc(b.caption)}</p>` : '');
  if (!sim) return `${open([])}<p class="chart-foot">${esc(b.alt)}</p></figure>`;
  const rows = outcomeRows(sim);
  return (
    open([
      ['data-kind', sim.kind],
      ['data-params', canonicalJson(sim)],
    ]) +
    renderExplorableSvg(sim, rows, b.title, b.alt, idBase) +
    renderExplorableData(sim, rows) +
    '</figure>'
  );
}
