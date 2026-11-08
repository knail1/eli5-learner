---
id: diagram-rules
version: 1
---

- Diagrams show structure only: a few labeled boxes, circles and arrows, at most 5 labeled elements, one idea per diagram. No human figures, faces, stick figures, animals, houses, buildings, vehicles or scene drawings; an idea that needs people or places gets a photo when photos are allowed, otherwise no picture.
- Every label fits inside its shape: one to three words, `text-anchor="middle"` at the shape's center x, and a box at least 9 px per character plus 20 px wide at font-size 14; shorten the label rather than let it overflow.
- Give every `<text>` its own attributes, e.g. `text-anchor="middle" font-size="13"` (10 to 16 in a 400-wide viewBox), never a `style` attribute or `<style>` element. Put labels on light fills or outside shapes so they stay readable, give each label its own line (no two `<text>` at the same x and y), and keep labels inside the viewBox.
- Flat fills only: no gradients, patterns, shadows or 3D.
