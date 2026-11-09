import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkDocumentHtml, parseDocument, renderDocument } from '../document';
import type { DocumentMeta, VersionTreeView } from '../library';
import type { LLMProvider } from '../llm';
import { isTerminal } from '../pipeline';
import type {
  Job,
  JobFailureCode,
  JobSnapshot,
  JobStatus,
  RebuildReport,
  RebuildTarget,
  StartJobRequest,
} from '../pipeline';
import { log } from '../security';
import { BudgetGuardProvider, estimateTextTokens, IMAGE_TOKENS, MIN_OUTPUT_TOKENS } from './budget-guard';
import { CACHE_WRITE_MULTIPLIER, ratesFor, type ModelRates } from './rates';
import type { RealRunSession } from './real-run';

/**
 * Rebuild-as-new-version driver (design §5, D19-D20, D23-D24; dev builds only, no UI). For each
 * `slug=/abs/source` entry: a read-only preflight (library writable, slug present, the source's
 * sha256 equals meta.sourcesUsed, model priced, prompt set as requested, provider key present),
 * capture of the base version and html, a cost plan, then one rebuild job at a time behind a
 * per-document gate and a hard stop, and a post-commit verification that the new version is valid
 * and the replaced one can be checked out again. A JSON summary goes to stdout, then `quit`.
 */

/** No document starts once the ledger has passed this (design §8). */
export const REBUILD_HARD_STOP_USD = 10;

/**
 * The calls one rebuild makes (06 §5.4 steps 1, 1b, glossary, summary, photo-pick) plus the bounded
 * STE repair and an allowance for the per-call JSON-repair and output-overflow retries.
 */
export type RebuildPlanStep =
  'in-depth' | 'eli5' | 'ste' | 'ste-repair' | 'eli5-critique' | 'glossary' | 'summary' | 'photo-pick' | 'retries';
/** Prompt ids the plan reads front matter for (the repairs re-use their step's prompt). */
export type RebuildPromptId = Exclude<RebuildPlanStep, 'ste-repair' | 'retries'>;

/** Typical output tokens per step, high-effort thinking included (design §8). */
export const TYPICAL_OUTPUT_TOKENS: Readonly<Record<RebuildPromptId, number>> = {
  'in-depth': 18_000,
  eli5: 12_000,
  ste: 12_000,
  'eli5-critique': 10_000,
  glossary: 5_000,
  summary: 1_500,
  'photo-pick': 500,
};

/** Typical share of the other calls spent on JSON-repair and overflow retries (design §8: $0.12 of $1.70). */
export const TYPICAL_RETRY_SHARE = 0.07;

export interface CostPlanInput {
  rates: ModelRates;
  /** Estimated tokens of the source content (sent to in-depth and eli5). */
  sourceTokens: number;
  glossary: boolean;
  /** Stock photos are on (settings images.stockPhotos): the photo-pick call runs. */
  photos: boolean;
  /** The step's effective maxOutputTokens: front matter, clamped by settings llm.maxOutputTokens. */
  maxOutputTokens(id: RebuildPromptId): number;
  /** The step's request without content or drafts: rendered template, skills and fragments. */
  overheadTokens(id: RebuildPromptId): number;
}

export interface PlannedCall {
  step: RebuildPlanStep;
  typicalInputTokens: number;
  typicalOutputTokens: number;
  worstInputTokens: number;
  worstOutputTokens: number;
}

export interface CostPlan {
  typicalUsd: number;
  worstUsd: number;
  calls: PlannedCall[];
}

/**
 * Per-document cost. Typical: the design §8 output sizes (capped by each step's limit) at 1x input,
 * plus TYPICAL_RETRY_SHARE for repairs and retries. Worst case: every call at its full
 * maxOutputTokens, one STE lint repair, one more in-depth-sized call for a JSON repair or overflow
 * retry, and input at the 1.25x cache-write rate, as the budget guard reserves it. It is a planning
 * bound, not a guarantee: more retries or chunk-notes calls for a source over the context window
 * can exceed it, and the budget guard's cap is what actually limits spend. Drafts feed later steps:
 * STE and the glossary and summary read the in-depth draft; the critique reads the ELI5 draft plus
 * an outline (a tenth of the in-depth draft).
 */
export function planRebuildCost(i: CostPlanInput): CostPlan {
  const typOut = (id: RebuildPromptId): number => Math.min(i.maxOutputTokens(id), TYPICAL_OUTPUT_TOKENS[id]);
  const oh = (id: RebuildPromptId): number => i.overheadTokens(id);
  const max = (id: RebuildPromptId): number => i.maxOutputTokens(id);
  const calls: PlannedCall[] = [];
  const add = (step: RebuildPlanStep, ti: number, to: number, wi: number, wo: number): void => {
    calls.push({ step, typicalInputTokens: ti, typicalOutputTokens: to, worstInputTokens: wi, worstOutputTokens: wo });
  };
  const s = i.sourceTokens;
  add('in-depth', oh('in-depth') + s, typOut('in-depth'), oh('in-depth') + s, max('in-depth'));
  add('eli5', oh('eli5') + s, typOut('eli5'), oh('eli5') + s, max('eli5'));
  const dT = typOut('in-depth');
  const dW = max('in-depth');
  add('ste', oh('ste') + dT, typOut('ste'), oh('ste') + dW, max('ste'));
  add('ste-repair', 0, 0, oh('ste') + dW + max('ste'), max('ste'));
  add(
    'eli5-critique',
    oh('eli5-critique') + typOut('eli5') + Math.ceil(dT / 10),
    typOut('eli5-critique'),
    oh('eli5-critique') + max('eli5') + Math.ceil(dW / 10),
    max('eli5-critique'),
  );
  if (i.glossary) add('glossary', oh('glossary') + dT, typOut('glossary'), oh('glossary') + dW, max('glossary'));
  add('summary', oh('summary') + dT, typOut('summary'), oh('summary') + dW, max('summary'));
  if (i.photos) add('photo-pick', oh('photo-pick'), typOut('photo-pick'), oh('photo-pick'), max('photo-pick'));
  const inRate = i.rates.inputPerMTok / 1e6;
  const outRate = i.rates.outputPerMTok / 1e6;
  const sum = (f: (c: PlannedCall) => number): number => calls.reduce((n, c) => n + f(c), 0);
  const typIn = sum((c) => c.typicalInputTokens);
  const typOutAll = sum((c) => c.typicalOutputTokens);
  // Retries: a share of the typical calls; in the worst case one more full in-depth call.
  add(
    'retries',
    Math.ceil(typIn * TYPICAL_RETRY_SHARE),
    Math.ceil(typOutAll * TYPICAL_RETRY_SHARE),
    oh('in-depth') + s + max('in-depth'),
    max('in-depth'),
  );
  let typicalUsd = 0;
  let worstUsd = 0;
  for (const c of calls) {
    typicalUsd += c.typicalInputTokens * inRate + c.typicalOutputTokens * outRate;
    worstUsd += c.worstInputTokens * inRate * CACHE_WRITE_MULTIPLIER + c.worstOutputTokens * outRate;
  }
  return { typicalUsd, worstUsd, calls };
}

// ---- ports ----

/** The library calls the driver makes; FsLibrary satisfies it. All reads, no writes. */
export interface RebuildLibrary {
  readonly readOnly: boolean;
  hasSlug(slug: string): boolean;
  getEntry(slug: string): { id: string; createdAt: string } | undefined;
  getMeta(slug: string): Promise<DocumentMeta>;
  docPath(slug: string, file?: 'index.html' | 'meta.json'): string;
  versions(slug: string): Promise<VersionTreeView>;
  readVersion(slug: string, id: string): Promise<{ html: Buffer; meta: DocumentMeta }>;
}

/** The JobQueue surface the driver uses. */
export interface RebuildQueue {
  startRebuild(req: StartJobRequest, target: RebuildTarget): Promise<{ jobId: string }>;
  get(id: string): Job | undefined;
  on(event: 'changed', cb: (s: JobSnapshot) => void): () => void;
  cancel(id: string): Promise<void>;
}

/** What the plan needs from the prompt catalogue and settings (wired by the bootstrap). */
export interface RebuildPlanInputs {
  maxOutputTokens(id: RebuildPromptId): number;
  overheadTokens(id: RebuildPromptId): number;
}

/**
 * Plan inputs from the prompt catalogue (front matter maxOutputTokens, clamped by the setting) and
 * an overhead estimate per step: the template, the fragments its vars name, and the rendered skills.
 * Content and drafts are added by planRebuildCost.
 */
export function rebuildPlanInputs(o: {
  prompts: {
    get(id: RebuildPromptId): {
      system: string;
      user: string;
      vars: string[];
      skills: string[];
      maxOutputTokens: number;
    };
    fragments(): { id: string; body: string }[];
  };
  skills?: { render(slots: readonly string[], contextTokens: number): { text: string } };
  contextTokens: () => number;
  maxOutputSetting: () => number;
}): RebuildPlanInputs {
  const camel = (id: string): string => id.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return {
    maxOutputTokens: (id) => Math.min(o.prompts.get(id).maxOutputTokens, o.maxOutputSetting()),
    overheadTokens: (id) => {
      const def = o.prompts.get(id);
      const vars = new Set(def.vars);
      const frags = o.prompts.fragments().reduce((n, f) => n + (vars.has(camel(f.id)) ? f.body.length : 0), 0);
      const skills = def.skills.length && o.skills ? o.skills.render(def.skills, o.contextTokens()).text.length : 0;
      return estimateTextTokens(def.system.length + def.user.length + frags + skills);
    },
  };
}

export interface RebuildVerify {
  ok: boolean;
  versionId?: string;
  parentVersionId?: string | null;
  label?: string;
  /** The new index.html passes checkDocumentHtml against the new meta. */
  validity: boolean;
  /** parse -> render reproduces the new index.html byte for byte. */
  roundTrip: boolean;
  /** The new version has the ASD-STE100 tab. */
  hasSte: boolean;
  /** The catalog entry keeps the document's id and createdAt. */
  catalogStable: boolean;
  /** The current version node is this job's. */
  jobNode: boolean;
  /** Its parent is the base version the preflight captured. */
  parentIsBase: boolean;
  /** The parent's stored html hashes to the captured base html: the rebuild can be checked out back. */
  parentHtmlMatches: boolean;
}

export interface VerifyExpect {
  slug: string;
  jobId: string;
  docId: string;
  createdAt: string;
  baseVersionId: string | null;
  baseHtmlSha256: string;
}

const sha256Hex = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

/** Post-commit checks for one rebuilt document (design §5). Never throws; failures read false. */
export async function verifyRebuild(lib: RebuildLibrary, x: VerifyExpect): Promise<RebuildVerify> {
  const v: RebuildVerify = {
    ok: false,
    validity: false,
    roundTrip: false,
    hasSte: false,
    catalogStable: false,
    jobNode: false,
    parentIsBase: false,
    parentHtmlMatches: false,
  };
  try {
    const html = await readFile(lib.docPath(x.slug), 'utf8');
    const meta = await lib.getMeta(x.slug);
    v.validity = checkDocumentHtml(html, meta).ok;
    try {
      const parsed = parseDocument(html);
      v.roundTrip =
        renderDocument(parsed.model, parsed.assets, { runtime: parsed.runtime, theme: parsed.theme }) === html;
      v.hasSte = parsed.model.tabs.some((t) => t.kind === 'ste') && meta.tabs.some((t) => t.kind === 'ste');
    } catch {
      v.roundTrip = false;
    }
    const entry = lib.getEntry(x.slug);
    v.catalogStable =
      entry?.id === x.docId && entry.createdAt === x.createdAt && meta.id === x.docId && meta.createdAt === x.createdAt;
    const view = await lib.versions(x.slug);
    const node = view.tree.nodes.find((n) => n.id === view.tree.currentId);
    if (node) {
      v.versionId = node.id;
      v.parentVersionId = node.parentId;
      v.label = node.label;
      v.jobNode = !view.detached && node.jobId === x.jobId && meta.versionId === node.id;
      v.parentIsBase = node.parentId !== null && (x.baseVersionId === null || node.parentId === x.baseVersionId);
      if (node.parentId) {
        const parent = await lib.readVersion(x.slug, node.parentId).catch(() => undefined);
        v.parentHtmlMatches = parent !== undefined && sha256Hex(parent.html) === x.baseHtmlSha256;
      }
    }
  } catch (err) {
    log.warn('realrun.verify-failed', { slug: x.slug, errorKind: (err as Error | null)?.name ?? 'Error' });
  }
  v.ok = v.validity && v.roundTrip && v.hasSte && v.catalogStable && v.jobNode && v.parentIsBase && v.parentHtmlMatches;
  return v;
}

// ---- the run ----

export interface StartRebuildRunOptions {
  session: RealRunSession;
  jobs: RebuildQueue;
  library: RebuildLibrary;
  /** The active provider (registry.llm()): budget-guarded and priced, except in a rehearsal. */
  provider: () => LLMProvider;
  /** The prompt set in effect (PromptCatalogue.set after any fallback). */
  promptSet: string;
  /** The provider's API key is present (Keychain, read in-process; D23). Not asked in a rehearsal. */
  keyPresent: () => Promise<boolean>;
  planInputs: RebuildPlanInputs;
  /** Settings images.stockPhotos: the plan counts the photo-pick call. */
  stockPhotos: boolean;
  /** Extra wait for a timed-out job to stop after its cancel. Default 10 minutes. */
  cancelGraceMs?: number;
  /** Default verifyRebuild; injected in tests. */
  verify?: (lib: RebuildLibrary, x: VerifyExpect) => Promise<RebuildVerify>;
  write?: (text: string) => void;
  /** Required: ends the process after the summary (the bootstrap sets the exit code, then `app.quit`). */
  quit: (exitCode: number) => void;
}

/** One preflight row as printed: no source text, no clarifying input, only the source's file name. */
export interface RebuildPreflight {
  slug: string;
  /** The source's file name (the full path stays out of the summary). */
  file: string;
  ok: boolean;
  problem?: string;
  sha256?: string;
  shaMatches?: boolean;
  docId?: string;
  createdAt?: string;
  baseVersionId?: string | null;
  baseHtmlSha256?: string;
  sourceTokens?: number;
  glossary?: boolean;
}

/** What the run keeps per document but never prints (private text and local paths). */
interface PreflightInternal {
  row: RebuildPreflight;
  path: string;
  clarifyingInput: string;
}

export interface RebuildPlanRow {
  slug: string;
  sourceTokens: number;
  typicalUsd: number;
  worstUsd: number;
}

export interface RebuildDocRow {
  slug: string;
  ok: boolean;
  jobId?: string;
  status: JobStatus | 'rejected' | 'timeout';
  failureCode?: JobFailureCode;
  error?: string;
  versionId?: string;
  parentVersionId?: string | null;
  label?: string;
  /** Ledger growth while this document ran. */
  spentUsd: number;
  steLint?: RebuildReport['steLint'];
  eli5CritiqueAccepted?: boolean;
  warnings: { kind: string; message: string }[];
  verify?: RebuildVerify;
}

export interface RebuildRunSummary {
  ok: boolean;
  mode: 'dry' | 'rehearsal' | 'rebuild';
  provider: string;
  model: string;
  promptSet: string;
  budgetUsd: number;
  docGateUsd: number;
  hardStopUsd: number;
  ledgerPath: string;
  ledgerBeforeUsd: number;
  ledgerAfterUsd: number;
  /** Spent by this run (ledgerAfterUsd - ledgerBeforeUsd). */
  spentUsd: number;
  remainingUsd: number;
  stopped?: 'budget-gate' | 'hard-stop' | 'timeout';
  error?: string;
  preflight: RebuildPreflight[];
  plan: RebuildPlanRow[];
  planTotal: { typicalUsd: number; worstUsd: number };
  docs: RebuildDocRow[];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** An error for the printed summary: the errno code or class name, never a message carrying a path. */
const errKind = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'Error';
};
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i;

/** Read-only checks and the base capture for one document (design §5 preflight). */
async function preflightOne(
  lib: RebuildLibrary,
  entry: { slug: string; file: string },
  read: (p: string) => Promise<Buffer>,
): Promise<PreflightInternal> {
  const name = path.basename(entry.file);
  const row: RebuildPreflight = { slug: entry.slug, file: name, ok: false };
  const fail = (r: RebuildPreflight, problem: string, clarifyingInput = ''): PreflightInternal => ({
    row: { ...r, ok: false, problem },
    path: entry.file,
    clarifyingInput,
  });
  if (!lib.hasSlug(entry.slug)) return fail(row, 'the slug is not in the library');
  let meta: DocumentMeta;
  try {
    meta = await lib.getMeta(entry.slug);
  } catch (err) {
    return fail(row, `meta.json unreadable (${errKind(err)})`);
  }
  let source: Buffer;
  try {
    source = await read(entry.file);
  } catch (err) {
    return fail(row, `source unreadable (${errKind(err)})`);
  }
  const sha = sha256Hex(source);
  const used = meta.sourcesUsed.find((s) => s.ref === name);
  const shaMatches = used?.sha256 === sha;
  const view = await lib.versions(entry.slug);
  const html = await read(lib.docPath(entry.slug));
  const out: RebuildPreflight = {
    ...row,
    sha256: sha,
    shaMatches,
    docId: meta.id,
    createdAt: meta.createdAt,
    baseVersionId: view.tree.currentId,
    baseHtmlSha256: sha256Hex(html),
    // A rough bound: images go to vision at a flat rate; other files at their byte size as text.
    sourceTokens: IMAGE_EXT.test(name) ? IMAGE_TOKENS : estimateTextTokens(source.length),
    glossary: meta.glossaryEnabled,
  };
  const ci = meta.clarifyingInput;
  if (!used) return fail(out, `meta.sourcesUsed has no ${name}`, ci);
  if (!shaMatches) return fail(out, 'the source sha256 differs from meta.sourcesUsed', ci);
  // The rebuild reads only this file and records it as the only source: refuse to drop others.
  const others = meta.sourcesUsed.length - 1;
  if (others > 0) return fail(out, `the document has ${others} other source(s); a rebuild takes exactly one`, ci);
  if (view.readOnly) return fail(out, 'the version tree is read-only (written by a newer app)', ci);
  // The live index.html matches no version: the save's base check would always refuse it.
  if (view.detached) return fail(out, 'the live document matches no version (changed outside the app)', ci);
  return { row: { ...out, ok: true }, path: entry.file, clarifyingInput: ci };
}

/** Waits for a job to reach a terminal status, or for the timeout. */
function settle(jobs: RebuildQueue, id: string, timeoutMs: number): Promise<Job | 'timeout'> {
  return new Promise((resolve) => {
    let off: () => void = () => {};
    const timer = setTimeout(() => {
      off();
      resolve('timeout');
    }, timeoutMs);
    const check = (): boolean => {
      const j = jobs.get(id);
      if (!j || !isTerminal(j.status)) return false;
      clearTimeout(timer);
      off();
      resolve(j);
      return true;
    };
    off = jobs.on('changed', () => void check());
    check();
  });
}

export async function startRebuildRun(o: StartRebuildRunOptions): Promise<RebuildRunSummary> {
  const { config, ledger } = o.session;
  const rb = config.rebuild;
  const write = o.write ?? ((t: string) => void process.stdout.write(t));
  const p = o.provider();
  // DRY wins over a rehearsal: a dry run never starts a job, fake LLM or not.
  const mode: RebuildRunSummary['mode'] = rb?.dry ? 'dry' : rb?.rehearsal ? 'rehearsal' : 'rebuild';
  const before = ledger.spentUsd;
  const preflight: RebuildPreflight[] = [];
  const internal: PreflightInternal[] = [];
  const plan: RebuildPlanRow[] = [];
  const docs: RebuildDocRow[] = [];
  let stopped: RebuildRunSummary['stopped'];

  const finish = (error?: string): RebuildRunSummary => {
    const after = ledger.spentUsd;
    const summary: RebuildRunSummary = {
      ok:
        error === undefined &&
        stopped === undefined &&
        preflight.every((r) => r.ok) &&
        (mode === 'dry' || (docs.length === preflight.length && docs.every((d) => d.ok))),
      mode,
      provider: p.id,
      model: p.model,
      promptSet: o.promptSet,
      budgetUsd: config.budgetUsd,
      docGateUsd: rb?.docGateUsd ?? 0,
      hardStopUsd: REBUILD_HARD_STOP_USD,
      // The file name only: the summary carries no local paths.
      ledgerPath: path.basename(config.ledgerPath),
      ledgerBeforeUsd: before,
      ledgerAfterUsd: after,
      spentUsd: after - before,
      remainingUsd: ledger.remainingUsd,
      ...(stopped ? { stopped } : {}),
      ...(error !== undefined ? { error } : {}),
      preflight,
      plan,
      planTotal: {
        typicalUsd: plan.reduce((n, r) => n + r.typicalUsd, 0),
        worstUsd: plan.reduce((n, r) => n + r.worstUsd, 0),
      },
      docs,
    };
    ledger.release();
    write(JSON.stringify(summary, null, 2) + '\n');
    log.info('realrun.finished', { count: docs.length, kind: mode, status: summary.ok ? 'ok' : 'failed' });
    o.quit(summary.ok ? 0 : 1);
    return summary;
  };

  if (!rb) return finish('not a rebuild run');
  // 1. Money checks (none in a rehearsal: the fake costs nothing and is not guarded).
  const rates = ratesFor(p.model);
  if (!rb.rehearsal) {
    if (!(p instanceof BudgetGuardProvider)) return finish(`provider ${p.id} is not behind the budget guard`);
    if (!rates) return finish(`budget guard: unknown model ${p.model} has no price`);
  }
  if (rb.promptSet !== undefined && rb.promptSet !== o.promptSet) {
    return finish(`prompt set ${rb.promptSet} requested, but ${o.promptSet} is in effect`);
  }
  if (o.library.readOnly) return finish('the library is read-only (is the app running?)');
  if (!rb.rehearsal && !(await o.keyPresent().catch(() => false))) {
    return finish(`no API key for ${p.id} in the Keychain`);
  }

  // 2. Preflight every document before any call; abort on the first problem in any of them.
  const read = (f: string): Promise<Buffer> => readFile(f);
  for (const e of rb.entries) {
    const r = await preflightOne(o.library, e, read).catch((err: unknown): PreflightInternal => ({
      row: { slug: e.slug, file: path.basename(e.file), ok: false, problem: `preflight failed (${errKind(err)})` },
      path: e.file,
      clarifyingInput: '',
    }));
    internal.push(r);
    preflight.push(r.row);
  }
  for (const r of preflight) {
    if (!r.ok || rates === undefined) continue;
    const c = planRebuildCost({
      rates,
      sourceTokens: r.sourceTokens ?? 0,
      glossary: r.glossary ?? true,
      photos: o.stockPhotos,
      maxOutputTokens: (id) => o.planInputs.maxOutputTokens(id),
      overheadTokens: (id) => o.planInputs.overheadTokens(id),
    });
    plan.push({ slug: r.slug, sourceTokens: r.sourceTokens ?? 0, typicalUsd: c.typicalUsd, worstUsd: c.worstUsd });
  }
  const bad = preflight.filter((r) => !r.ok);
  if (bad.length)
    return finish(`preflight failed: ${bad.map((r) => `${r.slug}: ${r.problem ?? 'failed'}`).join('; ')}`);
  if (mode === 'dry') return finish();

  // 3. One document at a time.
  if (!rb.rehearsal && rates && ledger.remainingUsd < (MIN_OUTPUT_TOKENS * rates.outputPerMTok) / 1e6) {
    return finish('budget exhausted');
  }
  for (const [i, { row: r, path: file, clarifyingInput }] of internal.entries()) {
    if (!rb.rehearsal) {
      if (ledger.spentUsd >= REBUILD_HARD_STOP_USD) {
        stopped = 'hard-stop';
        break;
      }
      if (ledger.remainingUsd < rb.docGateUsd) {
        stopped = 'budget-gate';
        break;
      }
    }
    const target: RebuildTarget = {
      slug: r.slug,
      docId: r.docId ?? '',
      baseVersionId: r.baseVersionId ?? null,
      baseHtmlSha256: r.baseHtmlSha256 ?? '',
      promptSet: o.promptSet,
    };
    const docBefore = ledger.spentUsd;
    const row: RebuildDocRow = { slug: r.slug, ok: false, status: 'queued', spentUsd: 0, warnings: [] };
    let jobId: string;
    try {
      ({ jobId } = await o.jobs.startRebuild(
        {
          inputs: [{ id: `in-${(i + 1).toString(16).padStart(8, '0')}`, kind: 'file', origin: 'drop', path: file }],
          options: { clarifyingInput, glossary: r.glossary ?? true },
        },
        target,
      ));
    } catch (err) {
      docs.push({ ...row, status: 'rejected', error: errText(err) });
      continue;
    }
    log.info('realrun.rebuild-started', { slug: r.slug, jobId });
    const job = await settle(o.jobs, jobId, config.timeoutMs);
    if (job === 'timeout') {
      // Cancel, then wait (bounded) until the job has really stopped, so nothing of it overlaps
      // another document or moves the ledger after its row. Then stop the run: no further document.
      await o.jobs.cancel(jobId).catch(() => undefined);
      const after = await settle(o.jobs, jobId, o.cancelGraceMs ?? 10 * 60_000);
      docs.push({
        ...row,
        jobId,
        status: after === 'timeout' ? 'timeout' : after.status,
        ...(after !== 'timeout' && after.failure ? { failureCode: after.failure.code } : {}),
        error: 'timed out',
        spentUsd: ledger.spentUsd - docBefore,
      });
      stopped = 'timeout';
      break;
    }
    const report = job.rebuild?.report;
    const out: RebuildDocRow = {
      ...row,
      jobId,
      status: job.status,
      ...(job.failure ? { failureCode: job.failure.code } : {}),
      spentUsd: ledger.spentUsd - docBefore,
      ...(report ? { steLint: report.steLint, eli5CritiqueAccepted: report.eli5Critique === 'accepted' } : {}),
      warnings: job.warnings.map((w) => ({ kind: w.kind, message: w.message })),
    };
    if (job.status === 'done') {
      const verify = await (o.verify ?? verifyRebuild)(o.library, {
        slug: r.slug,
        jobId,
        docId: target.docId,
        createdAt: r.createdAt ?? '',
        baseVersionId: target.baseVersionId,
        baseHtmlSha256: target.baseHtmlSha256,
      });
      out.verify = verify;
      if (verify.versionId !== undefined) out.versionId = verify.versionId;
      if (verify.parentVersionId !== undefined) out.parentVersionId = verify.parentVersionId;
      if (verify.label !== undefined) out.label = verify.label;
      out.ok = verify.ok;
    }
    docs.push(out);
  }
  return finish();
}
