import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTRACT_LIMITS,
  ExtractError,
  applyCharCap,
  extractSource,
  type ExtractLimits,
  type Extractor,
  type ExtractResult,
} from '../../../../src/main/extract';
import { DEFAULT_RESOLVE_LIMITS } from '../../../../src/main/sources';
import { newContent } from '../../../../src/main/extract/text-util';
import { fixtureSource, testContext, textSource } from '../../../contracts/extractor.contract';

function fake(extract: Extractor['extract'], formats: Extractor['formats'] = ['text']): Extractor {
  return { id: 'fake', formats, canHandle: (s) => formats.includes(s.format), extract };
}
const ok =
  (text: string): Extractor['extract'] =>
  async (s) => ({
    ok: true,
    content: newContent(s, { blocks: [{ kind: 'paragraph', text }] }),
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('extractSource (04 §3)', () => {
  it('dispatches on the resolver format without re-sniffing', async () => {
    // A .txt file labelled markdown by 03 goes to the markdown extractor.
    const r = await extractSource(fixtureSource('sources/text/plain.txt', { format: 'markdown' }), testContext());
    expect(r.ok && r.content.format).toBe('markdown');
  });

  it('returns unsupported-type when no extractor matches', async () => {
    const ctx = testContext();
    const r = await extractSource(textSource('x', 'pptx', { location: '/a/b.pptm' }), ctx, [fake(ok('x'))]);
    expect(r).toEqual({
      ok: false,
      skipped: { ref: 'Pasted text', code: 'unsupported-type', reason: 'Unsupported file type (.pptm)' },
    });
    expect(ctx.logs).toContain('extract: no extractor for format');
  });

  it('applies the per-format input cap to UTF-8 size', async () => {
    const limits: ExtractLimits = {
      ...DEFAULT_EXTRACT_LIMITS,
      maxInputBytes: { ...DEFAULT_EXTRACT_LIMITS.maxInputBytes, text: 4 },
    };
    const r = await extractSource(textSource('héllo'), testContext({ limits }));
    expect(r).toMatchObject({
      ok: false,
      skipped: { code: 'too-large', reason: 'File too large (6 bytes; limit 4 bytes)' },
    });
  });

  it('keeps every cap at or below the resolver cap, with no settings namespace', () => {
    const caps = Object.values(DEFAULT_EXTRACT_LIMITS.maxInputBytes);
    for (const c of caps) expect(c).toBeLessThanOrEqual(DEFAULT_RESOLVE_LIMITS.maxFileBytes);
    expect(DEFAULT_EXTRACT_LIMITS.images.maxInputBytes).toBeLessThanOrEqual(DEFAULT_RESOLVE_LIMITS.maxImageBytes);
  });

  it('reads path payloads lazily, only inside the chosen extractor', async () => {
    const src = fixtureSource('sources/text/plain.txt', {
      format: 'pptx',
      payload: { kind: 'path', path: '/nonexistent/x.pptx' },
    });
    const r = await extractSource(src, testContext(), [fake(ok('fine'), ['pptx'])]);
    expect(r.ok).toBe(true);
  });

  it('maps ExtractError codes, parse failures and unknown errors', async () => {
    const thrower = (e: unknown): Extractor => fake(async () => Promise.reject(e));
    const src = textSource('x');
    expect(await extractSource(src, testContext(), [thrower(new ExtractError('zip-bomb'))])).toMatchObject({
      skipped: { code: 'zip-bomb' },
    });
    expect(await extractSource(src, testContext(), [thrower(new TypeError('boom'))])).toMatchObject({
      skipped: { code: 'internal-error', reason: 'Unexpected error while reading this file' },
    });
    expect(
      await extractSource(src, testContext(), [thrower(new RangeError('Array buffer allocation failed'))]),
    ).toMatchObject({
      skipped: { code: 'too-large' },
    });
  });

  it('turns a hung extractor into a timeout skip', async () => {
    vi.useFakeTimers();
    const hung = fake(() => new Promise<ExtractResult>(() => undefined));
    const p = extractSource(textSource('x'), testContext(), [hung]);
    await vi.advanceTimersByTimeAsync(10_000 + 300);
    expect(await p).toEqual({
      ok: false,
      skipped: { ref: 'Pasted text', code: 'timeout', reason: 'Took too long to read (over 10s)' },
    });
  });

  it('accepts partial output returned after the timeout signal', async () => {
    vi.useFakeTimers();
    const partial = fake(
      (s, ctx) =>
        new Promise<ExtractResult>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            const c = newContent(s, { blocks: [{ kind: 'paragraph', text: 'first page' }], truncated: true });
            c.warnings.push('Stopped after 1 of 3 pages (timeout)');
            resolve({ ok: true, content: c });
          });
        }),
    );
    const p = extractSource(textSource('x'), testContext(), [partial]);
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await p;
    expect(r.ok && r.content.truncated).toBe(true);
  });

  it('rejects invariant violations as internal errors', async () => {
    const bad = fake(async (s) => ({
      ok: true,
      content: newContent(s, {
        blocks: [
          { kind: 'image', imageId: 'nope', origin: 'embedded' },
          { kind: 'paragraph', text: 'x' },
        ],
      }),
    }));
    const ctx = testContext();
    expect(await extractSource(textSource('x'), ctx, [bad])).toMatchObject({ skipped: { code: 'internal-error' } });
    expect(ctx.logs.some((l) => l.includes('invariant'))).toBe(true);
    const nested = fake(async (s) => ({
      ok: true,
      content: newContent(s, {
        blocks: [
          {
            kind: 'page',
            number: 1,
            blocks: [{ kind: 'page', number: 2, blocks: [{ kind: 'paragraph', text: 'x' }] }],
          },
        ],
      }),
    }));
    expect(await extractSource(textSource('x'), testContext(), [nested])).toMatchObject({
      skipped: { code: 'internal-error' },
    });
    const control = fake(ok('bad\u0001text'));
    expect(await extractSource(textSource('x'), testContext(), [control])).toMatchObject({
      skipped: { code: 'internal-error' },
    });
  });

  it('returns empty when there is no text and no image', async () => {
    const r = await extractSource(textSource('x'), testContext(), [
      fake(async (s) => ({ ok: true, content: newContent(s) })),
    ]);
    expect(r).toEqual({
      ok: false,
      skipped: { ref: 'Pasted text', code: 'empty', reason: 'No readable content found' },
    });
  });

  it('fills stats and cuts text at maxCharsPerSource on a block boundary', async () => {
    const limits: ExtractLimits = { ...DEFAULT_EXTRACT_LIMITS, maxCharsPerSource: 12 };
    const r = await extractSource(textSource('first para\n\nsecond para\n\nthird'), testContext({ limits }));
    if (!r.ok) throw new Error(r.skipped.code);
    expect(r.content.blocks).toEqual([{ kind: 'paragraph', text: 'first para' }]);
    expect(r.content.truncated).toBe(true);
    expect(r.content.warnings).toContain('Text cut at 12 characters');
    expect(r.content.stats).toMatchObject({ chars: 10, approxTokens: 3 });
    expect(r.content.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('cuts inside slides and drops images the cut removes', () => {
    const c = newContent(
      { id: 's', ref: 'r', format: 'pptx' },
      {
        blocks: [
          {
            kind: 'slide',
            index: 1,
            blocks: [
              { kind: 'paragraph', text: 'aaaa' },
              { kind: 'image', imageId: 'i1', origin: 'embedded' },
            ],
          },
          {
            kind: 'slide',
            index: 2,
            blocks: [
              { kind: 'paragraph', text: 'bbbb' },
              { kind: 'image', imageId: 'i2', origin: 'embedded' },
            ],
          },
        ],
        images: ['i1', 'i2'].map((id) => ({
          id,
          mediaType: 'image/png' as const,
          data: new Uint8Array(1),
          width: 1,
          height: 1,
          byteLength: 1,
          origin: 'embedded' as const,
        })),
      },
    );
    c.stats.imagesKept = 2;
    applyCharCap(c, 6);
    expect(c.blocks).toHaveLength(2);
    expect(c.images.map((i) => i.id)).toEqual(['i1']);
    expect(c.stats).toMatchObject({ imagesKept: 1, imagesDropped: 1 });
    const big = newContent(
      { id: 's', ref: 'r', format: 'text' },
      { blocks: [{ kind: 'paragraph', text: 'x'.repeat(50) }] },
    );
    applyCharCap(big, 10);
    expect(big.blocks).toEqual([{ kind: 'paragraph', text: 'x'.repeat(10) }]);
  });

  it('never throws out of extractSource', async () => {
    const r = await extractSource(fixtureSource('sources/text/plain.txt', { format: 'docx' }), testContext());
    expect(r).toMatchObject({ ok: false, skipped: { code: 'corrupt' } });
  });
});
