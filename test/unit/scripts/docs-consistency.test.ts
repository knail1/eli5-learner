import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The user-facing docs (README, PRD, CLAUDE.md) and the prompt catalogue README describe what the
// app ships (S7 docs sweep): three tabs, prompt sets in config/prompts, AI-written sandboxed
// animations with no fixed kinds, and rebuild as a new version.

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
const PRD = 'spec/ELI5 Learner Product Requirements Document.md';

/** Every Markdown file under `dir` (relative to the repo root), recursively. */
function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...markdownUnder(rel));
    else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

describe('README.md', () => {
  const readme = read('README.md');

  it('describes the three views, including ASD-STE100', () => {
    expect(readme).toMatch(/three views/);
    expect(readme).toMatch(/\*\*ASD-STE100\.\*\*/);
    expect(readme).toMatch(/\*\*ASD-STE100 tab\.\*\*/);
  });

  it('describes AI-designed animations in a sandbox, with no canned kinds', () => {
    expect(readme).toMatch(/\*\*AI-designed animations, in a sandbox\.\*\*/);
    expect(readme).toMatch(/no canned animations/i);
    expect(readme).toMatch(/content security policy/);
  });

  it('does not promise the animation poster in the Markdown export, which carries only its text (audit round 4)', () => {
    // 10 §5.2: the export writes the title, alt text and caption, never the code or the poster SVG.
    expect(readme).not.toMatch(/in print and in the Markdown export/);
    expect(readme).toMatch(/Markdown export carries its description and caption/);
  });

  it('describes the WSJ Five-Box feature and the picture-first ELI5 with its critique', () => {
    expect(readme).toMatch(/Five-Box/);
    expect(readme).toMatch(/Dona M\. Wong/);
    expect(readme).toMatch(/\*\*Picture-first ELI5, checked once\.\*\*/);
  });

  it('explains prompt sets in config/prompts and how to try one', () => {
    expect(readme).toMatch(/^### Prompt sets$/m);
    expect(readme).toContain('config/prompts/');
    expect(readme).toContain('ELI5_PROMPT_SET=<my-set> npm run dev');
    expect(readme).toMatch(/"promptSet"/);
    expect(readme).toContain('wsj-v1');
  });

  it('has a status banner that goes past M0 to M4', () => {
    const banner = /^> \*\*Status:\*\*.*$/m.exec(readme)?.[0] ?? '';
    expect(banner).toMatch(/M5/);
    expect(banner).toMatch(/ASD-STE100/);
    expect(banner).toMatch(/config\/prompts/);
  });

  it('says an installed app needs a rebuild and a relaunch to use a new prompt set', () => {
    expect(readme).toMatch(/ignored by an\s+installed app/);
    expect(readme).toMatch(/then relaunch/);
    expect(readme).toMatch(/`settings\.reset`/);
  });

  it('mentions rebuild as a new version and links the real-run driver', () => {
    expect(readme).toMatch(/Rebuilt with new prompts/);
    expect(readme).toContain('scripts/real-run/README.md');
  });
});

describe('PRD', () => {
  const prd = read(PRD);

  it('has the ASD-STE100 tab, its hint and the tab order', () => {
    expect(prd).toMatch(/three views/);
    expect(prd).toMatch(/^\| ASD-STE100 \(optional\) \|/m);
    expect(prd).toMatch(/^\*\*ASD-STE100 tab\*\*$/m);
    expect(prd).toMatch(/In depth, ELI5, ASD-STE100 \(when present\)/);
  });

  it('has the Five-Box structure, the Wong chart rules, picture-first ELI5 and the critique pass', () => {
    expect(prd).toMatch(/Five-Box/);
    expect(prd).toMatch(/Dona M\. Wong/);
    expect(prd).toMatch(/^\*\*ELI5 tab: picture first, then one critique pass\*\*$/m);
  });

  it('has AI-designed sandboxed animations with no fixed kinds', () => {
    expect(prd).toMatch(/^\*\*Animations \(AI-designed, sandboxed\)\*\*$/m);
    expect(prd).toMatch(/no fixed animation kinds/);
  });

  it('notes rebuilds in versions and the power-user prompt set', () => {
    expect(prd).toMatch(/Rebuilt with new prompts/);
    expect(prd).toMatch(/`llm\.promptSet`/);
    expect(prd).toMatch(/HOOK-LLM-02/);
  });
});

/** The numeric value of `export const NAME = <n>;` in a source file (read as text, not imported). */
function constIn(rel: string, name: string): number {
  const m = new RegExp(`export const ${name} = (\\d+);`).exec(read(rel));
  expect(m, `${name} in ${rel}`).not.toBeNull();
  return Number(m?.[1]);
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

describe('numbers in the docs match the code', () => {
  const prd = read(PRD);

  it('states the animation caps from src/main/document/animation', () => {
    const file = 'src/main/document/animation/index.ts';
    const section = WORDS[constIn(file, 'MAX_ANIMATIONS_PER_SECTION')];
    const tab = WORDS[constIn(file, 'MAX_ANIMATIONS_PER_TAB')];
    const doc = WORDS[constIn(file, 'MAX_ANIMATIONS_PER_DOC')];
    expect(prd).toContain(`At most ${section} animation per section, ${tab} per tab and ${doc} per document.`);
    // The ASD-STE100 copies of the In depth animations are outside the document cap (build.ts).
    expect(prd).toMatch(/not counted against the four-per-document cap/);
  });

  it('states the ASD-STE100 sentence limits from the STE lint', () => {
    const file = 'src/main/llm/lint/ste-lint.ts';
    const procedural = constIn(file, 'STE_PROCEDURAL_MAX_WORDS');
    const descriptive = constIn(file, 'STE_DESCRIPTIVE_MAX_WORDS');
    expect(prd).toContain(`instructions at most ${procedural} words, descriptions at most ${descriptive}`);
  });

  it('uses the rebuild label the Versions panel shows', () => {
    const m = /export const REBUILT_VERB = '([^']+)';/.exec(read('src/renderer/src/viewer/version-tree-layout.ts'));
    expect(m).not.toBeNull();
    const verb = m?.[1] ?? '';
    expect(prd).toContain(`"${verb}"`);
    expect(read('README.md')).toContain(`("${verb}")`);
  });

  it('states every rule of the ELI5 critique gate', () => {
    expect(prd).toMatch(/within one, and at least three/);
    expect(prd).toMatch(/keeps every figure, photo and animation of the draft/);
  });
});

/** A numeric `export const NAME = <expr>;` that may use `_` separators and `a * b` products. */
function numericConstIn(rel: string, name: string): number {
  const m = new RegExp(`export const ${name} = ([0-9_ *]+);`).exec(read(rel));
  expect(m, `${name} in ${rel}`).not.toBeNull();
  return (m?.[1] ?? '')
    .split('*')
    .map((part) => Number(part.trim().replace(/_/g, '')))
    .reduce((a, b) => a * b, 1);
}

describe('Quick Ask, Ask deep, Ask deeper and retained source text in the docs', () => {
  const readme = read('README.md');
  const prd = read(PRD);
  const s08 = read('spec/tech/08-interactive-reading.md');
  const s09 = read('spec/tech/09-library-storage.md');

  it('describes the three Ask buttons and the private source copy in the README', () => {
    expect(readme).toMatch(/three Ask buttons/);
    expect(readme).toMatch(/\*\*Ask deep\*\*/);
    expect(readme).toMatch(/\*\*Ask deeper\*\*/);
    expect(readme).not.toMatch(/Deep ask/);
    expect(readme).toMatch(/private copy of the text extracted/);
    expect(readme).toMatch(/never published or synced/);
    expect(readme).toMatch(/over their tabs only/);
  });

  it('describes Ask, Ask deep, Ask deeper and hidden source retention in the PRD', () => {
    expect(prd).toMatch(/\*\*Ask \(quick\):\*\*/);
    expect(prd).toMatch(/\*\*Ask deep:\*\*/);
    expect(prd).toMatch(/\*\*Ask deeper:\*\*/);
    expect(prd).not.toMatch(/Deep ask/);
    expect(prd).toMatch(/\.sources\//);
    expect(prd).toMatch(/hidden, private copy of the text extracted/);
  });

  it('names the Quick Ask, Ask deep and Ask deeper sections in 08 and the sidecar section in 09', () => {
    expect(s08).toMatch(/^### 6\.8 Quick Ask/m);
    expect(s08).toMatch(/^### 6\.9 Ask deep/m);
    expect(s08).toMatch(/^### 6\.10 Ask deeper/m);
    expect(s09).toMatch(/^### 4\.4 Retained source text/m);
  });

  it('states the Deep Ask input cap from src/main/llm/deep-ask.ts', () => {
    const cap = numericConstIn('src/main/llm/deep-ask.ts', 'DEEP_ASK_INPUT_CAP_TOKENS');
    expect(s08).toContain(`DEEP_ASK_INPUT_CAP_TOKENS = ${cap.toLocaleString('en-US')}`);
    expect(read('spec/tech/02-llm-provider.md')).toContain(`min(inputBudget, ${cap.toLocaleString('en-US')})`);
  });

  it('states the sidecar caps from src/main/library/sources.ts', () => {
    const file = 'src/main/library/sources.ts';
    const perSource = numericConstIn(file, 'MAX_SOURCE_CHARS');
    const perDoc = numericConstIn(file, 'MAX_SIDECAR_BYTES');
    expect(perDoc % (1024 * 1024)).toBe(0);
    expect(s09).toMatch(
      new RegExp(`within ${perSource.toLocaleString('en-US')} characters per source, ${perDoc / (1024 * 1024)} MiB`),
    );
    expect(read('spec/tech/hooks.md')).toContain(`(${perDoc / (1024 * 1024)} MiB cap)`);
  });

  it('lists the source copy on the public privacy page', () => {
    const privacy = read('docs/privacy/index.html');
    expect(privacy).toMatch(/private copy of the text extracted from each document's sources/);
    expect(privacy).toMatch(/never published or synced/);
  });
});

describe('Android parity in the user-facing docs', () => {
  it('no longer says the phone reader shows two tabs', () => {
    expect(read('README.md')).not.toMatch(/Both tabs/);
    expect(read(PRD)).not.toMatch(/both tabs/i);
  });
});

describe('CLAUDE.md', () => {
  const claude = read('CLAUDE.md');

  it('names the three tabs, the config/prompts exception and the post-M5 status', () => {
    expect(claude).toMatch(/three tabs/);
    expect(claude).toMatch(/ASD-STE100/);
    expect(claude).toMatch(/One exception ships with the app: `config\/prompts\/`/);
    expect(claude).toMatch(/After M5:/);
    expect(claude).toMatch(/sandbox="allow-scripts"/);
  });
});

describe('no doc describes the removed fixed explorables', () => {
  const files = [
    'README.md',
    'CLAUDE.md',
    PRD,
    ...markdownUnder('spec/tech'),
    ...markdownUnder('config/prompts'),
    'scripts/real-run/README.md',
  ];

  it.each(files)('%s', (file) => {
    const text = read(file);
    expect(text).not.toMatch(/explorable/i);
    expect(text).not.toMatch(/metropolis-walk/);
    expect(text).not.toMatch(/kind:\s*'gradient-descent'|`gradient-descent`/);
  });
});

describe('config/prompts/README.md', () => {
  it('lists each default prompt with the version in its front matter', () => {
    const readme = read('config/prompts/README.md');
    const dir = 'config/prompts/default';
    const prompts = readdirSync(join(repoRoot, dir)).filter((n) => n.endsWith('.md'));
    expect(prompts.length).toBeGreaterThan(10);
    for (const name of prompts) {
      const id = name.replace(/\.md$/, '');
      const version = /^version:\s*(\d+)/m.exec(read(`${dir}/${name}`))?.[1];
      expect(version, `${id} has a version`).toBeDefined();
      const row = new RegExp(`^\\|\\s*${id}\\s*\\|\\s*${version}\\s*\\|`, 'm');
      expect(readme, `${id}@${version} in the catalogue table`).toMatch(row);
    }
  });
});
