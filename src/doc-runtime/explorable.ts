// Explorables (07 §7.1, §14): progressive enhancement of the static `<figure class="explorable">`.
// Reads data-params, re-clamps it with the shared math, adds a log-mapped slider, presets,
// Play/Pause/Step/Reset and a polite status line, and animates a marker in the existing SVG with
// requestAnimationFrame only. Never: timers, workers, storage, network, postMessage, innerHTML.
import {
  clampSim,
  fmtNum,
  fromSlider,
  gdFrame,
  gdPoint,
  logDensity,
  mhFrame,
  outcomeRow,
  runGD,
  runMH,
  settingName,
  sliderOf,
  toSlider,
  type ExplorableSim,
} from '../shared/explorable';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Slider resolution (positions 0..RES, log-mapped). */
const RES = 1000;
/** A whole run plays in about RUN_MS, at STEP_MS[0]..STEP_MS[1] milliseconds per simulated step. */
const RUN_MS = 4000;
const STEP_MS = [12, 150] as const;

export interface ExplorablePlayer {
  pause(): void;
}

/** Point mapping and trail shape for one sim. */
function geometry(sim: ExplorableSim): { at(x: number): [number, number]; trail(xs: number[]): string } {
  if (sim.kind === 'gradient-descent') {
    const f = gdFrame(sim);
    const at = (x: number): [number, number] => gdPoint(sim, f, x);
    return {
      at,
      trail: (xs) =>
        xs
          .map((x, i) => {
            const [px, py] = at(x);
            return `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
          })
          .join(''),
    };
  }
  const f = mhFrame(sim, sim.presets.length);
  return {
    at: (x) => [f.px(x), f.py(Math.exp(logDensity(sim.target, x)))],
    // A rug of visited positions just under the curve's baseline.
    trail: (xs) => xs.map((x) => `M${f.px(x).toFixed(1)},${(f.base + 1).toFixed(1)}v5`).join(''),
  };
}

function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, name: K, cls: string): SVGElementTagNameMap[K] {
  const e = doc.createElementNS(SVG_NS, name);
  e.setAttribute('class', cls);
  return e;
}

function button(doc: Document, text: string, label?: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (label) b.setAttribute('aria-label', label);
  return b;
}

export function setupExplorable(
  fig: HTMLElement,
  doc: Document,
  win: Window,
  reduce: boolean,
  n: number,
): ExplorablePlayer | undefined {
  const svg = fig.querySelector('svg.explorable-svg');
  let raw: unknown;
  try {
    raw = JSON.parse(fig.getAttribute('data-params') ?? '');
  } catch {
    return undefined;
  }
  const sim = clampSim(raw);
  if (!sim || !svg) return undefined;
  const range = sliderOf(sim);
  const name = settingName(sim);
  const geo = geometry(sim);

  const live = svgEl(doc, 'g', 'explorable-live');
  const trail = svgEl(doc, 'path', 'explorable-trail');
  trail.setAttribute('fill', 'none');
  const ball = svgEl(doc, 'circle', 'explorable-ball');
  ball.setAttribute('r', '7');
  live.append(trail, ball);
  svg.appendChild(live);

  const box = doc.createElement('div');
  box.className = 'explorable-controls';
  box.setAttribute('data-eli5-noact', '');
  const id = `eli5-explorable-${n}`;
  const label = doc.createElement('label');
  label.htmlFor = id;
  label.textContent = name.charAt(0).toUpperCase() + name.slice(1);
  const input = doc.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = '0';
  input.max = String(RES);
  input.step = '1';
  const out = doc.createElement('output');
  out.htmlFor.add(id);
  const presets = sim.presets.map((p) => {
    const b = button(doc, fmtNum(p), `${name} ${fmtNum(p)}`);
    b.addEventListener('click', () => choose(p));
    return b;
  });
  const play = button(doc, 'Play');
  play.setAttribute('aria-pressed', 'false');
  const step = button(doc, 'Step');
  const reset = button(doc, 'Reset');
  const status = doc.createElement('p');
  status.className = 'explorable-status';
  status.setAttribute('aria-live', 'polite');
  const row1 = doc.createElement('div');
  row1.className = 'explorable-row';
  row1.append(label, input, out);
  const row2 = doc.createElement('div');
  row2.className = 'explorable-row';
  row2.append(...presets, play, step, reset);
  box.append(row1, row2, status);
  svg.after(box);
  fig.classList.add('explorable--live');

  let v = range.value;
  let xs: number[] = [];
  let summary = '';
  let i = 0;
  let frame = 0;
  let last = 0;
  let acc = 0;

  const end = (): number => xs.length - 1;
  const draw = (): void => {
    const [x, y] = geo.at(xs[i] ?? 0);
    ball.setAttribute('cx', x.toFixed(1));
    ball.setAttribute('cy', y.toFixed(1));
    trail.setAttribute('d', geo.trail(xs.slice(0, i + 1)));
    step.disabled = !reduce && i >= end();
  };
  const say = (): void => {
    status.textContent = i >= end() ? summary : `Step ${i} of ${end()}, ${name} ${fmtNum(v)}`;
  };
  const pause = (): void => {
    if (!frame) return;
    win.cancelAnimationFrame(frame);
    frame = 0;
    play.textContent = 'Play';
    play.setAttribute('aria-pressed', 'false');
    // The status no longer says "Playing" once the run stops (end, Pause, hidden or off screen).
    say();
  };
  const tick = (t: number): void => {
    acc += last ? t - last : 0;
    last = t;
    const ms = Math.min(STEP_MS[1], Math.max(STEP_MS[0], RUN_MS / Math.max(1, end())));
    const k = Math.floor(acc / ms);
    acc -= k * ms;
    i = Math.min(end(), i + k);
    draw();
    if (i >= end()) {
      pause();
      return;
    }
    frame = win.requestAnimationFrame(tick);
  };
  const start = (): void => {
    if (reduce) {
      // 07 §14: no tweening with reduced motion; the whole run is shown at once.
      i = end();
      draw();
      say();
      return;
    }
    if (i >= end()) i = 0;
    last = 0;
    acc = 0;
    play.textContent = 'Pause';
    play.setAttribute('aria-pressed', 'true');
    status.textContent = `Playing, ${name} ${fmtNum(v)}`;
    frame = win.requestAnimationFrame(tick);
  };
  const restart = (): void => {
    pause();
    i = reduce ? end() : 0;
    draw();
    status.textContent = reduce ? summary : `${label.textContent} ${fmtNum(v)}. Press Play or Step.`;
  };
  const choose = (value: number, fromInput = false): void => {
    v = value;
    if (!fromInput) input.value = String(Math.round(toSlider(range, v) * RES));
    const text = `${name} ${fmtNum(v)}`;
    input.setAttribute('aria-valuetext', text);
    out.textContent = fmtNum(v);
    for (const [k, b] of presets.entries()) b.setAttribute('aria-pressed', sim.presets[k] === v ? 'true' : 'false');
    xs = sim.kind === 'gradient-descent' ? runGD(sim, v).xs : runMH(sim, v).xs;
    summary = outcomeRow(sim, v).label;
    restart();
  };

  input.addEventListener('input', () => choose(fromSlider(range, Number(input.value) / RES), true));
  play.addEventListener('click', () => (frame ? pause() : start()));
  step.addEventListener('click', () => {
    pause();
    if (reduce && i >= end()) i = 0;
    i = Math.min(end(), i + 1);
    draw();
    say();
  });
  reset.addEventListener('click', restart);
  const IO = (win as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  if (IO) new IO((es) => es.forEach((e) => e.isIntersecting || pause())).observe(fig);
  choose(range.value);
  return { pause };
}

/** Boots every explorable; all pause when the page is hidden or the tab changes. */
export function initExplorables(
  doc: Document,
  win: Window,
  tabs?: { onChange(cb: (key: string) => void): void },
): ExplorablePlayer[] {
  const players: ExplorablePlayer[] = [];
  const figs = doc.querySelectorAll<HTMLElement>('figure.explorable[data-params]');
  if (!figs.length) return players;
  const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  figs.forEach((fig, n) => {
    try {
      const p = setupExplorable(fig, doc, win, reduce, n);
      if (p) players.push(p);
    } catch (e) {
      // One broken figure keeps its static picture; the others still work.
      console.error('eli5 runtime: explorable failed', e);
    }
  });
  if (!players.length) return players;
  const pauseAll = (): void => players.forEach((p) => p.pause());
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') pauseAll();
  });
  tabs?.onChange(pauseAll);
  return players;
}
