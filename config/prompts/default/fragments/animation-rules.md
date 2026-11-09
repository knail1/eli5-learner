---
id: animation-rules
version: 5
---

Animations: an `animation` block is a small interactive you design and write yourself for THIS document's topic. Use one only when the topic has a mechanism, process, trade-off or dynamic that motion or a control makes clearer than a static chart; otherwise use a chart, stepper or diagram, and most documents need no animation at all. There is no default animation and no menu of kinds. Start from the one idea the reader must grasp, then ask what they should change and what they should watch.

Examples of the style, each right only for its own topic:

- Gradient descent: drag the learning rate and watch steps on a loss curve crawl, settle or overshoot.
- Queues and capacity: drag the arrival rate toward the service rate and watch the waiting line explode.
- Compound growth: drag the rate or the years and watch the gap between simple and compound growth widen.
- Epidemics: drag the contact rate across the threshold and watch an outbreak fade or take off.
- Supply and demand: shift one curve and watch the price and quantity move to the new crossing.
- Bayesian updating: add data points and watch the prior and the likelihood combine.

Never reuse an example whose topic is not this document's topic: a document about queues gets no loss curve, a document about epidemics gets no supply curve. If none of the examples fits, design a new one that fits.

- One idea per animation, with 1 or 2 controls whose extremes show the failure modes (add "too small / just right / too big" buttons where that is meaningful) and a visible numeric readout. Labels in plain words.
- Deterministic: use `ELI5.rng(seed)`, never `Math.random`, so it matches the caption. At most about 150 lines of plain JavaScript.
- Fields: `title` (a takeaway, at most 90 characters), `caption` (what to try and what to notice, at most 300), `alt` (what the poster shows, at most 400), `poster` (an SVG still frame of the key insight, same rules as diagrams), optional `html` (at most 4 KB) and `css` (at most 4 KB) for the stage, and `js` (at most 16 KB).
- The code runs in a locked-down frame with no network and no access to the page. Never call or reference these APIs: fetch, XMLHttpRequest, WebSocket, workers, import, eval, Function, timers with string code, location, open, window.top, window.parent, opener, postMessage, document.cookie, storage, navigator, customElements, `window`, `globalThis`, `window[...]`, `this[...]`, innerHTML and other HTML-string APIs, cloneNode, importNode, `navigation`, `http-equiv` or a refresh, iframes, forms, links, external URLs (anywhere in a string, even split into pieces) or `url(...)` other than data: URLs. Plain words in labels are fine ("Cookies left", "cost of import"), and so are your own properties (`peak.location`, `jar.cookie`) and your own declared names (`let frames = 0`, `class Worker`). Never name your own variables `location`, `window`, `globalThis` or `document`; never pass `this` as an argument except as `.bind(this)`, `.call(this, …)` or `.apply(this, …)`; never build a property name by joining strings inside `[...]` (`x['a' + b]`). Code that breaks a rule is removed.
- Use only these helpers (default container: the stage; controls go in a row under it):
  - `ELI5.slider(label, min, max, step, value, onChange)` returns `{ el, value, set(v) }`; it shows the value and announces it to screen readers.
  - `ELI5.button(label, onClick)`, `ELI5.readout(label)` returns `{ set(text) }`.
  - `ELI5.canvas(w, h)` returns `{ canvas, ctx, w, h }` (draw in w by h units; it scales to the width), `ELI5.svg(w, h)` returns an SVG element, `ELI5.el(name, attrs, parent)` creates SVG shapes and text (svg, g, path, line, rect, circle, ellipse, polyline, polygon, text, tspan) or simple HTML (div, span, p, strong, em, label, output, button, input, ul, ol, li, table cells); no links, `href`, `src` or `on…` attributes (use addEventListener).
  - `ELI5.raf(fn)` runs `fn(dtMs, tMs)` every frame until it returns false; returns `{ stop() }`. It pauses off screen. With reduced motion it runs to the end at once, so show the final state and offer a Step button.
  - `ELI5.palette` gives `{ paper, ink, muted, grid, accent, series: [8 colors] }` for the current theme; `accent` marks the one thing in focus, so draw every other data mark around it (other curves, points, bars, particles) in `muted` or `ink`, never in a series colour (the first series colour is close to it). `grid` is only for gridlines and background shapes, never for data: it is too faint to read. `ELI5.onTheme(fn)` redraws on a theme change. `ELI5.reducedMotion` is true when the reader asked for less motion.
- It must work at 320 px wide and in dark mode. At most one animation per section and two per tab.
- In an ELI5 tab, keep it simpler: one control, big shapes, an everyday analogy.
- An existing animation appears as `"poster": "keep"` and `"js": "keep"`. Return that block unchanged to keep it (you may improve its title, caption and alt), or leave it out to remove it. Never write new code for it.
