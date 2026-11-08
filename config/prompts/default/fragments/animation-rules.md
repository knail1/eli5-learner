---
id: animation-rules
version: 1
---

Animations: an `animation` block is a small interactive you write yourself for THIS document's topic. Use one only when the topic has a mechanism, process, trade-off or dynamic that motion or a control makes clearer than a static chart; otherwise use a chart, stepper or diagram. Examples of the style, not a menu: the learning rate of gradient descent on a loss curve (only for a document about gradient descent), a sampler's random walk (only for MCMC), shrinkage pulling group estimates toward the mean (only for multilevel models), a prior and a likelihood combining as data arrive (only for Bayesian updating). Choose the animation that teaches this document's core idea; never reuse an example unless the topic is that example.

- One idea per animation, with 1 or 2 controls whose extremes show the failure modes (add "too small / just right / too big" buttons where that is meaningful) and a visible numeric readout. Labels in plain words.
- Deterministic: use `ELI5.rng(seed)`, never `Math.random`, so it matches the caption. At most about 150 lines of plain JavaScript.
- Fields: `title` (a takeaway, at most 90 characters), `caption` (what to try and what to notice, at most 300), `alt` (what the poster shows, at most 400), `poster` (an SVG still frame of the key insight, same rules as diagrams), optional `html` (at most 4 KB) and `css` (at most 4 KB) for the stage, and `js` (at most 16 KB).
- The code runs in a locked-down frame with no network and no access to the page. Never call or reference these APIs: fetch, XMLHttpRequest, WebSocket, workers, import, eval, Function, timers with string code, location, open, window.top, window.parent, opener, postMessage, document.cookie, storage, navigator, `window[...]`, `this[...]`, innerHTML and other HTML-string APIs, iframes, forms, links, external URLs or `url(...)` other than data: URLs. Plain words in labels are fine ("Cookies left", "cost of import"); never name your own variables `location`, `window` or `self`. Code that breaks a rule is removed.
- Use only these helpers (default container: the stage; controls go in a row under it):
  - `ELI5.slider(label, min, max, step, value, onChange)` returns `{ el, value, set(v) }`; it shows the value and announces it to screen readers.
  - `ELI5.button(label, onClick)`, `ELI5.readout(label)` returns `{ set(text) }`.
  - `ELI5.canvas(w, h)` returns `{ canvas, ctx, w, h }` (draw in w by h units; it scales to the width), `ELI5.svg(w, h)` returns an SVG element, `ELI5.el(name, attrs, parent)` creates SVG shapes and text (svg, g, path, line, rect, circle, ellipse, polyline, polygon, text, tspan) or simple HTML (div, span, p, strong, em, label, output, button, input, ul, ol, li, table cells); no links, `href`, `src` or `on…` attributes (use addEventListener).
  - `ELI5.raf(fn)` runs `fn(dtMs, tMs)` every frame until it returns false; returns `{ stop() }`. It pauses off screen. With reduced motion it runs to the end at once, so show the final state and offer a Step button.
  - `ELI5.palette` gives `{ paper, ink, muted, grid, accent, series: [8 colors] }` for the current theme; `ELI5.onTheme(fn)` redraws on a theme change. `ELI5.reducedMotion` is true when the reader asked for less motion.
- It must work at 320 px wide and in dark mode. At most one animation per section and two per tab.
- In an ELI5 tab, keep it simpler: one control, big shapes, an everyday analogy.
- An existing animation appears as `"poster": "keep"` and `"js": "keep"`. Return that block unchanged to keep it (you may improve its title, caption and alt), or leave it out to remove it. Never write new code for it.
