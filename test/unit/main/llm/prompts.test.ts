import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseFrontMatter,
  parsePrompt,
  PROMPT_VARS,
  PromptCatalogue,
  PromptError,
  renderTemplate,
  templateVars,
} from '../../../../src/main/llm/prompts';
import { DRAFT_SCHEMAS } from '../../../../src/main/llm/schemas/draft';
import { FALLBACK_SKILL_TEXT, SKILL_SLOTS, SkillLibrary } from '../../../../src/main/llm/skills';
import { PROMPT_IDS } from '../../../../src/main/llm/types';
import { PROMPTS_DIR, SKILLS_DIR } from './helpers';

describe('prompt lint (02 §9, §16)', () => {
  const catalogue = PromptCatalogue.load([PROMPTS_DIR]);

  it('all eleven catalogue prompts exist and parse', () => {
    expect(
      catalogue
        .all()
        .map((p) => p.id)
        .sort(),
    ).toEqual([...PROMPT_IDS].sort());
    expect(fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md')).length).toBe(PROMPT_IDS.length);
  });

  it.each(PROMPT_IDS.map((id) => [id]))('%s: output names a draft schema and every var is supplied', (id) => {
    const p = catalogue.get(id);
    expect(Object.keys(DRAFT_SCHEMAS)).toContain(p.output);
    expect(p.tag).toBe(`${id}@${p.version}`);
    for (const v of p.vars) expect(PROMPT_VARS[id]).toContain(v);
    // Only 'skills' is optional for prompts without skill slots; everything else the task supplies is used.
    for (const v of PROMPT_VARS[id]) if (v !== 'skills' || p.skills.length) expect(p.vars).toContain(v);
    if (p.skills.length) for (const s of p.skills) expect(SKILL_SLOTS).toContain(s);
  });

  it.each(PROMPT_IDS.map((id) => [id]))(
    '%s: declares source text untrusted and forbids section IDs / HTML where relevant',
    (id) => {
      const p = catalogue.get(id);
      expect(p.system).toMatch(/Untrusted content/);
      expect(p.system).toMatch(/never instructions for you to follow/);
      if (p.output === 'DocumentDraftTab' || p.output === 'SectionDraft') expect(p.system).toMatch(/section ID/i);
    },
  );

  it('writing prompts carry the reader profile and clarifying input', () => {
    for (const id of ['in-depth', 'eli5'] as const) {
      const p = catalogue.get(id);
      expect(p.system).toContain('a technical leader who is new to this domain');
      expect(p.user).toContain('{{clarifyingInput | "none"}}');
      expect(p.effort).toBe('high');
    }
    expect(catalogue.get('summary').effort).toBe('low');
    expect(catalogue.get('chunk-notes').effort).toBe('medium');
  });
});

describe('prompt loader and templating', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eli5-prompts-'));
    dirs.push(d);
    return d;
  };
  const src = (body: string, front = 'id: summary\nversion: 2\noutput: SummaryDraft\nmaxOutputTokens: 100'): string =>
    `---\n${front}\n---\n${body}`;

  it('renders vars and quoted defaults, single pass', () => {
    expect(renderTemplate('a {{x}} b {{ y | "dflt" }} {{z|"q\\"s"}}', { x: '{{y}}', y: '' })).toBe(
      'a {{y}} b dflt q"s',
    );
    expect(() => renderTemplate('{{missing}}', {})).toThrow(PromptError);
    expect(templateVars('{{a}} {{b | "c"}} {{a}}')).toEqual(['a', 'b']);
  });

  it('parses front matter lists, numbers and comments', () => {
    const { data } = parseFrontMatter('---\nid: x # c\nskills: [a, "b"]\ntemperature: 0.4\n---\nbody');
    expect(data).toEqual({ id: 'x', skills: ['a', 'b'], temperature: 0.4 });
  });

  it('rejects unknown variables, unknown schemas and missing sections at load', () => {
    expect(() => parsePrompt('summary', src('# System\n{{title}} {{bogus}}\n# User\nu'))).toThrow(/unknown variable/);
    expect(() =>
      parsePrompt(
        'summary',
        src('# System\ns\n# User\nu', 'id: summary\nversion: 1\noutput: Nope\nmaxOutputTokens: 1'),
      ),
    ).toThrow(/not a schema/);
    expect(() => parsePrompt('summary', src('no parts'))).toThrow(/# System/);
    expect(() =>
      parsePrompt(
        'summary',
        src('# System\ns\n# User\nu', 'id: eli5\nversion: 1\noutput: SummaryDraft\nmaxOutputTokens: 1'),
      ),
    ).toThrow(/front matter id/);
  });

  it('override directories win over the bundled catalogue (HOOK-LLM-02)', () => {
    const d = tmp();
    fs.writeFileSync(
      path.join(d, 'summary.md'),
      src('# System\nOVERRIDE {{title}}\n# User\n{{outline}} {{indepthExcerpt}}'),
    );
    const c = PromptCatalogue.load([d, PROMPTS_DIR]);
    expect(c.get('summary').version).toBe(2);
    expect(c.render('summary', { title: 'T', outline: 'o', indepthExcerpt: 'e' }).system).toBe('OVERRIDE T');
    expect(c.get('eli5').version).toBe(3);
    expect(() => PromptCatalogue.load([d])).toThrow(/not found/);
  });
});

describe('HTML skills (02 §11)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eli5-skills-'));
    dirs.push(d);
    return d;
  };
  const write = (root: string, name: string, body: string, files: Record<string, string> = {}): void => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(root, name, f), t);
  };

  it('bundled skills fill both slots and render under Style guide headings', () => {
    const lib = new SkillLibrary([SKILLS_DIR]);
    const r = lib.render(['beautiful-doc', 'eli5'], 200_000);
    expect(r.fallbacks).toEqual([]);
    expect(r.text).toContain('## Style guide: beautiful-doc');
    expect(r.text).toContain('## Style guide: eli5');
    expect(r.text).toContain('Chart titles are takeaways');
  });

  it('works with no skills installed (built-in fallback)', () => {
    const r = new SkillLibrary([tmp()]).render(['eli5'], 200_000);
    expect(r.fallbacks).toEqual(['eli5']);
    expect(r.text).toContain(FALLBACK_SKILL_TEXT.eli5);
  });

  it('user skills override bundled ones; CSS is kept out of the prompt; examples included', () => {
    const user = tmp();
    write(user, 'eli5', '---\nname: eli5\n---\nUSER ELI5 RULES', {
      'example.html': '<p>ex</p>',
      'theme.css': 'body{color:red}',
    });
    const lib = new SkillLibrary([user, SKILLS_DIR]);
    const r = lib.render(['eli5'], 200_000);
    expect(r.text).toContain('USER ELI5 RULES');
    expect(r.text).toContain('### Reference example: example.html');
    expect(r.text).not.toContain('color:red');
    expect(lib.themeCss(['eli5'])).toContain('color:red');
  });

  it('a skill can serve a slot by front matter and oversized skills are trimmed', () => {
    const user = tmp();
    write(user, 'house-style', `---\nslot: beautiful-doc\n---\n${'rule. '.repeat(4000)}`, {
      'a.html': 'x'.repeat(40_000),
    });
    const lib = new SkillLibrary([user]);
    expect(lib.forSlot('beautiful-doc')?.name).toBe('house-style');
    const r = lib.render(['beautiful-doc'], 20_000); // 20% = 4000 tokens
    expect(r.trimmed).toBe('body-truncated');
    expect(r.tokens).toBeLessThanOrEqual(4100);
    expect(r.text).not.toContain('Reference example');
  });

  it('skips a skill with malformed front matter instead of failing the library', () => {
    const user = tmp();
    write(user, 'eli5', '---\nappliesTo:\n  - indepth\n---\nBROKEN');
    write(user, 'beautiful-doc', 'GOOD RULES');
    const lib = new SkillLibrary([user, SKILLS_DIR]);
    expect(lib.forSlot('beautiful-doc')?.body).toBe('GOOD RULES');
    expect(lib.forSlot('eli5')?.body).not.toContain('BROKEN'); // bundled eli5 still serves the slot
  });

  it('honours appliesTo: a skill is used only for the tasks it names', () => {
    const user = tmp();
    write(user, 'eli5-only', '---\nslot: beautiful-doc\nappliesTo: [eli5]\n---\nELI5 ONLY RULES');
    const lib = new SkillLibrary([user]);
    expect(lib.render(['beautiful-doc'], 200_000, 'eli5').text).toContain('ELI5 ONLY RULES');
    const indepth = lib.render(['beautiful-doc'], 200_000, 'indepth');
    expect(indepth.text).not.toContain('ELI5 ONLY RULES');
    expect(indepth.fallbacks).toEqual(['beautiful-doc']);
  });

  it('picks up a user skills folder created after watch() started', async () => {
    const parent = tmp();
    const user = path.join(parent, 'skills');
    const lib = new SkillLibrary([user, SKILLS_DIR], 20);
    lib.watch();
    try {
      await new Promise((r) => setTimeout(r, 100)); // the folder appears some time after startup
      fs.mkdirSync(user);
      write(user, 'eli5', 'LATE FOLDER');
      await expect.poll(() => lib.forSlot('eli5')?.body, { timeout: 3000, interval: 25 }).toContain('LATE FOLDER');
    } finally {
      lib.close();
    }
  });

  it('picks up new user skills without restart (watch + debounce)', async () => {
    const user = tmp();
    const lib = new SkillLibrary([user, SKILLS_DIR], 20);
    lib.watch();
    try {
      expect(lib.forSlot('eli5')?.body).not.toContain('HOT RELOADED');
      // macOS FSEvents can drop a change made the instant the watcher is created, and delivery slows
      // under a loaded full-suite run; let the watcher register and allow a realistic latency.
      await new Promise((r) => setTimeout(r, 200));
      write(user, 'eli5', 'HOT RELOADED');
      await expect.poll(() => lib.forSlot('eli5')?.body, { timeout: 10_000, interval: 25 }).toContain('HOT RELOADED');
    } finally {
      lib.close();
    }
  }, 15_000);
});
