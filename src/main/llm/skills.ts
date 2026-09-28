import fs from 'node:fs';
import path from 'node:path';
import { log } from '../security';
import { estimateTokens } from './budget';
import { parseFrontMatter } from './prompts';

/**
 * HTML skills (02 §11): directories with SKILL.md plus optional examples. Roots are searched in
 * priority order (user folder, organization-approved dirs from HOOK-LLM-02, bundled defaults); the
 * first skill of a name wins. Re-read on folder changes (debounced), so no restart is needed.
 */

export type SkillSlot = 'beautiful-doc' | 'eli5';
/** Values of the optional `appliesTo` front matter (02 §11 Format). */
export type SkillTask = 'indepth' | 'eli5' | 'section';
const ALL_TASKS: readonly SkillTask[] = ['indepth', 'eli5', 'section'];
export const SKILL_SLOTS: readonly SkillSlot[] = ['beautiful-doc', 'eli5'];

export interface Skill {
  name: string;
  slot: string;
  appliesTo: readonly string[];
  body: string;
  /** Example files sent to the model as reference (*.html, *.md). */
  examples: { file: string; text: string }[];
  /** Visual CSS handed to 07 as a theme input; never sent to the model. */
  css: { file: string; text: string }[];
  dir: string;
}

/** Built-in fallback when a slot has no skill: the app still works (02 §11). */
export const FALLBACK_SKILL_TEXT: Readonly<Record<SkillSlot, string>> = {
  'beautiful-doc':
    'Write like a strong explanatory news feature: lead with why it matters, give every chart a takeaway headline, ' +
    'use pull quotes and callouts sparingly, and prefer one clear visual over several weak ones.',
  eli5:
    'Explain as if to a curious newcomer: short sentences, everyday analogies, one idea per paragraph, and no jargon ' +
    'unless it is immediately explained in plain words.',
};

export const EXAMPLE_TOKEN_CAP = 8000;
export const SKILLS_CONTEXT_SHARE = 0.2;

const EXAMPLE_EXT = new Set(['.html', '.htm', '.md']);

function readSkill(dir: string): Skill | null {
  let src: string;
  try {
    src = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  let parsed: ReturnType<typeof parseFrontMatter>;
  try {
    parsed = parseFrontMatter(src);
  } catch {
    // A malformed user or policy skill is skipped, never fatal (02 §11 hot reload).
    log.warn('llm.skill-invalid', { path: path.basename(dir) });
    return null;
  }
  const { data, body } = parsed;
  const name = typeof data.name === 'string' ? data.name : path.basename(dir);
  const slot = typeof data.slot === 'string' ? data.slot : name;
  const appliesTo =
    typeof data.appliesTo === 'string' ? [data.appliesTo] : Array.isArray(data.appliesTo) ? data.appliesTo : ALL_TASKS;
  const examples: Skill['examples'] = [];
  const css: Skill['css'] = [];
  for (const file of safeReaddir(dir).sort()) {
    if (file === 'SKILL.md') continue;
    const ext = path.extname(file).toLowerCase();
    const full = path.join(dir, file);
    if (!EXAMPLE_EXT.has(ext) && ext !== '.css') continue;
    let text: string;
    try {
      if (!fs.statSync(full).isFile()) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    (ext === '.css' ? css : examples).push({ file, text });
  }
  return { name, slot, appliesTo, body: body.trim(), examples, css, dir };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function truncateToTokens(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text;
  // estimateTokens is ~chars/3.5 for Latin text; cut by characters and mark the cut.
  return text.slice(0, Math.max(0, Math.floor(tokens * 3.5))) + '\n[...truncated]';
}

export interface RenderedSkills {
  text: string;
  tokens: number;
  /** Slots that used the built-in fallback. */
  fallbacks: string[];
  trimmed: 'none' | 'examples-dropped' | 'body-truncated';
}

export class SkillLibrary {
  private skills = new Map<string, Skill>();
  private watchers: fs.FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly roots: readonly string[],
    private readonly debounceMs = 1000,
  ) {
    this.reload();
  }

  reload(): void {
    const next = new Map<string, Skill>();
    for (const root of this.roots) {
      for (const entry of safeReaddir(root).sort()) {
        const dir = path.join(root, entry);
        const skill = readSkill(dir);
        if (!skill || next.has(skill.name)) continue; // earlier root wins
        next.set(skill.name, skill);
      }
    }
    this.skills = next;
  }

  /**
   * Watch every root; changes reload after `debounceMs` (02 §11). A root that does not exist yet
   * (the user skills folder on a fresh install) is awaited through its parent folder.
   */
  watch(): void {
    for (const root of this.roots) this.watchRoot(root);
  }

  private watchRoot(root: string): void {
    if (fs.existsSync(root)) {
      try {
        this.watchers.push(fs.watch(root, { recursive: true }, () => this.schedule()));
      } catch {
        log.warn('llm.skills-watch-failed', { path: path.basename(root) });
      }
      return;
    }
    const parent = path.dirname(root);
    if (parent === root || !fs.existsSync(parent)) return;
    try {
      const w = fs.watch(parent, () => onParent());
      const onParent = (): void => {
        if (!fs.existsSync(root) || !this.watchers.includes(w)) return;
        w.close();
        this.watchers = this.watchers.filter((x) => x !== w);
        this.watchRoot(root);
        this.schedule();
      };
      this.watchers.push(w);
      onParent(); // the folder may have appeared while the watcher was being set up
    } catch {
      log.warn('llm.skills-watch-failed', { path: path.basename(root) });
    }
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** The skill serving a slot: a skill whose name or `slot` equals it, first root first. */
  forSlot(slot: string, task?: SkillTask): Skill | undefined {
    const applies = (s: Skill | undefined): s is Skill => s !== undefined && (!task || s.appliesTo.includes(task));
    const byName = this.skills.get(slot);
    return applies(byName) ? byName : [...this.skills.values()].find((s) => s.slot === slot && applies(s));
  }

  /** CSS from the slot skills, for 07's theme (02 §11 "Visual CSS ... theme input"). */
  themeCss(slots: readonly string[] = SKILL_SLOTS): string {
    return slots.flatMap((s) => this.forSlot(s)?.css.map((c) => c.text) ?? []).join('\n');
  }

  /**
   * System-prompt text for the requested slots under `## Style guide: <name>` headings. Examples are
   * truncated to 8k tokens per skill; if all skills exceed 20% of the context window, examples are
   * dropped first, then bodies truncated, and a warning is logged (02 §11 Budget). With `task`, a
   * skill whose `appliesTo` excludes it is passed over (the slot falls back to the built-in text).
   */
  render(slots: readonly string[], contextTokens: number, task?: SkillTask): RenderedSkills {
    const budget = Math.floor(contextTokens * SKILLS_CONTEXT_SHARE);
    const fallbacks: string[] = [];
    const parts = slots.map((slot) => {
      const skill = this.forSlot(slot, task);
      if (!skill) {
        fallbacks.push(slot);
        const text = FALLBACK_SKILL_TEXT[slot as SkillSlot] ?? '';
        return { name: slot, body: text, examples: '' };
      }
      const examples = skill.examples.length
        ? truncateToTokens(
            skill.examples.map((e) => `### Reference example: ${e.file}\n\n${e.text.trim()}`).join('\n\n'),
            EXAMPLE_TOKEN_CAP,
          )
        : '';
      return { name: skill.name, body: skill.body, examples };
    });
    const join = (withExamples: boolean, bodyCap?: number): string =>
      parts
        .map((p) => {
          const body = bodyCap !== undefined ? truncateToTokens(p.body, bodyCap) : p.body;
          const ex = withExamples && p.examples ? `\n\n${p.examples}` : '';
          return `## Style guide: ${p.name}\n\n${body}${ex}`;
        })
        .join('\n\n');
    let text = join(true);
    let trimmed: RenderedSkills['trimmed'] = 'none';
    if (estimateTokens(text) > budget) {
      text = join(false);
      trimmed = 'examples-dropped';
      if (estimateTokens(text) > budget) {
        text = join(false, Math.max(0, Math.floor(budget / Math.max(1, parts.length)) - 50));
        trimmed = 'body-truncated';
      }
      log.warn('llm.skills-trimmed', { kind: trimmed, count: parts.length });
    }
    return { text, tokens: estimateTokens(text), fallbacks, trimmed };
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.reload();
      } catch {
        log.warn('llm.skills-reload-failed', {}); // keep the previous skills
      }
    }, this.debounceMs);
  }
}
