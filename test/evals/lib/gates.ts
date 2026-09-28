/**
 * Deterministic gates run before the judge (13 §9.3 step 2): validateDocument passes, the required
 * tabs are present, the glossary is present iff enabled, and each jargon term has a glossary callout
 * in the In depth tab when the glossary is on. Any failure scores the case 0 without a judge call.
 */
import type { DocumentMeta } from '../../../src/main/library';
import { validateDocument } from '../../helpers/doc-validity';
import { glossaryNotes, tabKeys } from './text';
import type { EvalCase, GateResult } from './types';

const REQUIRED_TABS = ['indepth', 'eli5'];

/** Case-insensitive, whitespace-normalized; a trailing plural "s" on either side still matches. */
function mentions(haystack: string, term: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const h = norm(haystack);
  const t = norm(term);
  return h.includes(t) || (t.endsWith('s') && h.includes(t.slice(0, -1)));
}

export function runGates(html: string, c: Pick<EvalCase, 'glossary' | 'jargon'>, meta?: DocumentMeta): GateResult {
  const failures: GateResult['failures'] = [];
  const v = validateDocument(html, meta);
  if (!v.ok) {
    for (const rule of [...new Set(v.errors.map((e) => e.rule))]) failures.push({ gate: 'validity', detail: rule });
  }
  let keys: string[] = [];
  try {
    keys = tabKeys(html);
  } catch {
    keys = [];
  }
  for (const t of REQUIRED_TABS) if (!keys.includes(t)) failures.push({ gate: 'tabs', detail: `missing ${t}` });
  const notes = glossaryNotes(html);
  if (c.glossary && notes.length === 0) failures.push({ gate: 'glossary', detail: 'enabled but absent' });
  if (!c.glossary && notes.length > 0) failures.push({ gate: 'glossary', detail: 'disabled but present' });
  if (c.glossary) {
    for (const term of c.jargon) {
      // The term's own callout: its term or summary line, never another term's explanation.
      if (!notes.some((n) => mentions(n.term, term) || mentions(n.summary, term))) {
        failures.push({ gate: 'jargon', detail: term });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
