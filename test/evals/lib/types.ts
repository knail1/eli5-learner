/**
 * Eval data shapes (13 §9): cases, rubrics, judge output, and the results / baseline files.
 * JSON inputs are validated with zod so a malformed case or rubric fails before any money is spent.
 */
import { z } from 'zod';

export const DOMAINS = ['security', 'finance', 'marketing', 'data', 'general'] as const;
export type Domain = (typeof DOMAINS)[number];

/** 13 §9.2 section actions; 'section-eli5' maps to 08's `eli5-tab` menu action. */
export const EVAL_SECTION_ACTIONS = ['expand', 'reexplain', 'analogy', 'deeper', 'section-eli5'] as const;
export type EvalSectionAction = (typeof EVAL_SECTION_ACTIONS)[number];

export const EvalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    /** Paths relative to test/fixtures/ (13 §5), or `evals/<path>` relative to test/evals/sources/. */
    sources: z.array(z.string().min(1)).min(1),
    clarifying: z.string().optional(),
    glossary: z.boolean(),
    domain: z.enum(DOMAINS),
    mustCover: z.array(z.string().min(1)).min(1),
    jargon: z.array(z.string().min(1)),
    sectionActions: z
      .array(
        z
          .object({
            action: z.enum(EVAL_SECTION_ACTIONS),
            sectionHint: z.string().min(1),
            /** Optional user note (judged by S3). Not in the 13 §9.2 interface; an additive extension. */
            note: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Coverage bookkeeping (not sent to any model): what this case exercises. */
    covers: z.array(z.string()).optional(),
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const RUBRIC_IDS = ['indepth', 'eli5', 'section'] as const;
export type RubricId = (typeof RUBRIC_IDS)[number];

export const RubricSchema = z
  .object({
    id: z.enum(RUBRIC_IDS),
    title: z.string().min(1),
    criteria: z
      .array(
        z
          .object({
            id: z.string().regex(/^[DES][1-9]$/),
            name: z.string().min(1),
            fiveMeans: z.string().min(1),
            /** 13 §9.5: a score-2 and a score-5 excerpt from synthetic material. */
            anchors: z
              .array(
                z.object({ score: z.number().int().min(1).max(5), excerpt: z.string().min(1), why: z.string().min(1) }),
              )
              .length(2),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Rubric = z.infer<typeof RubricSchema>;
export type Rubrics = Record<RubricId, Rubric>;

export type Score = 1 | 2 | 3 | 4 | 5;

/** 13 §9.3 step 3: what the judge must return. */
export interface JudgeOutput {
  scores: Record<string, Score>;
  rationale: Record<string, string>;
  missingFacts: string[];
}

/** Per tab (or per section action): medians over the judge runs (13 §9.3 step 5). */
export interface JudgedPart {
  /** Median per criterion. */
  medians: Record<string, number>;
  /** Mean of the medians. */
  score: number;
  /** One rationale per criterion (from a run that scored the median). */
  rationale: Record<string, string>;
  missingFacts: string[];
  /** Every run's scores, for variance inspection. */
  runs: Record<string, Score>[];
}

export interface SectionPartResult extends JudgedPart {
  action: EvalSectionAction;
  sectionHint: string;
  /** Set when the section job failed (the part scores 0): a job failure code, never model output. */
  error?: string;
}

export type CaseStatus = 'scored' | 'gate_failed' | 'judge_error' | 'generation_failed' | 'skipped_budget';

export interface GateResult {
  ok: boolean;
  failures: { gate: string; detail: string }[];
}

export interface CaseResult {
  id: string;
  domain: Domain;
  status: CaseStatus;
  /** Case score per part; 0 for a gate or generation failure (13 §9.3 step 2). */
  scores: { indepth?: number; eli5?: number; section?: number };
  indepth?: JudgedPart;
  eli5?: JudgedPart;
  sections?: SectionPartResult[];
  gates?: GateResult;
  /** Content-free reason for a non-scored status (error kind or code, never model output). */
  error?: string;
  skippedSources?: { ref: string; code: string }[];
}

export interface SuiteScores {
  indepth: number | null;
  eli5: number | null;
  section: number | null;
}

export interface RegressionReport {
  baseline: string;
  comparedCases: string[];
  regressed: boolean;
  reasons: string[];
  suiteDelta: SuiteScores;
  criterionDelta: Record<string, number>;
}

export interface EvalResults {
  schemaVersion: 1;
  runId: string;
  date: string;
  provider: string;
  model: string;
  judge: { provider: string; model: string; runs: number };
  /**
   * complete: every case ran. incomplete: the cost cap stopped the run (13 §9.6). inconclusive: a
   * case could not be judged, the run aborted, or no case matched the baseline; no baseline is
   * written from it.
   */
  status: 'complete' | 'incomplete' | 'inconclusive';
  costUsd: number;
  capUsd: number;
  cases: CaseResult[];
  suite: SuiteScores;
  criteria: Record<string, number>;
  regression: RegressionReport | null;
  notes: string[];
}

/** test/evals/baselines/<provider>.json: the committed subset of a results file. */
export interface Baseline {
  schemaVersion: 1;
  provider: string;
  model: string;
  date: string;
  judge: { provider: string; model: string };
  suite: SuiteScores;
  criteria: Record<string, number>;
  cases: Record<string, { scores: CaseResult['scores']; medians: Record<string, number> }>;
}
