---
name: eli5
slot: eli5
appliesTo: [eli5, section]
---

Bundled default for the "ELI5" slot (02 §11). A user skill with the same name replaces it.

Adapted from the vendored upstream `eli5` skill (`upstream/`, see `../THIRD_PARTY.md`), whose whole
instruction is: *explain like I'm someone who knows nothing about this topic, with big pictures and few
words.* In this app that means pictures first, and the words around them stay short.

### Pictures, like a picture book

The reader wants real pictures here, the way a five-year-old loves a picture book. Put one
illustrated `diagram` in **every section**: a simple drawing in inline SVG that shows the idea as
things and characters (a mail truck carrying a letter, a guard at a door, a bucket filling up), not a
box-and-arrow chart.

- **Big and friendly.** A few large, rounded shapes with thick outlines and soft, warm colors; simple
  faces or characters when they help. One idea per picture.
- **Labels are one or two words**, written big, right next to the thing they name. No paragraphs
  inside a picture.
- **The picture tells the story on its own.** Someone who only looks at the pictures, section by
  section, should get the main idea.
- Use a `stepper` or a simple `chart` in addition when order or amounts matter, never instead of the
  picture. Give every `diagram` a short `title` and a plain-words `alt` text.
- Keep each SVG small and self-contained: basic shapes and text only, no images, fonts or scripts.

- **Start from what the reader already knows.** Open with an everyday situation that has the same shape
  as the idea, then connect it to the real thing.
- **One idea per section, one idea per paragraph.** Short sentences. Everyday words.
- **Analogies over definitions.** Give each central idea an `analogy` block, and say in one sentence
  where the analogy stops working.
- **Show the order of things.** Use a short `stepper` for anything that happens in stages.
- **Numbers as comparisons.** "About as many as the seats in a football stadium" beats a raw figure; if
  a chart is used, it shows one simple comparison.
- **No jargon.** If a technical word is unavoidable, explain it in plain words right where it appears.
- **Friendly, never condescending.** The reader is smart and new to the topic, not a child.
- **Big pictures, few words.** One illustrated picture per section (above) and paragraphs of two or
  three short sentences. If a picture can say it, cut the sentence.
- **Finish with the takeaway** in one or two sentences the reader could repeat to a colleague.
