import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FRAGMENT_IDS, PromptCatalogue } from '../../../../src/main/llm/prompts';
import { PROMPT_IDS } from '../../../../src/main/llm/types';
import { PROMPTS_ROOT, REPO } from './helpers';

/**
 * "No prompt prose in TypeScript" (D27, 02 §9): prompt text lives in config/prompts only. Three
 * guards: the constants that used to hold prose are gone, every prompt and fragment id resolves
 * from files, and a narrow heuristic flags long instruction-like string literals in the modules that
 * build requests. Reviewed exceptions go in config/prompt-prose-allow (path and a substring).
 */

const SCANNED = ['src/main/llm', 'src/main/pipeline', 'src/main/document/interactive'];
const REMOVED_SYMBOLS = [
  'PHOTO_INSTRUCTIONS',
  'PHOTO_QUERY_RULES',
  'FALLBACK_SKILL_TEXT',
  'repairPrompt',
  'promptedJsonContract',
  'CONTENT_MODE',
];
const MIN_CHARS = 60;
const CUES = ['You ', 'Return ', 'Produce ', 'Do not ', 'Never '];
const ALLOW_FILE = path.join(REPO, 'config', 'prompt-prose-allow');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

const files = SCANNED.flatMap((d) => tsFiles(path.join(REPO, d)));

/** The literal text of a string expression: literals, templates (holes dropped) and `+` chains. */
function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => s.literal.text).join(' ');
  if (ts.isParenthesizedExpression(n)) return literalText(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = literalText(n.left);
    const r = literalText(n.right);
    if (l !== null || r !== null) return (l ?? ' ') + (r ?? ' ');
  }
  return null;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Long instruction-like string literals (outermost expression only, so a `+` chain counts once). */
function proseHits(file: string, src: string): Hit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const visit = (n: ts.Node): void => {
    const text = literalText(n);
    if (text !== null) {
      if (text.length > MIN_CHARS && CUES.some((c) => text.includes(c))) {
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text });
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function allowList(): { file: string; needle: string }[] {
  return fs
    .readFileSync(ALLOW_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf(' ');
      return { file: l.slice(0, i), needle: l.slice(i + 1).trim() };
    });
}

describe('no prompt prose in TypeScript (D27)', () => {
  it('the constants that held prompt prose no longer exist', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const sym of REMOVED_SYMBOLS) {
        expect(new RegExp(`\\b${sym}\\b`).test(src), `${path.relative(REPO, f)}: ${sym}`).toBe(false);
      }
    }
  });

  it('every PROMPT_ID and FRAGMENT_ID resolves from a file under config/prompts/default', () => {
    for (const id of PROMPT_IDS) expect(fs.existsSync(path.join(PROMPTS_ROOT, 'default', `${id}.md`)), id).toBe(true);
    for (const id of FRAGMENT_IDS)
      expect(fs.existsSync(path.join(PROMPTS_ROOT, 'default', 'fragments', `${id}.md`)), id).toBe(true);
    expect(() => PromptCatalogue.load({ root: PROMPTS_ROOT })).not.toThrow();
  });

  it('no long instruction-like string literal outside the allow list', () => {
    const allow = allowList();
    const hits = files
      .flatMap((f) => proseHits(path.relative(REPO, f), fs.readFileSync(f, 'utf8')))
      .filter((h) => !allow.some((a) => a.file === h.file && h.text.includes(a.needle)));
    expect(hits.map((h) => `${h.file}:${h.line}: ${h.text.slice(0, 80)}`)).toEqual([]);
  });

  it('the heuristic catches prose, including concatenated and template literals', () => {
    const src = [
      "const a = 'You write the In depth view of an explainer for a technical leader new to it.';",
      "const b = 'Return one JSON object ' + 'that matches the provided schema and nothing else at all.';",
      'const c = `Produce at most ${n} sections, prioritize the most important material please.`;',
      "const d = 'short label';",
    ].join('\n');
    expect(proseHits('x.ts', src).map((h) => h.line)).toEqual([1, 2, 3]);
  });
});
