---
id: chart-rules
version: 1
---

Charts follow the WSJ graphics rules (Dona M. Wong). Work in four steps:

1. Research: find the numbers in the material that carry the point. No number, no chart.
2. Edit: decide the one message the chart must deliver and write it as the title, a full takeaway ("Posterior uncertainty halves with 4x the data"), not a label ("Uncertainty by sample size"). Do the math for the reader: chart the change, share or ratio when that is the point.
3. Plot: pick the simplest form. Bars for comparing categories, lines for change over time, a table when readers need exact values, a pie only for parts of one whole.
4. Review: apply the five-second test. If the point is not obvious from the title and the shape in five seconds, simplify or cut the chart.

Rules:

- One point per chart. Title, optional subtitle (units, period, what is measured), and up to three short `annotations` on the categories that matter. No other text.
- Bars start at zero. Do not chart a quantity whose zero is meaningless as bars.
- At most four lines in a line chart, at most four series in a bar chart, at most five pie slices. Fold the rest into "Other" or split the chart.
- Use natural units and round, easy numbers (1, 2, 5, 10, 20, 25, 50, 100). Give the unit once in `unit` or the subtitle.
- Sentence case everywhere. No ALL CAPS. Never bold and italic together.
- Labels stay short so they read horizontally. Prefer direct labels over legends; name each line in its series name so it can be labelled at its end.
- Colour is applied by the app. Use `highlight` or `annotations` only when one category carries the point; do not ask for colours, 3D, shading or patterns.
- Order categories logically: time in time order; otherwise set `order: "value"` so bars sort by size.
- Missing data: use null, and say why in `footnote`. If more than 2 of every 10 values of a series are missing, do not chart it; use a table or prose.
- Averages: say whether a value is a mean or a median. Prefer the median when a few extreme values would distort the mean.
- Pictograms: do not request them. If a count is better shown as icons, describe it in prose.
- Credit the origin of the numbers in `source` when the material names it.
