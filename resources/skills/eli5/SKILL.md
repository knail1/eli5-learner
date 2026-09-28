---
name: eli5
slot: eli5
appliesTo: [eli5, section]
---

Bundled default for the "ELI5" slot (02 §11). A user skill with the same name replaces it.

Adapted from the vendored upstream `eli5` skill (`upstream/`, see `../THIRD_PARTY.md`), whose whole
instruction is: *explain like I'm someone who knows nothing about this topic, with big pictures and few
words.* In this app that means pictures first, and the words around them stay short.

### Pictures: photos for the world, diagrams for structure

The reader wants a picture in **every section**, the way a picture book shows each idea. Pick the
kind of picture by what the idea is:

- **Real-world scenes get a photo.** People, places, objects in the world, and what an experience
  looks like (a courtroom, a worried person at a laptop, a warehouse aisle) get a `photo` block when
  the prompt allows photos. The app finds an open-licensed stock photo, shows it small with a credit
  and "Illustrative stock photo", and drops the block when nothing fits, so never mention the photo
  in the text.
  - `query`: 2 to 5 lowercase, generic words for what is visible ("courthouse exterior", "hands
    typing on laptop"). It is sent to a public photo search, so it never names people,
    organizations, places, products or case details, and never quotes the sources.
  - `purpose`: one sentence on what the photo should show and why. `alt`: the ideal photo in plain
    words. `caption` (optional): one short sentence.
  - `sensitive: true` for crime, victims, abuse, health or grief: only photos without identifiable
    faces are used then (hands, silhouettes, empty rooms, objects).
  - At most one photo per section. When the prompt says not to use photos, such a section gets no
    picture unless a structured diagram fits.
  - When you rewrite one section, keep its existing `figure` blocks as they are and add no new
    `photo` blocks: photos are only found when a document is created.
- **Structured ideas get a diagram.** Lists of parts, flows, comparisons, timelines and cycles get a
  `diagram` block: a clean inline SVG of a few labeled boxes, circles and arrows (a box listing four
  kinds of stolen data, three steps joined by arrows, two columns side by side).
  - **Never draw people, faces, stick figures, animals, houses, buildings, vehicles or scenes** in
    SVG. Those drawings come out crude; use a photo for them, or no picture.
  - **At most 5 labeled elements**, one idea per diagram, generous spacing, soft fills.
  - **Labels fit inside their shapes**: one to three words, `text-anchor="middle"` at the shape's
    center x, font-size 12 to 16 in a 400-wide viewBox, and a box at least 9 px per character plus
    20 px wide at font-size 14. Shorten the label rather than let it overflow. Dark text on light
    fills, and never two labels on top of each other.
  - Give every `diagram` a short `title` and a plain-words `alt` text. Keep each SVG small and
    self-contained: basic shapes and text only, no images, fonts or scripts.
- **The pictures tell the story on their own.** Someone who only looks at the pictures, section by
  section, should get the main idea.
- Use a `stepper` or a simple `chart` in addition when order or amounts matter, never instead of the
  picture.

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
- **Big pictures, few words.** One picture per section (a photo or a diagram, above) and paragraphs of two or
  three short sentences. If a picture can say it, cut the sentence.
- **Finish with the takeaway** in one or two sentences the reader could repeat to a colleague.
