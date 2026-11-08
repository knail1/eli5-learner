/**
 * The document CSP is unchanged by explorables (07 §6.2, §6.3; design §3.1): no new hash, no new
 * directive, no frame source. The policy text is pinned byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { documentCsp, renderDocument, scriptHash } from '../../../../src/main/document';
import { fixtureDocument } from '../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';

const cspOf = (html: string): string =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1]?.replace(/&#39;|&apos;/g, "'") ?? '';

describe('document CSP (07 §6.2)', () => {
  it('is byte-identical to the pinned policy', () => {
    expect(documentCsp(STUB_RUNTIME.js)).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
        `script-src ${scriptHash(STUB_RUNTIME.js)}; connect-src 'none'; media-src 'none'; object-src 'none'; ` +
        "frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it('a document with explorables carries the same policy as one without', () => {
    const show = fixtureDocument('showcase');
    const full = fixtureDocument('full');
    const a = renderDocument(show.model, show.assets, { runtime: STUB_RUNTIME, theme: show.theme });
    const b = renderDocument(full.model, full.assets, { runtime: STUB_RUNTIME, theme: full.theme });
    expect(a).toContain('<figure class="explorable"');
    expect(cspOf(a)).not.toBe('');
    expect(cspOf(a)).toBe(cspOf(b));
    expect(cspOf(a)).toBe(documentCsp(STUB_RUNTIME.js));
  });
});
