/**
 * The document CSP (07 §6.2, §6.3): pinned byte for byte. A document without animations carries
 * exactly the policy older documents have; one with animations adds only its frames' script hashes
 * (an about:srcdoc frame inherits this policy), and frame-src stays 'none'.
 */
import { describe, expect, it } from 'vitest';
import { documentCsp, renderDocument, scriptHash } from '../../../../src/main/document';
import { animationScriptHashes } from '../../../../src/main/document/animation';
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

  it('a document with an animation differs only by the frame hashes after the runtime hash', () => {
    const show = fixtureDocument('showcase');
    const full = fixtureDocument('full');
    const a = renderDocument(show.model, show.assets, { runtime: STUB_RUNTIME, theme: show.theme });
    const b = renderDocument(full.model, full.assets, { runtime: STUB_RUNTIME, theme: full.theme });
    expect(a).toContain('<figure class="animation"');
    const frames = animationScriptHashes(
      show.model.tabs.flatMap((t) =>
        t.sections.flatMap((s) => s.blocks.flatMap((x) => (x.type === 'animation' ? [x] : []))),
      ),
    );
    expect(frames).toHaveLength(2);
    expect(cspOf(b)).toBe(documentCsp(STUB_RUNTIME.js));
    expect(cspOf(a)).toBe(documentCsp(STUB_RUNTIME.js, frames));
    expect(cspOf(a).replace(` ${frames.join(' ')}`, '')).toBe(cspOf(b));
  });
});
