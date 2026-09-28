// Stock photo slots (07 §7.4): collect the drafts' `photo` blocks under the limits, search, show a
// few thumbnails per slot to one vision call, then download, downscale and credit the chosen photos.
// Fire-and-forget: every failure means "no photo" for that slot; only cancellation is rethrown.
import { photoSlotKey, type AssetCredit, type StockPhotoInput } from '../document';
import { sectionText, type DocumentDraftTab, type ImageInput, type PhotoPickSlot } from '../llm';
import type { Logger } from '../security';
import { throwIfAborted } from './abort';
import type { PhotoImageOps } from './image';
import { PHOTO_LIMITS, type PhotoLimits } from './limits';
import { properNounsOf, sanitizePhotoQuery } from './query';
import type { StockCandidate, StockImageProvider } from './types';

export interface PhotoSlot {
  key: string; // photoSlotKey(tab, sectionIndex, blockIndex)
  tab: 'indepth' | 'eli5';
  sectionIndex: number;
  blockIndex: number;
  query: string; // sanitized
  purpose: string;
  alt: string;
  caption: string;
  sensitive: boolean;
}

const ws = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The photo slots to fill, ELI5 first: at most one per section, two in the in-depth tab and six per
 * document. Queries go through sanitizePhotoQuery with the drafts' proper nouns; a slot whose query
 * has nothing generic left is dropped.
 */
export function collectPhotoSlots(
  drafts: { indepth: DocumentDraftTab; eli5: DocumentDraftTab | null },
  limits: Pick<PhotoLimits, 'MAX_PER_DOCUMENT' | 'MAX_PER_SECTION' | 'MAX_INDEPTH'> = PHOTO_LIMITS,
): PhotoSlot[] {
  // Names are learned from body text only: headings are often in title case, and a photo block's
  // own words would mark its query as a name.
  const bodies = [...drafts.indepth.sections, ...(drafts.eli5?.sections ?? [])].map((s) =>
    sectionText({ heading: '', blocks: s.blocks.filter((b) => b.type !== 'photo') }),
  );
  const names = properNounsOf(bodies);
  const out: PhotoSlot[] = [];
  const take = (tab: 'indepth' | 'eli5', draft: DocumentDraftTab, tabCap: number): void => {
    let inTab = 0;
    draft.sections.forEach((s, si) => {
      let inSection = 0;
      s.blocks.forEach((b, bi) => {
        if (b.type !== 'photo') return;
        if (out.length >= limits.MAX_PER_DOCUMENT || inTab >= tabCap || inSection >= limits.MAX_PER_SECTION) return;
        const query = sanitizePhotoQuery(b.query, names);
        if (!query) return;
        inTab++;
        inSection++;
        out.push({
          key: photoSlotKey(tab, si, bi),
          tab,
          sectionIndex: si,
          blockIndex: bi,
          query,
          purpose: ws(b.purpose),
          alt: ws(b.alt),
          caption: ws(b.caption),
          sensitive: b.sensitive === true,
        });
      });
    });
  };
  if (drafts.eli5) take('eli5', drafts.eli5, limits.MAX_PER_DOCUMENT);
  take('indepth', drafts.indepth, limits.MAX_INDEPTH);
  return out;
}

/** The credit a candidate carries into the document (07 §7.4). */
export function photoCredit(c: StockCandidate): AssetCredit {
  return {
    kind: 'stock-photo',
    title: c.title,
    ...(c.creator ? { creator: c.creator } : {}),
    license: c.license,
    ...(c.licenseVersion ? { licenseVersion: c.licenseVersion } : {}),
    ...(c.licenseUrl ? { licenseUrl: c.licenseUrl } : {}),
    ...(c.landingUrl ? { sourceUrl: c.landingUrl } : {}),
    sourceName: c.sourceName,
    via: c.via,
  };
}

export interface PhotoPickRequest {
  slots: PhotoPickSlot[];
  images: ImageInput[];
  signal: AbortSignal;
}

/** The LLM pick (tasks.pickPhotos): candidate 1..n per slot id, 0 = none fits. */
export type PhotoPicker = (
  r: PhotoPickRequest,
) => Promise<{ picks: readonly { slot: string; candidate: number }[]; prompt?: string }>;

export interface ResolvePhotosDeps {
  provider: StockImageProvider;
  image: PhotoImageOps;
  pick: PhotoPicker;
  signal: AbortSignal;
  log?: Logger;
  jobId?: string;
  limits?: Partial<PhotoLimits>;
}

export interface ResolvedPhotos {
  photos: StockPhotoInput[];
  /** "photo-pick@<version>" when a pick call ran. */
  prompt?: string;
}

interface Offered {
  slot: PhotoSlot;
  id: string; // "s1"
  candidates: { c: StockCandidate; source: Uint8Array; thumb: Uint8Array }[];
}

function licenseLabel(c: StockCandidate): string {
  const v = c.licenseVersion ? ` ${c.licenseVersion}` : '';
  return { cc0: 'CC0', pdm: 'Public Domain Mark', by: 'CC BY', 'by-sa': 'CC BY-SA' }[c.license] + v;
}

async function quiet<T>(signal: AbortSignal, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (signal.aborted) throw e;
    return fallback;
  }
}

export async function resolvePhotos(slots: readonly PhotoSlot[], deps: ResolvePhotosDeps): Promise<ResolvedPhotos> {
  const L = { ...PHOTO_LIMITS, ...deps.limits };
  const { signal, provider, image } = deps;
  const log = (event: string, count: number): void => {
    deps.log?.info(event, { ...(deps.jobId ? { jobId: deps.jobId } : {}), provider: provider.id, count });
  };
  throwIfAborted(signal);
  if (slots.length === 0) return { photos: [] };

  // 1. Search and thumbnails, one slot at a time (fetch politeness paces each host).
  const offered: Offered[] = [];
  for (const slot of slots) {
    throwIfAborted(signal);
    const found = await quiet(
      signal,
      () => provider.search(slot.query, { signal, limit: L.CANDIDATES_PER_SLOT * 2 }),
      [] as StockCandidate[],
    );
    const candidates: Offered['candidates'] = [];
    for (const c of found) {
      if (candidates.length >= L.CANDIDATES_PER_SLOT) break;
      const source = await quiet(signal, () => provider.download(c, 'thumb', { signal }), null);
      const thumb = source ? image.thumb(source) : null;
      if (!source || !thumb) continue;
      candidates.push({ c, source, thumb: thumb.bytes });
    }
    if (candidates.length) offered.push({ slot, id: `s${offered.length + 1}`, candidates });
  }
  log('photos.searched', offered.length);
  if (offered.length === 0) return { photos: [] };

  // 2. One vision call per batch of slots: pick a candidate or none.
  const chosen: { o: Offered; pick: Offered['candidates'][number] }[] = [];
  let prompt: string | undefined;
  for (let i = 0; i < offered.length; i += L.SLOTS_PER_PICK_CALL) {
    throwIfAborted(signal);
    const batch = offered.slice(i, i + L.SLOTS_PER_PICK_CALL);
    const req: PhotoPickRequest = {
      signal,
      slots: batch.map((o) => ({
        id: o.id,
        purpose: o.slot.purpose,
        alt: o.slot.alt,
        sensitive: o.slot.sensitive,
        candidates: o.candidates.map((x, k) => ({
          label: `${o.id}-c${k + 1}`,
          title: x.c.title,
          license: licenseLabel(x.c),
        })),
      })),
      images: batch.flatMap((o) =>
        o.candidates.map((x, k) => ({
          mediaType: 'image/jpeg' as const,
          data: Buffer.from(x.thumb),
          label: `${o.id}-c${k + 1}`,
          sourceRef: 'stock-photo-candidates',
        })),
      ),
    };
    const r = await quiet(signal, () => deps.pick(req), null);
    if (!r) continue;
    prompt = r.prompt ?? prompt;
    for (const o of batch) {
      const p = r.picks.find((x) => x.slot === o.id);
      const pick = p && Number.isInteger(p.candidate) && p.candidate >= 1 ? o.candidates[p.candidate - 1] : undefined;
      if (pick) chosen.push({ o, pick });
    }
  }
  log('photos.picked', chosen.length);

  // 3. Download, downscale and credit the chosen photos within the document byte cap.
  const photos: StockPhotoInput[] = [];
  const used = new Set<string>();
  let total = 0;
  for (const { o, pick } of chosen) {
    throwIfAborted(signal);
    if (used.has(pick.c.id)) continue; // the same photo is never shown twice
    used.add(pick.c.id);
    const full = await quiet(signal, () => provider.download(pick.c, 'full', { signal }), null);
    const out = (full ? image.full(full) : null) ?? image.full(pick.source);
    if (!out || total + out.bytes.length > L.MAX_TOTAL_BYTES) continue;
    total += out.bytes.length;
    photos.push({
      slot: o.slot.key,
      mime: out.mime,
      bytes: out.bytes,
      width: out.width,
      height: out.height,
      alt: o.slot.alt || o.slot.purpose,
      caption: o.slot.caption,
      credit: photoCredit(pick.c),
    });
  }
  log('photos.embedded', photos.length);
  return { photos, ...(prompt ? { prompt } : {}) };
}
