/**
 * A hand-written topic animation for the showcase golden (07 §7.1 animation): the showcase is about
 * getting a widget to the customer, so the animation shows why the packing line backs up when
 * orders arrive faster than the packers can pack them. One control (packers on shift) whose low end
 * shows the failure mode, a numeric readout, seeded randomness, ELI5.* helpers only.
 */
import type { DraftBlock } from '../../../src/main/llm';

export type AnimationDraft = Extract<DraftBlock, { type: 'animation' }>;

export const PACKING_JS = `var W = 480, H = 220, MINUTES = 60, ARRIVALS = 5, PER_PACKER = 2, MAX = 120;
var view = ELI5.canvas(W, H);
var out = ELI5.readout('Orders waiting after 60 minutes');
var packers = 3, run = null;

function simulate(n) {
  var rng = ELI5.rng(42), q = 0, line = [0];
  for (var m = 0; m < MINUTES; m++) {
    var arrived = 0;
    for (var k = 0; k < 10; k++) if (rng() < ARRIVALS / 10) arrived++;
    q = Math.max(0, q + arrived - n * PER_PACKER);
    line.push(q);
  }
  return line;
}

function draw(line, upTo) {
  var c = view.ctx, p = ELI5.palette;
  c.clearRect(0, 0, W, H);
  c.strokeStyle = p.muted;
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(34, 10);
  c.lineTo(34, H - 22);
  c.lineTo(W - 8, H - 22);
  c.stroke();
  c.fillStyle = p.ink;
  c.font = '12px system-ui, sans-serif';
  c.fillText('waiting', 2, 12);
  c.fillText('minutes', W - 56, H - 6);
  c.strokeStyle = p.series[0];
  c.lineWidth = 3;
  c.beginPath();
  for (var i = 0; i <= upTo; i++) {
    var x = 34 + ((W - 42) * i) / MINUTES;
    var y = H - 22 - ((H - 34) * Math.min(line[i], MAX)) / MAX;
    if (i) c.lineTo(x, y);
    else c.moveTo(x, y);
  }
  c.stroke();
}

function start() {
  if (run) run.stop();
  var line = simulate(packers), t = 0;
  out.set('counting…');
  run = ELI5.raf(function (dt) {
    t = Math.min(MINUTES, t + dt / 50);
    draw(line, Math.floor(t));
    if (t >= MINUTES) {
      out.set(String(line[MINUTES]));
      return false;
    }
  });
}

ELI5.slider('Packers on shift', 1, 6, 1, packers, function (v) {
  packers = v;
  start();
});
ELI5.button('Replay', start);
ELI5.onTheme(start);
start();
`;

export const PACKING_POSTER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 250">' +
  '<line x1="40" y1="20" x2="40" y2="210" stroke="#5a5a5a" stroke-width="1"/>' +
  '<line x1="40" y1="210" x2="380" y2="210" stroke="#5a5a5a" stroke-width="1"/>' +
  '<polyline points="40,210 120,190 200,165 280,135 360,105" fill="none" stroke="#d55e00" stroke-width="3"/>' +
  '<polyline points="40,210 120,205 200,207 280,204 360,206" fill="none" stroke="#0072b2" stroke-width="3"/>' +
  '<text x="300" y="100" font-size="14" text-anchor="middle">2 packers</text>' +
  '<text x="300" y="192" font-size="14" text-anchor="middle">3 packers</text>' +
  '<text x="210" y="238" font-size="13" text-anchor="middle">minutes</text>' +
  '</svg>';

export const PACKING_ANIMATION: AnimationDraft = {
  type: 'animation',
  title: 'One packer short and the line never catches up',
  caption:
    'Drag the number of packers. With 3 or more the queue stays short; with 2 or fewer it grows all hour, because orders arrive faster than they are packed.',
  alt: 'A line chart of orders waiting over 60 minutes: with 3 packers the line stays near zero, with 2 packers it climbs steadily.',
  poster: PACKING_POSTER,
  css: '#eli5-anim canvas { border-radius: 6px; }',
  js: PACKING_JS,
};
