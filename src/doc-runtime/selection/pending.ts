// Pending-passage marker (08 §5.2 step 5): the passage stays marked while the menu is open. Drawn
// from the range's own line boxes (Range.getClientRects of each selected text run), so it matches
// the native selection in every engine; the CSS Custom Highlight API drifted from the selection in
// WebKit next to a ::first-letter drop cap.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

type RectSource = { getClientRects(): ArrayLike<{ left: number; top: number; width: number; height: number }> };

/** Client rects of every text run of `range`, skipping runs inside `excluded` (glossary notes, …). */
export function pendingRects(range: Range, excluded: string): Box[] {
  const doc = range.startContainer.ownerDocument ?? (range.startContainer as Document);
  const rootNode = range.commonAncestorContainer;
  const out: Box[] = [];
  const add = (r: Range): void => {
    const src = r as unknown as Partial<RectSource>;
    if (typeof src.getClientRects !== 'function') return;
    const list = src.getClientRects();
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b && b.width > 0.5 && b.height > 0.5)
        out.push({ left: b.left, top: b.top, width: b.width, height: b.height });
    }
  };
  const texts: Text[] = [];
  if (rootNode.nodeType === 3) texts.push(rootNode as Text);
  else {
    const walker = doc.createTreeWalker(rootNode, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n)) texts.push(n as Text);
  }
  for (const t of texts) {
    if (!t.data.trim()) continue;
    if (t.parentElement?.closest(excluded)) continue;
    const r = doc.createRange();
    r.selectNodeContents(t);
    if (t === range.startContainer) r.setStart(t, range.startOffset);
    if (t === range.endContainer) r.setEnd(t, range.endOffset);
    if (r.collapsed) continue;
    add(r);
  }
  return out;
}

/** Replaces the layer's boxes with `rects` (client coordinates) placed in document coordinates. */
export function drawPending(layer: HTMLElement, rects: readonly Box[], scroll: { x: number; y: number }): void {
  const doc = layer.ownerDocument;
  layer.replaceChildren(
    ...rects.map((b) => {
      const d = doc.createElement('div');
      d.style.left = `${String(Math.round((b.left + scroll.x) * 100) / 100)}px`;
      d.style.top = `${String(Math.round((b.top + scroll.y) * 100) / 100)}px`;
      d.style.width = `${String(Math.round(b.width * 100) / 100)}px`;
      d.style.height = `${String(Math.round(b.height * 100) / 100)}px`;
      return d;
    }),
  );
  layer.hidden = rects.length === 0;
}
