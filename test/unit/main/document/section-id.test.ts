import { describe, expect, it } from 'vitest';
import {
  IdExhaustedError,
  MAX_ID_DRAWS,
  SECTION_ID_RE,
  cryptoIdSource,
  isSectionEli5TabKey,
  isSectionId,
  isTabKey,
  mintSectionEli5TabKey,
  mintSectionId,
  tabKeyOfSectionId,
  type IdSource,
} from '../../../../src/main/document';
import type { SectionId } from '../../../../src/main/document';

/** Reproducible hex stream (13 §2 SeededIdSource): mulberry32 over a seed. */
function seededIdSource(seed: number): IdSource & { calls: number } {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const src = {
    calls: 0,
    hex(chars: number): string {
      src.calls++;
      let out = '';
      while (out.length < chars) out += Math.floor(next() * 16).toString(16);
      return out;
    },
  };
  return src;
}

/** Replays a fixed list of hex strings. */
function scripted(values: string[]): IdSource {
  let i = 0;
  return { hex: () => values[i++ % values.length] ?? '' };
}

describe('SECTION_ID_RE / isSectionId (07 §3, §4.2)', () => {
  it.each(['sec-indepth-3f9a1c2e', 'sec-eli5-00000000', 'sec-sx4e1a07-0b77d912'])('accepts %s', (id) => {
    expect(isSectionId(id)).toBe(true);
  });
  it.each([
    'sec-indepth-3F9A1C2E', // uppercase hex
    'sec-indepth-3f9a1c2', // 7 hex
    'sec-indepth-3f9a1c2e0', // 9 hex
    'sec-1abc-3f9a1c2e', // tab key starts with digit
    'sec-a-3f9a1c2e', // tab key too short
    'sec-abcdefghijklmnopq-3f9a1c2e', // tab key 17 chars
    'indepth-3f9a1c2e',
    ' sec-indepth-3f9a1c2e',
    '',
  ])('rejects %j', (id) => {
    expect(isSectionId(id)).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isSectionId(42)).toBe(false);
    expect(isSectionId(undefined)).toBe(false);
  });
});

describe('tab keys (07 §4.1)', () => {
  it('accepts indepth, eli5 and sx + 6 hex', () => {
    for (const k of ['indepth', 'eli5', 'sx4e1a07']) expect(isTabKey(k)).toBe(true);
    expect(isSectionEli5TabKey('sx4e1a07')).toBe(true);
    expect(isSectionEli5TabKey('eli5')).toBe(false);
  });
  it('rejects anything else', () => {
    for (const k of ['sx4E1A07', 'sx4e1a0', 'sx4e1a07a', 'In depth', 'eli', 'indepth2', '']) {
      expect(isTabKey(k)).toBe(false);
    }
  });
  it('mints sx + 6 hex and retries on collision', () => {
    const key = mintSectionEli5TabKey(scripted(['aaaaaa', 'bbbbbb']), new Set(['sxaaaaaa']));
    expect(key).toBe('sxbbbbbb');
    expect(isSectionEli5TabKey(key)).toBe(true);
  });
});

describe('mintSectionId (07 §4.2)', () => {
  it('formats sec-<tabKey>-<8 hex> and matches SECTION_ID_RE', () => {
    const src = seededIdSource(1);
    for (const tab of ['indepth', 'eli5', 'sx4e1a07']) {
      const id = mintSectionId(tab, src, new Set());
      expect(id).toMatch(SECTION_ID_RE);
      expect(id.startsWith(`sec-${tab}-`)).toBe(true);
      expect(tabKeyOfSectionId(id)).toBe(tab);
    }
  });

  it('is reproducible for a seed', () => {
    const a = [1, 2, 3].map(() => mintSectionId('indepth', seededIdSource(7), new Set()));
    const b = mintSectionId('indepth', seededIdSource(7), new Set());
    expect(new Set(a).size).toBe(1);
    expect(a[0]).toBe(b);
  });

  it('never reuses an id when callers track taken (all tabs + retired)', () => {
    const src = seededIdSource(42);
    const taken = new Set<string>(['sec-indepth-deadbeef']); // retired id (4.3)
    for (let i = 0; i < 2000; i++) {
      const tab = i % 3 === 0 ? 'indepth' : i % 3 === 1 ? 'eli5' : 'sx4e1a07';
      const id = mintSectionId(tab, src, taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(taken.size).toBe(2001);
  });

  it('redraws on collision', () => {
    const src = scripted(['11111111', '11111111', '22222222']);
    const id = mintSectionId('indepth', src, new Set(['sec-indepth-11111111']));
    expect(id).toBe('sec-indepth-22222222');
  });

  it(`throws IdExhaustedError after ${MAX_ID_DRAWS} colliding draws`, () => {
    const src = { calls: 0, hex: () => (src.calls++, '11111111') };
    expect(() => mintSectionId('eli5', src, new Set(['sec-eli5-11111111']))).toThrow(IdExhaustedError);
    expect(src.calls).toBe(MAX_ID_DRAWS);
  });

  it('rejects an invalid tab key', () => {
    expect(() => mintSectionId('Bad Key', seededIdSource(1), new Set())).toThrow(/tab key/);
    expect(() => mintSectionId('sx12', seededIdSource(1), new Set())).toThrow(/tab key/);
  });

  it('rejects malformed IdSource output', () => {
    expect(() => mintSectionId('indepth', scripted(['ABCDEF12']), new Set())).toThrow(/hex/);
    expect(() => mintSectionId('indepth', scripted(['abc']), new Set())).toThrow(/hex/);
  });

  it('cryptoIdSource yields lowercase hex of the requested length', () => {
    for (const n of [6, 8]) expect(cryptoIdSource.hex(n)).toMatch(new RegExp(`^[0-9a-f]{${n}}$`));
    const id: SectionId = mintSectionId('indepth', cryptoIdSource, new Set());
    expect(isSectionId(id)).toBe(true);
  });
});
