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
