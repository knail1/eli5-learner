import path from 'node:path';
import { z } from 'zod';
import { isValidSlug } from '../library';
import { DRAFT_ID_RE } from '../sources';

/** Renderer payload schemas for the M2 channels (01 §5.1). Unknown keys are stripped. */

/** 03 §13: draft and input ids. */
export const DraftId = z.string().regex(DRAFT_ID_RE);
const InputId = DraftId;
const PathString = z.string().min(1).max(4096);
const AbsolutePath = PathString.refine((p) => path.isAbsolute(p), 'Must be an absolute path');
const Origin = z.enum(['drop', 'paste', 'url-field', 'picker']);
const Preview = z.string().max(500);

/** Upper bounds that no real draft reaches; they only cap payload size. */
export const MAX_INPUTS = 200;
export const MAX_CLARIFYING_CHARS = 10_000;
export const MAX_STAGE_TEXT_CHARS = 5_000_000;

/**
 * SourceInput from the renderer (03 §2). `snapshot` is omitted on purpose: main computes it at
 * enqueue (06 §9.2), so a renderer-supplied `copyPath` never reaches a resolver.
 */
export const SourceInputSchema = z.discriminatedUnion('kind', [
  z.object({ id: InputId, kind: z.literal('file'), origin: Origin, path: PathString }),
  z.object({ id: InputId, kind: z.literal('url'), origin: Origin, url: z.string().min(1).max(8192) }),
  z.object({
    id: InputId,
    kind: z.literal('text'),
    origin: z.literal('paste'),
    stagedPath: PathString,
    markup: z.enum(['plain', 'html']),
    preview: Preview,
  }),
  z.object({
    id: InputId,
    kind: z.literal('image'),
    origin: z.literal('paste'),
    stagedPath: PathString,
    mediaType: z.literal('image/png'),
    preview: Preview,
  }),
]);

/** `eli5:jobs:start` (06 §11). Zero inputs pass here and are refused with 06 §5.1's message. */
export const StartJobRequestSchema = z.object({
  inputs: z.array(SourceInputSchema).max(MAX_INPUTS),
  options: z.object({
    clarifyingInput: z.string().max(MAX_CLARIFYING_CHARS),
    glossary: z.boolean(),
  }),
  draftId: DraftId.optional(),
});

/** Job ids are ULIDs; anything path-like is refused. */
export const JobIdPayload = z.object({ jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** 09 §6 slug pattern; resolved by main through the catalog, never as a path. */
export const SlugPayload = z.object({ slug: z.string().max(200).refine(isValidSlug, 'Invalid slug') });

/** 03 §13 sources channels. */
export const DraftPayload = z.object({ draftId: DraftId });
export const StageTextPayload = z.object({
  draftId: DraftId,
  text: z.string().max(MAX_STAGE_TEXT_CHARS),
  markup: z.enum(['plain', 'html']),
});
export const DiscardPayload = z.object({ draftId: DraftId, inputId: InputId });
export const RegisterDropPayload = z.object({ paths: z.array(AbsolutePath).min(1).max(1000) });

/** 11 §5.3 find bar: longer queries are refused rather than truncated. */
export const MAX_FIND_TEXT_CHARS = 200;

/** `eli5:viewer:find`. */
export const FindRequestSchema = z.object({
  text: z.string().min(1).max(MAX_FIND_TEXT_CHARS),
  forward: z.boolean().optional(),
  again: z.boolean().optional(),
});
