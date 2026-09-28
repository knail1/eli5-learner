import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import { Registry } from '../../../../src/main/editions/registry';
import { ApprovedLibraryStub, FallbackStockImages, isStockStub } from '../../../../src/main/photos';

describe('stock image registration (HOOK-DOC-03)', () => {
  const fresh = (): Registry => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublicCapabilities(reg);
    return reg;
  };

  it('the public build registers Openverse with a Wikimedia Commons fallback', () => {
    const reg = fresh();
    expect(reg.missingSlots()).toEqual([]);
    const p = reg.stockImages();
    expect(p).toBeInstanceOf(FallbackStockImages);
    expect(p.id).toBe('openverse+commons');
    expect(isStockStub(p)).toBe(false);
  });

  it('an overlay may replace it with an approved library (here: the documented stub)', () => {
    const reg = fresh();
    reg.registerStockImageProvider(new ApprovedLibraryStub());
    reg.freeze();
    expect(isStockStub(reg.stockImages())).toBe(true);
  });
});
