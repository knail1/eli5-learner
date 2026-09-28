/** ExtractedContent invariants (04 §2). A violation is an extractor bug (04 §3 step 4). */
import { hasForbiddenChars } from './text-util';
import type { ContentBlock, ExtractedContent, ListItem } from './types';

function listTexts(items: readonly ListItem[], out: string[]): void {
  for (const it of items) {
    out.push(it.text);
    if (it.children) listTexts(it.children, out);
  }
}

function walk(blocks: readonly ContentBlock[], nested: boolean, refs: string[], texts: string[]): string | null {
  for (const b of blocks) {
    switch (b.kind) {
      case 'slide':
      case 'page': {
        if (nested) return `${b.kind} block nested inside a slide or page`;
        if (b.kind === 'slide' && b.title !== undefined) texts.push(b.title);
        if (b.kind === 'slide' && b.notes) texts.push(b.notes.text);
        const e = walk(b.blocks, true, refs, texts);
        if (e) return e;
        break;
      }
      case 'image':
        refs.push(b.imageId);
        if (b.alt !== undefined) texts.push(b.alt);
        break;
      case 'heading':
      case 'paragraph':
      case 'notes':
        texts.push(b.text);
        break;
      case 'list':
        listTexts(b.items, texts);
        break;
      case 'table':
        if (b.caption !== undefined) texts.push(b.caption);
        texts.push(...(b.header ?? []));
        for (const r of b.rows) texts.push(...r);
        break;
    }
  }
  return null;
}

/** Returns a description of the first violation, or null when the content is valid. */
export function checkInvariants(c: ExtractedContent): string | null {
  const refs: string[] = [];
  const texts: string[] = [];
  const nestErr = walk(c.blocks, false, refs, texts);
  if (nestErr) return nestErr;
  const ids = c.images.map((i) => i.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) return 'duplicate image id';
  const refSet = new Set(refs);
  for (const r of refSet) if (!idSet.has(r)) return 'image block without an image asset';
  for (const id of ids) if (!refSet.has(id)) return 'image asset never referenced';
  for (const i of c.images) if (i.byteLength !== i.data.byteLength) return 'image byteLength mismatch';
  for (const t of texts) if (hasForbiddenChars(t)) return 'text not NFC or has control characters';
  return null;
}
