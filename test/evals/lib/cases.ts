/**
 * Eval case loading and selection (13 §9.2). Cases live in test/evals/cases/<id>.json.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR } from './judge';
import { FIXTURES_DIR } from './sources';
import { EvalCaseSchema, type EvalCase } from './types';

export function loadCases(dir = path.join(EVALS_DIR, 'cases')): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const c = EvalCaseSchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
      if (`${c.id}.json` !== f) throw new Error(`cases/${f} declares id ${c.id}`);
      return c;
    });
}

/** The ELI5_EVAL_CASES subset, in case-file order; an unknown id is refused before any spend. */
export function selectCases(all: readonly EvalCase[], ids?: readonly string[]): EvalCase[] {
  if (!ids || ids.length === 0) return [...all];
  const known = new Set(all.map((c) => c.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown eval case(s): ${unknown.join(', ')}`);
  return all.filter((c) => ids.includes(c.id));
}

/** Fixture manifest formats (13 §5.2) as PRD source types. */
const MANIFEST_TYPE: Record<string, string> = {
  pptx: 'pptx',
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
  'pdf-scanned': 'pdf-scanned',
  md: 'markdown',
  txt: 'text',
  image: 'image',
  html: 'url',
};

let manifest: Map<string, string> | undefined;
function manifestFormat(fixturePath: string): string | undefined {
  manifest ??= new Map(
    (
      JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as {
        fixtures: { path: string; format: string }[];
      }
    ).fixtures.map((f) => [f.path, f.format]),
  );
  return manifest.get(fixturePath);
}

/**
 * PRD source types a case exercises (PRD "Inputs and extraction"). Committed fixtures use the
 * manifest's `format` (a PDF with some image pages is still `pdf`); built specs use their builder
 * (`.pdf.json` draws image-only pages, so `pdf-scanned`); other eval files use their extension.
 */
export function sourceTypes(c: Pick<EvalCase, 'sources'>): string[] {
  const out = new Set<string>();
  for (const s of c.sources) {
    const bare = s.replace(/\.json$/, '');
    if (s.startsWith('sites/') || s.startsWith('evals/sites/')) out.add('url');
    else if (s.startsWith('sources/')) {
      const t = MANIFEST_TYPE[manifestFormat(s) ?? ''];
      if (t) out.add(t);
    } else if (/\.pptx$/.test(bare)) out.add('pptx');
    else if (/\.docx$/.test(bare)) out.add('docx');
    else if (/\.xlsx$/.test(bare)) out.add('xlsx');
    else if (/\.pdf$/.test(bare)) out.add(s.endsWith('.pdf.json') ? 'pdf-scanned' : 'pdf');
    else if (/\.(png|jpe?g)$/.test(bare)) out.add('image');
    else if (/\.md$/.test(bare)) out.add('markdown');
    else if (/\.(txt|csv)$/.test(bare)) out.add('text');
  }
  return [...out];
}
