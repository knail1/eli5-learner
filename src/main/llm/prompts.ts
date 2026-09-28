import fs from 'node:fs';
import path from 'node:path';
import { DRAFT_SCHEMAS, type DraftSchemaName } from './schemas/draft';
import { PROMPT_IDS, type GenerationRequest, type PromptId } from './types';

/**
 * Prompt catalogue (02 §9): Markdown with front matter, `# System` / `# User` parts, and
 * `{{var}}` / `{{var | "default"}}` substitution only. Loaded once at startup from
 * resources/prompts (dev) or <Resources>/prompts (packaged), with HOOK-LLM-02 overrides first.
 */

export interface PromptDef {
  id: PromptId;
  version: number;
  output: DraftSchemaName | 'text';
  temperature?: number;
  effort?: NonNullable<GenerationRequest['effort']>;
  maxOutputTokens: number;
  skills: string[];
  system: string;
  user: string;
  /** Every variable referenced by the template. */
  vars: string[];
  /** "id@version", written to meta.json generation.prompts. */
  tag: string;
}

/** Variables each task function supplies (02 §16 prompt lint). Unknown vars fail the load. */
export const PROMPT_VARS: Readonly<Record<PromptId, readonly string[]>> = {
  'in-depth': [
    'skills',
    'glossaryInstructions',
    'contentMode',
    'visibleOutputTokens',
    'imageLabels',
    'clarifyingInput',
    'sourceList',
    'content',
    'overflowAddendum',
    'photoInstructions',
  ],
  eli5: [
    'skills',
    'contentMode',
    'visibleOutputTokens',
    'imageLabels',
    'clarifyingInput',
    'sourceList',
    'content',
    'photoInstructions',
  ],
  glossary: ['clarifyingInput', 'indepthText'],
  'chunk-notes': ['chunkIndex', 'chunkCount', 'clarifyingInput', 'sourceList', 'content'],
  'section-expand': ['skills', 'tabKind', 'outline', 'section', 'prevText', 'nextText', 'selection', 'note'],
  'section-reexplain': ['skills', 'tabKind', 'outline', 'section', 'prevText', 'nextText', 'selection', 'note'],
  'section-analogy': ['skills', 'tabKind', 'outline', 'section', 'prevText', 'nextText', 'selection', 'note'],
  'section-deeper': [
    'skills',
    'tabKind',
    'outline',
    'section',
    'prevText',
    'nextText',
    'selection',
    'note',
    'sourceExcerpt',
  ],
  'section-eli5-tab': ['skills', 'outline', 'section', 'selection', 'note'],
  'selection-eli5-tab': ['skills', 'outline', 'context', 'selection', 'note'],
  summary: ['title', 'outline', 'indepthExcerpt'],
  'merge-match': ['summary', 'candidates'],
  'photo-pick': ['slots'],
  'merge-weave': ['skills', 'targetTitle', 'incomingTitle', 'target', 'incoming', 'imageLabels'],
};

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptError';
  }
}

const VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\|\s*"((?:[^"\\]|\\.)*)"\s*)?\}\}/g;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

type FrontValue = string | number | string[];

/** Minimal front-matter reader: `key: value`, `[a, b]` lists, numbers, `# comments`. */
export function parseFrontMatter(src: string): { data: Record<string, FrontValue>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, FrontValue> = {};
  for (const rawLine of (m[1] ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new PromptError(`Bad front matter line: ${line}`);
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s !== '');
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      data[key] = Number(raw);
    } else {
      data[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: src.slice(m[0].length) };
}

export function templateVars(template: string): string[] {
  return [...new Set([...template.matchAll(VAR_RE)].map((x) => x[1] ?? ''))];
}

/** `{{var}}` substitution with optional `| "default"`; a missing var without default throws. */
export function renderTemplate(template: string, vars: Readonly<Record<string, string | undefined>>): string {
  return template.replace(VAR_RE, (_all, name: string, def: string | undefined) => {
    const v = vars[name];
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def.replace(/\\(.)/g, '$1');
    if (v === '') return '';
    throw new PromptError(`Prompt variable "${name}" was not supplied`);
  });
}

export function parsePrompt(id: string, src: string): PromptDef {
  if (!(PROMPT_IDS as readonly string[]).includes(id)) throw new PromptError(`Unknown prompt id "${id}"`);
  const pid = id as PromptId;
  const { data, body } = parseFrontMatter(src);
  if (data.id !== id) throw new PromptError(`Prompt ${id}: front matter id is "${String(data.id)}"`);
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) throw new PromptError(`Prompt ${id}: bad version`);
  const output = data.output;
  if (typeof output !== 'string' || (output !== 'text' && !(output in DRAFT_SCHEMAS))) {
    throw new PromptError(`Prompt ${id}: output "${String(output)}" is not a schema in schemas/draft.ts`);
  }
  const maxOutputTokens = data.maxOutputTokens;
  if (typeof maxOutputTokens !== 'number') throw new PromptError(`Prompt ${id}: maxOutputTokens missing`);
  const effort = data.effort;
  if (effort !== undefined && !(EFFORTS as readonly unknown[]).includes(effort)) {
    throw new PromptError(`Prompt ${id}: bad effort "${String(effort)}"`);
  }
  const temperature = data.temperature;
  if (temperature !== undefined && typeof temperature !== 'number')
    throw new PromptError(`Prompt ${id}: bad temperature`);
  const skills = data.skills ?? [];
  if (!Array.isArray(skills)) throw new PromptError(`Prompt ${id}: skills must be a list`);

  const parts = /^# System\s*\r?\n([\s\S]*?)^# User\s*\r?\n([\s\S]*)$/m.exec(body);
  if (!parts) throw new PromptError(`Prompt ${id}: needs "# System" then "# User"`);
  const system = (parts[1] ?? '').trim();
  const user = (parts[2] ?? '').trim();
  const vars = templateVars(system + '\n' + user);
  const allowed = PROMPT_VARS[pid];
  const unknown = vars.filter((v) => !allowed.includes(v));
  if (unknown.length) throw new PromptError(`Prompt ${id}: unknown variable(s) ${unknown.join(', ')}`);
  return {
    id: pid,
    version,
    output: output as DraftSchemaName | 'text',
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort !== undefined ? { effort: effort as PromptDef['effort'] & string } : {}),
    maxOutputTokens,
    skills,
    system,
    user,
    vars,
    tag: `${id}@${version}`,
  };
}

export class PromptCatalogue {
  private constructor(private readonly prompts: ReadonlyMap<PromptId, PromptDef>) {}

  /** Loads every catalogue prompt; `dirs` in priority order (overlay overrides first, 02 §13). */
  static load(dirs: readonly string[], read: (p: string) => string | null = readIfExists): PromptCatalogue {
    const map = new Map<PromptId, PromptDef>();
    for (const id of PROMPT_IDS) {
      let src: string | null = null;
      for (const dir of dirs) {
        src = read(path.join(dir, `${id}.md`));
        if (src !== null) break;
      }
      if (src === null) throw new PromptError(`Prompt file ${id}.md not found`);
      map.set(id, parsePrompt(id, src));
    }
    return new PromptCatalogue(map);
  }

  get(id: PromptId): PromptDef {
    const p = this.prompts.get(id);
    if (!p) throw new PromptError(`Prompt ${id} not loaded`);
    return p;
  }

  all(): PromptDef[] {
    return [...this.prompts.values()];
  }

  /** Renders both parts; every variable the template uses must be present in `vars` or defaulted. */
  render(
    id: PromptId,
    vars: Readonly<Record<string, string | undefined>>,
  ): { system: string; user: string; def: PromptDef } {
    const def = this.get(id);
    return { system: renderTemplate(def.system, vars), user: renderTemplate(def.user, vars), def };
  }
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
