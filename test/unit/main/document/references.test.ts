import { describe, expect, it } from 'vitest';
import { SKIPPED_REASON_FALLBACK, defaultReferenceFormatter } from '../../../../src/main/document';
import type { ResolvedSource, SkippedSource } from '../../../../src/main/sources';

function src(p: Partial<ResolvedSource> & Pick<ResolvedSource, 'resolverId' | 'location' | 'ref'>): ResolvedSource {
  return {
    id: 'src-00',
    inputId: 'in-1',
    lane: 'local',
    format: 'pdf',
    mediaType: 'application/pdf',
    payload: { kind: 'path', path: '/tmp/x' },
    sizeBytes: 2048,
    sha256: '0'.repeat(64),
    notes: [],
    ...p,
  };
}

const resolved: ResolvedSource[] = [
  src({
    resolverId: 'file',
    ref: 'deck.pptx',
    location: '/Users/a/private/deck.pptx',
    format: 'pptx',
    sizeBytes: 3 * 1024 * 1024,
  }),
  src({
    resolverId: 'url',
    lane: 'web',
    ref: 'https://example.com/a',
    location: 'https://example.com/a/b?x=1',
    format: 'html',
    title: 'A page',
  }),
  src({
    resolverId: 'url',
    lane: 'web',
    ref: 'https://example.com/c',
    location: 'https://example.com/c',
    format: 'html',
  }),
  src({
    resolverId: 'clipboard',
    ref: 'Pasted text: hello',
    location: 'clipboard',
    format: 'text',
    payload: { kind: 'text', text: 'one two  three\nfour' },
  }),
  src({ resolverId: 'clipboard', ref: 'Pasted image 14:02', location: 'clipboard', format: 'png' }),
  // organization-like sources: the public formatter must still never produce 'org'
  src({ resolverId: 'mcp', lane: 'mcp', ref: 'Design doc', location: 'https://docs.example.org/d/1', format: 'html' }),
  src({ resolverId: 'ticket', lane: 'mcp', ref: 'ABC-123', location: 'mcp://tickets/ABC-123', format: 'text' }),
];
const skipped: SkippedSource[] = [
  { ref: 'https://pricing.example.com/login', reason: 'Page required login.', code: 'login-required' },
  { ref: '/Users/a/secret/notes.docx', reason: '', code: 'read-error' },
  { ref: 'Pasted image 14:05', reason: 'Image too large.', code: 'image-too-large' },
];

describe('defaultReferenceFormatter (07 §10, HOOK-DOC-02)', () => {
  const out = defaultReferenceFormatter({ resolved, skipped });

  it('never yields kind org', () => {
    expect(out).toHaveLength(resolved.length + skipped.length);
    for (const e of out) {
      expect(e.kind).not.toBe('org');
      expect(e.orgKind).toBeUndefined();
    }
  });

  it('lists used in input order, then skipped', () => {
    expect(out.map((e) => e.status)).toEqual([...resolved.map(() => 'used'), ...skipped.map(() => 'skipped')]);
  });

  it('maps each public source kind', () => {
    expect(out[0]).toEqual({ status: 'used', kind: 'file', label: 'deck.pptx', detail: 'PowerPoint, 3.0 MB' });
    expect(out[1]).toMatchObject({ kind: 'url', label: 'A page', href: 'https://example.com/a/b?x=1' });
    expect(out[2]).toMatchObject({ kind: 'url', label: 'example.com/c' });
    expect(out[3]).toEqual({ status: 'used', kind: 'clipboard-text', label: 'Pasted text', detail: '4 words' });
    expect(out[4]).toMatchObject({ kind: 'clipboard-image', label: 'Pasted image' });
  });

  it('never shows a full path and links only http(s)', () => {
    for (const e of out) {
      expect(e.label).not.toMatch(/^\/|\\/);
      if (e.href !== undefined) expect(e.href).toMatch(/^https?:\/\//);
    }
    expect(out[8]).toMatchObject({
      status: 'skipped',
      kind: 'file',
      label: 'notes.docx',
      reason: SKIPPED_REASON_FALLBACK,
    });
  });

  it('carries skip reasons', () => {
    expect(out[7]).toMatchObject({ kind: 'url', label: 'pricing.example.com/login', reason: 'Page required login.' });
    expect(out[9]).toMatchObject({ kind: 'clipboard-image', reason: 'Image too large.' });
  });
});
