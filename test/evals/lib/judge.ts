/**
 * LLM judge (13 §9.3 steps 3-5, §9.4, §9.5): rubric loading, the judge prompt (prompted JSON), output
 * validation with one repair retry, and N runs aggregated by median.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ImageInput } from '../../../src/main/llm';
import { aggregateRuns } from './scoring';
import {
  RUBRIC_IDS,
  RubricSchema,
  type EvalSectionAction,
  type JudgedPart,
  type JudgeOutput,
  type Rubric,
  type RubricId,
  type Rubrics,
} from './types';

export const EVALS_DIR = path.resolve(import.meta.dirname, '..');

export function loadRubrics(dir = path.join(EVALS_DIR, 'rubrics')): Rubrics {
  const out = {} as Rubrics;
  for (const id of RUBRIC_IDS) {
    const r = RubricSchema.parse(JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8')));
    if (r.id !== id) throw new Error(`rubrics/${id}.json declares id ${r.id}`);
    out[id] = r;
  }
  return out;
}

export function loadJudgeTemplate(file = path.join(EVALS_DIR, 'prompts', 'judge.md')): string {
  return readFileSync(file, 'utf8');
}

/** Criteria scored for a part: D6 is N/A with the glossary off; S3 only when a user note was given. */
export function criteriaFor(part: RubricId, o: { glossary?: boolean; note?: boolean }): string[] {
  switch (part) {
    case 'indepth':
      return ['D1', 'D2', 'D3', 'D4', 'D5', ...(o.glossary ? ['D6'] : []), 'D7'];
    case 'eli5':
      return ['E1', 'E2', 'E3', 'E4', 'E5'];
    case 'section':
      return ['S1', 'S2', ...(o.note ? ['S3'] : [])];
  }
}

export interface JudgeInput {
  part: RubricId;
  criteria: string[];
  /** Extracted source text as the generator saw it. */
  sources: string;
  /** The graded tab's visible text, or the rewritten section. */
  material: string;
  /** Case facts for the judge: clarifying input, section action, note, neighbouring text. */
  context: string;
  mustCover: string[];
  jargon: string[];
  /** Source images (vision input) when the case had any. */
  images?: ImageInput[];
}

const ACTION_MEANING: Record<EvalSectionAction, string> = {
  expand: 'expand: add more detail and explanation to this section',
  reexplain: 'reexplain: explain the same content more clearly, a different way',
  analogy: 'analogy: add an apt analogy that makes the idea click',
  deeper: 'deeper: go into more technical depth for an expert-curious reader',
  'section-eli5': 'section ELI5: a new tab explaining just this section as simply as possible',
};

/**
 * Judge input for one section action (13 §9.3 step 4), shared by the runner and calibration: the
 * rewrite (or the new Section ELI5 tab) graded against the section before it and its neighbours.
 */
export function sectionJudgeInput(a: {
  action: EvalSectionAction;
  note?: string | undefined;
  before: string;
  neighbours?: string | undefined;
  material: string;
}): Omit<JudgeInput, 'part'> {
  const context = [
    `Section action requested: ${ACTION_MEANING[a.action]}`,
    `User note: ${a.note ?? 'none'}`,
    `The section before the action:\n${a.before}`,
    ...(a.neighbours ? [`Neighbouring sections (after the action):\n${a.neighbours}`] : []),
  ].join('\n\n');
  return {
    criteria: criteriaFor('section', { note: a.note !== undefined }),
    sources: '(not needed for this rubric: judge the rewrite against the section before it and its neighbours)',
    material: a.material,
    context,
    mustCover: [],
    jargon: [],
  };
}

export interface JudgeRequest {
  system: string;
  user: string;
  images?: ImageInput[];
}

/** One judge call; the runner binds it to a budget-guarded provider, tests to a fake. */
export type JudgeFn = (req: JudgeRequest) => Promise<string>;

/** The judge failed twice to return valid JSON (13 §14: the case becomes `judge_error`). */
export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeError';
  }
}

const PART_LABELS: Record<RubricId, string> = {
  indepth: 'the In depth tab',
  eli5: 'the ELI5 tab',
  section: 'one section rewritten by a section action',
};

/** Neutralizes a closing delimiter inside graded data so it cannot end its block early. */
const fence = (s: string): string => s.replace(/<\/(sources|material|context)>/gi, '&lt;/$1>');

function rubricText(r: Rubric, ids: readonly string[]): string {
  return r.criteria
    .filter((c) => ids.includes(c.id))
    .map(
      (c) =>
        `### ${c.id} ${c.name}\n5 means: ${c.fiveMeans}\n` +
        c.anchors.map((a) => `- Anchor, score ${a.score}: ${a.excerpt}\n  Why: ${a.why}`).join('\n'),
    )
    .join('\n\n');
}

const bullets = (xs: readonly string[], none: string): string =>
  xs.length ? xs.map((x) => `- ${x}`).join('\n') : none;

export function buildJudgePrompt(
  input: JudgeInput,
  rubric: Rubric,
  template: string,
): { system: string; user: string } {
  const m = /^# System\s*\n([\s\S]*?)\n# User\s*\n([\s\S]*)$/.exec(template);
  if (!m) throw new Error('judge template needs "# System" and "# User" sections');
  const ids = input.criteria;
  const vars: Record<string, string> = {
    partLabel: PART_LABELS[input.part],
    rubricTitle: rubric.title,
    rubric: rubricText(rubric, ids),
    mustCover: bullets(input.mustCover, '(none listed)'),
    jargon: bullets(input.jargon, '(none listed)'),
    criteriaIds: ids.join(', '),
    scoresShape: `{${ids.map((id) => `"${id}": 1-5`).join(', ')}}`,
    rationaleShape: `{${ids.map((id) => `"${id}": "..."`).join(', ')}}`,
    context: fence(input.context || '(none)'),
    sources: fence(input.sources || '(no text: see the attached images)'),
    material: fence(input.material),
  };
  // Single pass, so text inside a value is never treated as a placeholder.
  const fill = (s: string): string =>
    s.replace(/\{\{(\w+)\}\}/g, (all, k: string) => {
      const v = vars[k];
      if (v === undefined) throw new Error(`judge template placeholder {{${k}}} has no value`);
      return v;
    });
  return { system: fill(m[1] ?? '').trim(), user: fill(m[2] ?? '').trim() };
}

const Score = z.number().int().min(1).max(5);

/** Parses and validates one judge reply; throws with a message fit to send back to the judge. */
export function parseJudgeOutput(text: string, criteria: readonly string[]): JudgeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the reply contained no json object');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`the reply is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const keys = Object.fromEntries(criteria.map((c) => [c, Score])) as Record<string, typeof Score>;
  const schema = z
    .object({
      scores: z.object(keys).strict(),
      rationale: z.record(z.string(), z.string()),
      missingFacts: z.array(z.string()),
    })
    .strip();
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => {
      const where = i.path.join('.');
      const extra = i.code === 'unrecognized_keys' ? ` (${i.keys.join(', ')})` : '';
      return `${where || '(root)'}: ${i.message}${extra}`;
    });
    throw new Error(`the reply does not match the schema: ${issues.join('; ')}`);
  }
  return r.data as JudgeOutput;
}

/** One judge run: a single repair retry with the schema error appended (13 §14). */
async function judgeOnce(judge: JudgeFn, req: JudgeRequest, criteria: readonly string[]): Promise<JudgeOutput> {
  let first: string;
  try {
    return parseJudgeOutput(await judge(req), criteria);
  } catch (e) {
    if (!isParseError(e)) throw e;
    first = (e as Error).message;
  }
  const retry: JudgeRequest = {
    ...req,
    user: `${req.user}\n\nYour previous reply was rejected: ${first}. Reply again with only the JSON object described in the instructions.`,
  };
  try {
    return parseJudgeOutput(await judge(retry), criteria);
  } catch (e) {
    if (!isParseError(e)) throw e;
    throw new JudgeError(`judge returned invalid output twice: ${(e as Error).message}`);
  }
}

const PARSE_ERROR = /^the reply /;
const isParseError = (e: unknown): boolean => e instanceof Error && PARSE_ERROR.test(e.message);

/** Runs the judge `runs` times (13 §9.3 step 5) and aggregates by median. */
export async function judgePart(
  judge: JudgeFn,
  input: JudgeInput,
  rubric: Rubric,
  template: string,
  runs: number,
): Promise<JudgedPart> {
  const p = buildJudgePrompt(input, rubric, template);
  const req: JudgeRequest = { ...p, ...(input.images?.length ? { images: input.images } : {}) };
  const outs: JudgeOutput[] = [];
  for (let i = 0; i < runs; i++) outs.push(await judgeOnce(judge, req, input.criteria));
  return aggregateRuns(outs, input.criteria);
}
