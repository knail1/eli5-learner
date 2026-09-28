---
name: beautiful-doc
slot: beautiful-doc
appliesTo: [indepth, section]
---

Bundled default for the "beautiful documentation" slot (02 §11). It records the explanatory-graphics
patterns used by strong newspaper feature desks and the "rich single-file HTML over Markdown" approach,
translated into the block types this app renders. A user skill with the same name replaces it.

### Structure

- **Lead with the point.** The title states the subject; the dek (one sentence) states why it matters now.
  The first section answers "so what?" before any background.
- **Nut graf early.** Within the first two sections, say in two or three sentences what the whole piece
  will show and why the reader should care.
- **Then structure, then detail.** Walk from the big moving parts to the mechanisms, and only then to
  exceptions and fine print. Each section heading is a plain statement, not a pun.
- **Explain the insider's assumptions.** When the material relies on context its original audience
  shared, name it in a callout (`tone: "note"`).

### Graphics-first explaining

- **Chart titles are takeaways.** "Costs doubled after the switch", not "Costs by quarter". Put the
  neutral description in the subtitle, the unit in `unit`, and the origin in `source`.
- **One chart, one idea.** Prefer a bar chart for comparisons across categories, a line chart for change
  over time, a stacked bar for composition, a scatter only for a real relationship. Avoid pie charts
  unless there are at most four parts of one whole.
- **Highlight the point.** Use `highlight` to annotate the single category that carries the story.
- **Annotated figures.** When a screenshot or slide is essential, use a `figure` with a caption that says
  what to look at, and at most three short annotations.
- **Steppers for processes.** Anything with an order (a pipeline, a lifecycle, a decision) becomes a
  `stepper` of three to seven steps with short labels.
- **Tables for exact values** the reader may want to look up; charts for patterns they should see.
- **Diagrams sparingly.** A small inline SVG only when layout carries meaning (a flow, a hierarchy).
  Keep it simple: boxes, arrows, short labels, no embedded fonts or scripts.

### Voice and texture

- Short paragraphs, concrete nouns, active verbs. Numbers with units and context ("up 12% from a year
  earlier").
- **Pull quotes** only for a genuinely striking line from the material, attributed.
- **Callouts** for the one key point of a section (`keypoint`) and for caveats (`warning`).
- End sections with a sentence that sets up the next one; end the piece with what to watch next.

### Design language (html-effectiveness)

Adapted from the vendored [html-effectiveness](html-effectiveness/) gallery (Apache-2.0, see
`../THIRD_PARTY.md`) and its "rich single-file HTML over Markdown" approach. The palette and type live in
`theme.css` next to this file, so write for that look: warm ivory paper, serif headlines, sans prose,
one clay accent.

- **Lead with the answer.** The first section opens with the finding in one or two sentences, then a
  `table` or `chart` of the three or four numbers that carry it. Never make the reader scroll to learn
  the conclusion.
- **Every number is real and sourced.** Only use figures that appear in the source material; name where
  each came from in the chart `source` or the sentence. If something is an estimate, say so. If the
  material does not give a number, say that plainly instead of inventing one.
- **Restraint with emphasis.** At most one `keypoint` callout and one highlighted chart category per
  section. A `warning` callout is for a real problem, not decoration.
- **Bars before anything fancier.** A horizontal bar comparison with clear labels beats a pie or a
  multi-series chart. Use `diagram` only when the shape of the thing is the point.
- **Findings, then what to do.** When the material implies actions or open questions, end with them,
  ordered by importance, each with what it costs and what it gets back when the source says so.
