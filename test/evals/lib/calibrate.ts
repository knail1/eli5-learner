/**
 * Judge calibration (13 §9.5): the judge scores 10 hand-scored synthetic documents; agreement is the
 * mean absolute error per criterion, and a judge change is accepted only if every MAE <= 0.75.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EVALS_DIR, criteriaFor, judgePart, type JudgeFn } from './judge';
import { mean } from './scoring';
import type { Rubrics } from './types';

export const MAX_MAE = 0.75;

const ScoreMap = z.record(z.string().regex(/^[DE][1-7]$/), z.number().int().min(1).max(5));

export const CalibrationDocSchema = z
  .object({
    id: z.string().regex(/^cal-[a-z0-9-]+$/),
    domain: z.string(),
    glossary: z.boolean(),
    /** Extra case facts for the judge (e.g. skipped sources), as the runner's context block. */
    context: z.string().optional(),
    sources: z.string().min(1),
    mustCover: z.array(z.string()),
    jargon: z.array(z.string()),
    tabs: z.object({ indepth: z.string().min(1), eli5: z.string().min(1) }).strict(),
    human: z.object({ indepth: ScoreMap, eli5: ScoreMap }).strict(),
    notes: z.string(),
  })
  .strict();
export type CalibrationDoc = z.infer<typeof CalibrationDocSchema>;

export function loadCalibrationDocs(dir = path.join(EVALS_DIR, 'calibration')): CalibrationDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => CalibrationDocSchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8'))));
}

export interface Agreement {
  criteria: Record<string, { mae: number; n: number }>;
  pass: boolean;
  failing: string[];
}

export function agreement(
  pairs: readonly { judge: Record<string, number>; human: Record<string, number> }[],
): Agreement {
  const errs: Record<string, number[]> = {};
  for (const p of pairs) {
    for (const [k, h] of Object.entries(p.human)) {
      const j = p.judge[k];
      if (j !== undefined) (errs[k] ??= []).push(Math.abs(j - h));
    }
  }
  const criteria = Object.fromEntries(
    Object.keys(errs)
      .sort()
      .map((k) => [k, { mae: mean(errs[k] as number[]), n: (errs[k] as number[]).length }]),
  );
  const failing = Object.entries(criteria)
    .filter(([, v]) => v.mae > MAX_MAE + 1e-9)
    .map(([k]) => k);
  return { criteria, pass: failing.length === 0, failing };
}

export interface CalibrationReport extends Agreement {
  schemaVersion: 1;
  date: string;
  judge: { provider: string; model: string; runs: number };
  maxMae: number;
  docs: { id: string; tab: 'indepth' | 'eli5'; judge: Record<string, number>; human: Record<string, number> }[];
}

export async function runCalibration(o: {
  docs: readonly CalibrationDoc[];
  rubrics: Rubrics;
  template: string;
  judge: JudgeFn;
  judgeRuns: number;
  info: { provider: string; model: string };
  resultsDir: string;
  now?: () => Date;
  log?: (line: string) => void;
}): Promise<{ report: CalibrationReport; file: string }> {
  const log = o.log ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const date = (o.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const rows: CalibrationReport['docs'] = [];
  for (const d of o.docs) {
    const context = [`Glossary requested: ${d.glossary ? 'yes' : 'no'}`, ...(d.context ? [d.context] : [])].join('\n');
    for (const tab of ['indepth', 'eli5'] as const) {
      const part = await judgePart(
        o.judge,
        {
          part: tab,
          criteria: criteriaFor(tab, { glossary: d.glossary }),
          sources: d.sources,
          material: d.tabs[tab],
          context,
          mustCover: d.mustCover,
          jargon: d.jargon,
        },
        o.rubrics[tab],
        o.template,
        o.judgeRuns,
      );
      rows.push({ id: d.id, tab, judge: part.medians, human: d.human[tab] });
      log(`[calibrate] ${d.id} ${tab}: judged`);
    }
  }
  const a = agreement(rows);
  const report: CalibrationReport = {
    schemaVersion: 1,
    date,
    judge: { ...o.info, runs: o.judgeRuns },
    maxMae: MAX_MAE,
    ...a,
    docs: rows,
  };
  await mkdir(o.resultsDir, { recursive: true });
  const safe = (s: string): string => s.replace(/[^\w.-]+/g, '_');
  const file = path.join(o.resultsDir, `calibration-${date}-${safe(o.info.provider)}-${safe(o.info.model)}.json`);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  for (const [k, v] of Object.entries(a.criteria)) log(`[calibrate] ${k}: MAE ${v.mae.toFixed(2)} (n=${v.n})`);
  log(
    a.pass
      ? `[calibrate] PASS: every MAE <= ${MAX_MAE}`
      : `[calibrate] FAIL: MAE > ${MAX_MAE} for ${a.failing.join(', ')}`,
  );
  return { report, file };
}
