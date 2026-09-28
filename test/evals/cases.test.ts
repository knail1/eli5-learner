import { describe, expect, it } from 'vitest';
import { loadCases, selectCases, sourceTypes } from './lib/cases';
import { classifySource, sourceExists } from './lib/sources';

const cases = loadCases();

describe('eval set (13 §9.2)', () => {
  it('has 12 to 20 valid cases whose ids match their file names', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.length).toBeLessThanOrEqual(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('references only committed synthetic sources', () => {
    for (const c of cases) for (const s of c.sources) expect(sourceExists(s), `${c.id}: ${s}`).toBe(true);
  });

  it('covers every PRD source type', () => {
    const types = new Set(cases.flatMap(sourceTypes));
    for (const t of ['pptx', 'docx', 'pdf', 'pdf-scanned', 'markdown', 'text', 'image', 'xlsx', 'url']) {
      expect(types, t).toContain(t);
    }
  });

  it('classifies fixture files by the fixture manifest format, not by file name', () => {
    expect(sourceTypes({ sources: ['sources/pdf/mixed.pdf'] })).toEqual(['pdf']); // text pages + one image page
    expect(sourceTypes({ sources: ['sources/pdf/scanned-3p.pdf'] })).toEqual(['pdf-scanned']);
    expect(sourceTypes({ sources: ['evals/finance/x.pdf.json'] })).toEqual(['pdf-scanned']); // built image-only
    expect(sourceTypes({ sources: ['sources/text/notes.md', 'sources/text/plain.txt'] })).toEqual(['markdown', 'text']);
  });

  it('source-type tags in `covers` match what the sources really are', () => {
    const PRD = ['pptx', 'docx', 'pdf', 'pdf-scanned', 'markdown', 'text', 'image', 'xlsx', 'url'];
    for (const c of cases) {
      const tags = (c.covers ?? []).filter((t) => PRD.includes(t));
      expect(sourceTypes(c), c.id).toEqual(expect.arrayContaining(tags));
    }
  });

  it('has at least 3 cases per PRD domain, 2 multi-source cases, a skipped source and an images-only case', () => {
    for (const d of ['security', 'finance', 'marketing', 'data']) {
      expect(cases.filter((c) => c.domain === d).length, d).toBeGreaterThanOrEqual(3);
    }
    expect(cases.filter((c) => c.sources.length > 1).length).toBeGreaterThanOrEqual(2);
    // The login-wall fixture site is skipped by the fetcher (05) and must be listed in references.
    expect(cases.some((c) => c.sources.includes('sites/login-wall/'))).toBe(true);
    expect(cases.some((c) => c.sources.every((s) => sourceTypes({ ...c, sources: [s] }).includes('image')))).toBe(true);
  });

  it('every case has must-cover facts and jargon (ELI5 E1 uses it even with the glossary off)', () => {
    for (const c of cases) {
      expect(c.mustCover.length, c.id).toBeGreaterThanOrEqual(3);
      expect(c.jargon.length, c.id).toBeGreaterThan(0);
    }
  });

  it('exercises every section action at least once', () => {
    const actions = new Set(cases.flatMap((c) => (c.sectionActions ?? []).map((a) => a.action)));
    expect([...actions].sort()).toEqual(['analogy', 'deeper', 'expand', 'reexplain', 'section-eli5']);
  });
});

describe('selectCases (ELI5_EVAL_CASES)', () => {
  it('keeps case order, returns everything without a filter and refuses unknown ids', () => {
    expect(selectCases(cases)).toHaveLength(cases.length);
    const two = [cases[3]?.id ?? '', cases[0]?.id ?? ''];
    expect(selectCases(cases, two).map((c) => c.id)).toEqual([cases[0]?.id, cases[3]?.id]);
    expect(() => selectCases(cases, ['no-such-case'])).toThrow(/no-such-case/);
  });
});

describe('source references', () => {
  it('classifies fixture files, fixture sites, eval sites, built specs and eval files', () => {
    expect(classifySource('sources/pptx/quarterly-review.pptx').kind).toBe('fixture-file');
    expect(classifySource('sites/login-wall/')).toMatchObject({ kind: 'fixture-site', name: '/login-wall/' });
    expect(classifySource('evals/sites/vuln-advisory.html')).toMatchObject({
      kind: 'eval-site',
      name: '/evals/vuln-advisory/',
    });
    expect(classifySource('evals/data/x.docx.json')).toMatchObject({ kind: 'eval-built', name: 'x.docx' });
    expect(classifySource('evals/finance/scan.pdf.json')).toMatchObject({ kind: 'eval-built', name: 'scan.pdf' });
    expect(classifySource('evals/data/a.md').kind).toBe('eval-file');
    expect(() => classifySource('/etc/passwd')).toThrow();
  });
});
