import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGates } from './lib/gates';
import { glossaryNotes, sectionText, tabText } from './lib/text';
import type { EvalCase } from './lib/types';

const FULL = readFileSync(path.resolve(import.meta.dirname, '../fixtures/documents/build/full.html'), 'utf8');
const WITH_TAB = readFileSync(path.resolve(import.meta.dirname, '../fixtures/documents/build/with-tab.html'), 'utf8');

const kase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: 'gate-case',
  sources: ['sources/text/notes.md'],
  glossary: true,
  domain: 'marketing',
  mustCover: ['x'],
  jargon: ['ROAS', 'attribution window'],
  ...over,
});

describe('visible tab text (13 §9.3 step 3)', () => {
  it('keeps headings, prose, glossary notes, figure captions and chart data; drops scripts and SVG ticks', () => {
    const t = tabText(FULL, 'indepth');
    expect(t).toContain('Why ad spend is judged by ROAS');
    expect(t).toContain('[Glossary] ROAS · return on ad spend: Revenue earned for each dollar spent on ads.');
    expect(t).toContain('[Chart] Paid search returns the most per dollar');
    expect(t).toContain('Paid search | 4.2'); // chart data table kept as text
    expect(t).not.toContain('Money in, money out'); // the ELI5 tab
    expect(t).not.toMatch(/function|\{"/); // no runtime script or model JSON
    expect(t).not.toMatch(/<(section|svg|p|div|details)\b/i); // markup stripped (escaped text stays text)
    expect(t).toContain('[Diagram] An order box with an arrow to a ship box');
    expect(t).toContain('Skipped'); // references, including skipped sources (D7)
    expect(tabText(FULL, 'eli5')).toContain('Money in, money out');
    expect(tabText(FULL, 'eli5')).not.toContain('[Glossary]');
    expect(() => tabText(FULL, 'nope')).toThrow(/nope/);
  });

  it('reads one section by id', () => {
    const id = /<section id="(sec-indepth-[0-9a-f]{8})"/.exec(FULL)?.[1] ?? '';
    const s = sectionText(FULL, id);
    expect(s.length).toBeGreaterThan(20);
    expect(tabText(FULL, 'indepth')).toContain(s.split('\n')[0] ?? '-');
  });

  it('lists glossary notes inside the In depth panel', () => {
    expect(glossaryNotes(FULL).map((n) => n.term)).toEqual(['ROAS', 'conversion', 'Attribution window']);
  });
});

describe('deterministic gates (13 §9.3 step 2)', () => {
  it('pass a valid document with both tabs, a glossary and every jargon term defined', () => {
    expect(runGates(FULL, kase())).toEqual({ ok: true, failures: [] });
    expect(runGates(WITH_TAB, kase({ jargon: ['roas'] })).ok).toBe(true);
  });

  it('fail when a jargon term has no glossary callout', () => {
    const r = runGates(FULL, kase({ jargon: ['ROAS', 'EBITDA'] }));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([{ gate: 'jargon', detail: 'EBITDA' }]);
  });

  it('fail when the glossary is present but the case turned it off (and skip the jargon check)', () => {
    const r = runGates(FULL, kase({ glossary: false, jargon: ['EBITDA'] }));
    expect(r.failures.map((f) => f.gate)).toEqual(['glossary']);
  });

  it('fail on a document that does not validate or lacks a required tab', () => {
    const broken = FULL.replace('</head>', '<script src="https://cdn.example.com/x.js"></script></head>');
    expect(runGates(broken, kase()).failures.map((f) => f.gate)).toContain('validity');
    const noEli5 = FULL.replace(/data-tab-key="eli5"/g, 'data-tab-key="other"');
    expect(runGates(noEli5, kase()).failures.map((f) => f.gate)).toContain('tabs');
  });
});
