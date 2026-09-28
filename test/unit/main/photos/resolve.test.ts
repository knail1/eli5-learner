import { describe, expect, it, vi } from 'vitest';
import type { DocumentDraftTab, DraftBlock } from '../../../../src/main/llm';
import {
  PHOTO_LIMITS,
  collectPhotoSlots,
  photoCredit,
  resolvePhotos,
  type PhotoImageOps,
  type PhotoPicker,
  type StockCandidate,
  type StockImageProvider,
} from '../../../../src/main/photos';

const photo = (query: string, over: Partial<Extract<DraftBlock, { type: 'photo' }>> = {}): DraftBlock => ({
  type: 'photo',
  query,
  purpose: `show ${query}`,
  alt: `A ${query}`,
  ...over,
});
const para = (md: string): DraftBlock => ({ type: 'paragraph', md });
const tab = (kind: 'indepth' | 'eli5', sections: DraftBlock[][]): DocumentDraftTab => ({
  kind,
  title: 't',
  sections: sections.map((blocks, i) => ({ heading: `S${i}`, blocks })),
});

describe('collectPhotoSlots (07 §7.4 limits)', () => {
  it('keys slots by tab, section and block, and sanitizes queries', () => {
    const eli5 = tab('eli5', [[para('Hello.'), photo('Courthouse exterior')]]);
    const slots = collectPhotoSlots({ indepth: tab('indepth', [[para('x')]]), eli5 });
    expect(slots).toEqual([
      {
        key: 'eli5:0:1',
        tab: 'eli5',
        sectionIndex: 0,
        blockIndex: 1,
        query: 'courthouse exterior',
        purpose: 'show Courthouse exterior',
        alt: 'A Courthouse exterior',
        caption: '',
        sensitive: false,
      },
    ]);
  });

  it('drops queries that name people from the drafts and applies the per-section, in-depth and document caps', () => {
    const indepth = tab('indepth', [
      [para('The case of Jane Roe went to court.'), photo('jane at courthouse'), photo('gavel')],
      [photo('filing cabinet')],
      [photo('office desk')],
    ]);
    const eli5 = tab(
      'eli5',
      Array.from({ length: 8 }, (_, i) => [photo(`library shelves ${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'][i]}`)]),
    );
    const slots = collectPhotoSlots({ indepth, eli5 });
    expect(slots.length).toBe(PHOTO_LIMITS.MAX_PER_DOCUMENT);
    expect(slots.every((s) => s.tab === 'eli5')).toBe(true);
    const fewer = collectPhotoSlots({ indepth, eli5: tab('eli5', [[photo('bridge'), photo('river')]]) });
    expect(fewer.map((s) => [s.key, s.query])).toEqual([
      ['eli5:0:0', 'bridge'],
      ['indepth:0:1', 'at courthouse'],
      ['indepth:1:0', 'filing cabinet'],
    ]);
  });

  it('returns nothing without photo blocks', () => {
    expect(collectPhotoSlots({ indepth: tab('indepth', [[para('x')]]), eli5: null })).toEqual([]);
  });
});

const cand = (q: string, n: number, over: Partial<StockCandidate> = {}): StockCandidate => ({
  id: `p:${q}:${n}`,
  title: `${q} ${n}`,
  creator: `creator ${n}`,
  license: 'by',
  licenseVersion: '2.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  landingUrl: `https://photos.example/${n}`,
  sourceName: 'Flickr',
  via: 'Openverse',
  thumbUrl: `https://img.example/${q}/${n}/t.jpg`,
  imageUrl: `https://img.example/${q}/${n}/f.jpg`,
  ...over,
});

function fakeProvider(o: { perQuery?: number; failThumb?: (c: StockCandidate) => boolean; failFull?: boolean } = {}) {
  const downloads: string[] = [];
  const provider: StockImageProvider = {
    id: 'fake',
    search: vi.fn(async (q: string) => Array.from({ length: o.perQuery ?? 6 }, (_, i) => cand(q, i + 1))),
    download: async (c, size) => {
      downloads.push(`${size}:${c.id}`);
      if (size === 'thumb' && o.failThumb?.(c)) return null;
      if (size === 'full' && o.failFull) return null;
      return new TextEncoder().encode(`${size}:${c.id}`);
    },
  };
  return { provider, downloads };
}

const ops: PhotoImageOps = {
  thumb: (b) => ({ mime: 'image/jpeg', bytes: b }),
  full: (b) => ({ mime: 'image/jpeg', bytes: new Uint8Array([...b, 0xff]), width: 1200, height: 800 }),
};

const slotsOf = (queries: string[]) =>
  collectPhotoSlots({
    indepth: tab('indepth', [[para('x')]]),
    eli5: tab(
      'eli5',
      queries.map((q) => [photo(q)]),
    ),
  });

describe('resolvePhotos', () => {
  const signal = new AbortController().signal;

  it('shows at most 4 labeled thumbnails per slot to one pick call and embeds the chosen photo with its credit', async () => {
    const { provider, downloads } = fakeProvider();
    const pick = vi.fn<PhotoPicker>(async (req) => {
      expect(req.slots.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(req.slots[0]?.candidates.map((c) => c.label)).toEqual(['s1-c1', 's1-c2', 's1-c3', 's1-c4']);
      expect(req.images.map((i) => i.label)).toEqual([
        's1-c1',
        's1-c2',
        's1-c3',
        's1-c4',
        's2-c1',
        's2-c2',
        's2-c3',
        's2-c4',
      ]);
      expect(req.images.every((i) => i.mediaType === 'image/jpeg')).toBe(true);
      return {
        picks: [
          { slot: 's1', candidate: 2 },
          { slot: 's2', candidate: 0 },
        ],
        prompt: 'photo-pick@1',
      };
    });
    const r = await resolvePhotos(slotsOf(['bridge', 'river']), { provider, image: ops, pick, signal });
    expect(pick).toHaveBeenCalledTimes(1);
    expect(downloads.filter((d) => d.startsWith('thumb:')).length).toBe(8);
    expect(downloads.filter((d) => d.startsWith('full:'))).toEqual(['full:p:bridge:2']);
    expect(r.prompt).toBe('photo-pick@1');
    expect(r.photos).toHaveLength(1);
    const [p] = r.photos;
    expect(p).toMatchObject({ slot: 'eli5:0:0', mime: 'image/jpeg', width: 1200, height: 800, alt: 'A bridge' });
    expect(p?.credit).toEqual(photoCredit(cand('bridge', 2)));
    expect(p?.credit).toMatchObject({ kind: 'stock-photo', title: 'bridge 2', license: 'by', sourceName: 'Flickr' });
  });

  it('never repeats a photo across slots', async () => {
    const provider: StockImageProvider = {
      id: 'same',
      search: async () => [cand('x', 1), cand('x', 2)],
      download: async (c, size) => new TextEncoder().encode(`${size}:${c.id}`),
    };
    const pick: PhotoPicker = async (req) => ({ picks: req.slots.map((s) => ({ slot: s.id, candidate: 1 })) });
    const r = await resolvePhotos(slotsOf(['bridge', 'river']), { provider, image: ops, pick, signal });
    expect(r.photos.map((p) => [p.slot, p.credit.title])).toEqual([['eli5:0:0', 'x 1']]);
  });

  it('skips candidates whose thumbnails fail and slots left without candidates', async () => {
    const { provider } = fakeProvider({ perQuery: 2, failThumb: (c) => c.id.startsWith('p:river') });
    const pick = vi.fn<PhotoPicker>(async (req) => {
      expect(req.slots.map((s) => s.id)).toEqual(['s1']);
      return { picks: [{ slot: 's1', candidate: 1 }] };
    });
    const r = await resolvePhotos(slotsOf(['bridge', 'river']), { provider, image: ops, pick, signal });
    expect(r.photos.map((p) => p.slot)).toEqual(['eli5:0:0']);
  });

  it('falls back to the thumbnail source when the full image cannot be downloaded', async () => {
    const { provider } = fakeProvider({ failFull: true });
    const pick: PhotoPicker = async () => ({ picks: [{ slot: 's1', candidate: 1 }] });
    const r = await resolvePhotos(slotsOf(['bridge']), { provider, image: ops, pick, signal });
    expect(new TextDecoder().decode(r.photos[0]?.bytes.slice(0, -1))).toBe('thumb:p:bridge:1');
  });

  it('ignores out-of-range picks and unknown slots', async () => {
    const { provider } = fakeProvider();
    const pick: PhotoPicker = async () => ({
      picks: [
        { slot: 's1', candidate: 9 },
        { slot: 's7', candidate: 1 },
      ],
    });
    expect((await resolvePhotos(slotsOf(['bridge']), { provider, image: ops, pick, signal })).photos).toEqual([]);
  });

  it('is quiet when search, the pick call or the image ops fail', async () => {
    const failing: StockImageProvider = {
      id: 'down',
      search: async () => {
        throw new Error('network');
      },
      download: async () => null,
    };
    const pick = vi.fn<PhotoPicker>(async () => ({ picks: [] }));
    expect((await resolvePhotos(slotsOf(['bridge']), { provider: failing, image: ops, pick, signal })).photos).toEqual(
      [],
    );
    expect(pick).not.toHaveBeenCalled();
    const { provider } = fakeProvider();
    const throwing: PhotoPicker = async () => {
      throw new Error('model down');
    };
    expect((await resolvePhotos(slotsOf(['bridge']), { provider, image: ops, pick: throwing, signal })).photos).toEqual(
      [],
    );
    const broken: PhotoImageOps = { thumb: () => null, full: () => null };
    expect((await resolvePhotos(slotsOf(['bridge']), { provider, image: broken, pick, signal })).photos).toEqual([]);
  });

  it('batches pick calls and caps the total embedded bytes', async () => {
    const { provider } = fakeProvider({ perQuery: 1 });
    const calls: number[] = [];
    const pick: PhotoPicker = async (req) => {
      calls.push(req.slots.length);
      return { picks: req.slots.map((s) => ({ slot: s.id, candidate: 1 })) };
    };
    const big: PhotoImageOps = {
      thumb: (b) => ({ mime: 'image/jpeg', bytes: b }),
      full: () => ({ mime: 'image/jpeg', bytes: new Uint8Array(400 * 1024), width: 1200, height: 800 }),
    };
    const r = await resolvePhotos(slotsOf(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map((q) => `bridge ${q}`)), {
      provider,
      image: big,
      pick,
      signal,
      limits: { SLOTS_PER_PICK_CALL: 4 },
    });
    expect(calls).toEqual([4, 2]);
    expect(r.photos.reduce((n, p) => n + p.bytes.length, 0)).toBeLessThanOrEqual(PHOTO_LIMITS.MAX_TOTAL_BYTES);
    expect(r.photos.length).toBeLessThan(6);
  });

  it('rethrows cancellation', async () => {
    const ctl = new AbortController();
    const { provider } = fakeProvider();
    const pick: PhotoPicker = async () => {
      ctl.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    await expect(
      resolvePhotos(slotsOf(['bridge']), { provider, image: ops, pick, signal: ctl.signal }),
    ).rejects.toThrow();
  });
});
