/**
 * The sync wire protocol (16 §4.2–§4.4, §5.1, §5.3): every JSON file the desktop and the phone
 * exchange through the remote store. Each schema is `.strict()`, so an unknown field is an error on
 * both sides; the Android twin is `android/app/src/main/kotlin/io/github/eli5learner/sync/protocol/Models.kt`.
 *
 * `scripts/export-sync-schema.ts` (`npm run gen:sync-schema`) writes these as JSON Schema to
 * `test/contracts/sync/`, and the golden fixtures in `test/contracts/sync/fixtures/` are read by
 * Vitest and by the Android unit tests: both must accept every `*.valid.*` fixture and reject every
 * `*.invalid.*` one (16 §12). The cross-field rules (`superRefine`) do not appear in the exported JSON
 * Schema; the fixtures cover them.
 *
 * Time-dependent checks (a job's `createdAt` window, rate limits), attachment sniffing and sha checks
 * are runtime rules of the inbox (16 §5.3), not part of the file shapes.
 *
 * This file is a leaf: it imports nothing from the app, so the patterns below repeat the library's
 * (09 §4.1, §5) and the resolvers' media types (03 §5.2); `test/unit/main/sync/protocol.test.ts`
 * checks that they stay equal.
 */
import { z } from 'zod';

// ------------------------------------------------------------------------------------- patterns

/** A device id: a UUIDv4 minted locally on first sync (16 §4.2), lowercase. */
export const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A job id: a UUIDv7 (16 §4.2), lowercase. */
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 09 §5.2 `DocumentMeta.id` (crypto.randomUUID, lowercase). */
export const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 09 §4.1 version node ids. */
export const VERSION_ID_RE = /^v-[0-9a-f]{12}$/;
/** 09 §4.2 folder ids. */
export const FOLDER_ID_RE = /^f-[0-9a-f]{8}$/;
/** 07 tab keys. */
export const TAB_KEY_RE = /^(indepth|eli5|sx[0-9a-f]{6})$/;
/** 07 section ids. */
export const SECTION_ID_RE = /^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/;
/** sha256 of the uncompressed bytes, lowercase hex. */
export const SHA256_RE = /^[0-9a-f]{64}$/;
/** A user-facing error code such as `E_RATE` (16 §10). */
export const ERROR_CODE_RE = /^E_[A-Z][A-Z0-9_]{0,39}$/;
/**
 * An attachment's display name: no path separators, no control characters, no bidi embedding,
 * override or isolate characters (they can disguise an extension), not `.` or `..`. The length cap
 * (1 to 200) is a separate check: zod counts string lengths in code points, and a regex quantifier
 * counts UTF-16 units in JavaScript but code points in Java.
 */
// eslint-disable-next-line no-control-regex -- control characters are what it rejects
export const ATTACHMENT_NAME_RE = /^(?!\.{1,2}$)[^\u002f\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/;
/** 08 Q&A ids (`QA_ID_RE` in src/main/document) or 07 section ids: where a finished job lands. */
export const ANCHOR_ID_RE = /^(?:q-[0-9a-f]{8}|sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8})$/;
/**
 * The ASCII shape of a job URL: an `http://` or `https://` prefix (any case) and printable ASCII
 * only, so no whitespace, control or non-ASCII characters that the WHATWG parser would silently
 * strip or re-encode. The phone percent-encodes and IDNA-encodes shared URLs before writing a job.
 */
export const HTTP_URL_RE = /^[hH][tT][tT][pP][sS]?:\/\/[\u0021-\u007e]+$/;
/**
 * Blank text: only the characters `String.prototype.trim` removes (ECMAScript WhiteSpace and
 * LineTerminator), spelled out so the phone applies the same set (Kotlin's `isBlank` differs).
 */
// eslint-disable-next-line no-control-regex -- the vertical tab is one of the characters trim removes
export const BLANK_RE = /^[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/;
/** One line of text (an Ask question). */
export const ONE_LINE_RE = /^[^\r\n\u2028\u2029]*$/;

/** The protocol version every file in this version carries (`v`). */
export const PROTOCOL_VERSION = 1;
/** `sync-info.json` `formatVersion` written by this version (16 §4.2). */
export const SYNC_FORMAT_VERSION = 1;

const MiB = 1024 * 1024;

/** Limits both sides enforce (16 §4.4, §5.1). String lengths are in Unicode code points, as zod counts them. */
export const LIMITS = Object.freeze({
  urls: 20,
  urlChars: 2048,
  attachmentNameChars: 200,
  textChars: 20_000,
  clarifyingInputChars: 500,
  attachments: 10,
  attachmentBytes: 20 * MiB,
  jobAttachmentBytes: 50 * MiB,
  questionMinChars: 3,
  questionMaxChars: 500,
  /** 09 caps: 300 version nodes per document. */
  treeNodes: 300,
  manifestDocs: 10_000,
  manifestFolders: 500,
  ackedJobs: 10_000,
});

/** The image, PDF, Office, HTML and plain-text types the desktop resolvers accept (03 §5.2). */
export const ATTACHMENT_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'text/markdown',
  'text/plain',
  'text/csv',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/tiff',
  'image/bmp',
] as const;

/** 09 §4.1 version change kinds (`VersionChangeKind` in the preload contract). */
export const VERSION_CHANGE_KINDS = [
  'expand',
  'reexplain',
  'analogy',
  'deeper',
  'revise',
  'eli5-tab',
  'eli5-selection',
  'ask',
  'close-tab',
  'merge',
  'outside',
  'initial',
  /** Reserved for a later desktop pull (16 §8); never written in this version. */
  'sync',
] as const;

export const JOB_KINDS = ['capture', 'checkout', 'ask'] as const;
export const FOCUS_CHIPS = ['big-picture', 'how-it-works', 'numbers', 'beginner'] as const;
export const JOB_STATES = ['received', 'queued', 'running', 'done', 'failed', 'rejected', 'cancelled'] as const;

// ------------------------------------------------------------------------------------ atoms

const Timestamp = z.iso.datetime();
const V = z.literal(PROTOCOL_VERSION);
const DeviceId = z.string().regex(DEVICE_ID_RE);
const JobId = z.string().regex(JOB_ID_RE);
const DocId = z.string().regex(DOC_ID_RE);
const VersionId = z.string().regex(VERSION_ID_RE);
const Sha256 = z.string().regex(SHA256_RE);
const Seq = z.number().int().min(1);
const Count = z.number().int().min(0);
/**
 * A job URL: the raw text must already be in the ASCII shape of [HTTP_URL_RE], then parse as an
 * absolute http(s) URL with a DNS-style host (zod's hostname pattern; no IP-literal brackets), a
 * valid port, and no user name or password (authenticated sources are out of scope, and credentials
 * would leak into logs). A refinement rather than `z.url()`, because `z.url()` returns the WHATWG
 * re-serialization, and the desktop must see exactly what the phone wrote.
 */
export function isJobUrl(u: string): boolean {
  if (u.length > LIMITS.urlChars || !HTTP_URL_RE.test(u)) return false;
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return false;
  }
  return (
    (p.protocol === 'http:' || p.protocol === 'https:') &&
    z.regexes.hostname.test(p.hostname) &&
    p.username === '' &&
    p.password === ''
  );
}
const HttpUrl = z
  .string()
  .max(LIMITS.urlChars)
  .regex(HTTP_URL_RE)
  .refine(isJobUrl, 'must be an http(s) URL with a host name and no credentials');

/** Duplicate values in `values` at their index, as issues on `path`. */
function unique(ctx: z.RefinementCtx, values: readonly string[], path: (string | number)[], what: string): void {
  const seen = new Set<string>();
  values.forEach((v, i) => {
    if (seen.has(v)) ctx.addIssue({ code: 'custom', message: `duplicate ${what}`, path: [...path, i] });
    seen.add(v);
  });
}

// ------------------------------------------------------------------------------ store files

/** `sync-info.json` (16 §4.2): written once by the first desktop. */
export const SyncInfoSchema = z
  .strictObject({
    formatVersion: z.number().int().min(1),
    minReaderVersion: z.number().int().min(1),
    minWriterVersion: z.number().int().min(1),
    createdAt: Timestamp,
  })
  .meta({ title: 'SyncInfo', description: 'sync-info.json (16 §4.2)' });

/** `claim-<ms>-<deviceId>.json` (16 §4.6): immutable; the newest claim names the primary. */
export const ClaimSchema = z
  .strictObject({ deviceId: DeviceId, claimedAt: Timestamp })
  .meta({ title: 'Claim', description: 'claim-<ms>-<deviceId>.json (16 §4.6)' });

/** `device-<deviceId>.json` (16 §4.3). The heartbeat (`seen`) lives in appProperties, not here. */
export const DeviceRecordSchema = z
  .strictObject({
    v: V,
    deviceId: DeviceId,
    platform: z.enum(['macos', 'android']),
    name: z.string().min(1).max(100),
    appVersion: z.string().min(1).max(40),
    role: z.enum(['primary', 'mirror', 'phone']),
    /** Desktop only: the job kinds it runs today. A phone writes []. */
    accepts: z.array(z.enum(JOB_KINDS)).max(JOB_KINDS.length),
    /** Desktop only. A phone writes 'off'. */
    inbox: z.enum(['on', 'off', 'paused-read-only']),
  })
  .superRefine((d, ctx) => {
    unique(ctx, d.accepts, ['accepts'], 'job kind');
    const phone = d.platform === 'android';
    if (phone !== (d.role === 'phone')) {
      ctx.addIssue({ code: 'custom', message: 'role phone goes with platform android only', path: ['role'] });
    }
    if (phone && (d.accepts.length > 0 || d.inbox !== 'off')) {
      ctx.addIssue({ code: 'custom', message: 'a phone accepts no jobs and has no inbox', path: ['accepts'] });
    }
  })
  .meta({ title: 'DeviceRecord', description: 'device-<deviceId>.json (16 §4.3)' });

const PlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('folder'), folderId: z.string().regex(FOLDER_ID_RE) }),
  z.strictObject({ kind: z.literal('unfiled') }),
  z.strictObject({ kind: z.literal('archive') }),
  z.strictObject({ kind: z.literal('trash') }),
]);

const ManifestDocSchema = z.strictObject({
  docId: DocId,
  title: z.string().min(1).max(200),
  summary: z.string().max(300),
  headings: z.array(z.string().max(200)).max(200),
  tabs: z.array(z.string().regex(TAB_KEY_RE)).min(1).max(20),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  placement: PlacementSchema,
  currentVersionId: VersionId,
  currentSha: Sha256,
  sizeBytes: Count,
  busy: z.boolean(),
  /** The old docId when an id was re-minted (09 §7 step 4, Put Back). */
  replaces: DocId.optional(),
});

/** `lib-<deviceId>.json` (16 §4.4): the sanitized library manifest, written by the primary only. */
export const LibraryManifestSchema = z
  .strictObject({
    v: V,
    seq: Seq,
    generatedAt: Timestamp,
    folders: z
      .array(z.strictObject({ id: z.string().regex(FOLDER_ID_RE), name: z.string().min(1).max(60) }))
      .max(LIMITS.manifestFolders),
    docs: z.array(ManifestDocSchema).max(LIMITS.manifestDocs),
  })
  .superRefine((m, ctx) => {
    unique(
      ctx,
      m.folders.map((f) => f.id),
      ['folders'],
      'folder id',
    );
    unique(
      ctx,
      m.docs.map((d) => d.docId),
      ['docs'],
      'docId',
    );
    const folders = new Set(m.folders.map((f) => f.id));
    m.docs.forEach((d, i) => {
      if (d.placement.kind === 'folder' && !folders.has(d.placement.folderId)) {
        ctx.addIssue({ code: 'custom', message: 'unknown folder', path: ['docs', i, 'placement', 'folderId'] });
      }
      if (d.replaces === d.docId) {
        ctx.addIssue({ code: 'custom', message: 'a document cannot replace itself', path: ['docs', i, 'replaces'] });
      }
    });
  })
  .meta({ title: 'LibraryManifest', description: 'lib-<deviceId>.json (16 §4.4)' });

const VersionNodeSchema = z.strictObject({
  id: VersionId,
  parentId: VersionId.nullable(),
  kind: z.enum(VERSION_CHANGE_KINDS),
  label: z.string().min(1).max(200),
  createdAt: Timestamp,
  /** Null when the snapshot was pruned on the desktop. */
  sha: Sha256.nullable(),
  /** True when `blob-<sha>.html.gz` is in the store. */
  uploaded: z.boolean(),
});

/** `tree-<docId>.json` (16 §4.4): one document's sanitized version tree, written by the primary only. */
export const VersionTreeSchema = z
  .strictObject({
    v: V,
    docId: DocId,
    seq: Seq,
    currentId: VersionId,
    nodes: z.array(VersionNodeSchema).min(1).max(LIMITS.treeNodes),
  })
  .superRefine((t, ctx) => {
    unique(
      ctx,
      t.nodes.map((n) => n.id),
      ['nodes'],
      'version id',
    );
    if (!t.nodes.some((n) => n.id === t.currentId)) {
      ctx.addIssue({ code: 'custom', message: 'currentId is not a node', path: ['currentId'] });
    }
    t.nodes.forEach((n, i) => {
      if (n.uploaded && n.sha === null) {
        ctx.addIssue({ code: 'custom', message: 'an uploaded node needs a sha', path: ['nodes', i, 'uploaded'] });
      }
    });
  })
  .meta({ title: 'VersionTree', description: 'tree-<docId>.json (16 §4.4)' });

// ------------------------------------------------------------------------------------- jobs

const AttachmentSchema = z.strictObject({
  sha: Sha256,
  name: z.string().min(1).max(LIMITS.attachmentNameChars).regex(ATTACHMENT_NAME_RE),
  mime: z.enum(ATTACHMENT_MIME_TYPES),
  size: z.number().int().min(1).max(LIMITS.attachmentBytes),
});

const jobBase = { v: V, jobId: JobId, deviceId: DeviceId, createdAt: Timestamp };

/** `job-<jobId>.json` (16 §5.1): immutable, written by the phone; untrusted on the desktop. */
export const JobRequestSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...jobBase,
      kind: z.literal('capture'),
      urls: z.array(HttpUrl).max(LIMITS.urls),
      text: z.string().max(LIMITS.textChars),
      clarifyingInput: z.string().max(LIMITS.clarifyingInputChars),
      focus: z.array(z.enum(FOCUS_CHIPS)).max(FOCUS_CHIPS.length),
      attachments: z.array(AttachmentSchema).max(LIMITS.attachments),
    }),
    z.strictObject({ ...jobBase, kind: z.literal('checkout'), docId: DocId, versionId: VersionId }),
    z.strictObject({
      ...jobBase,
      kind: z.literal('ask'),
      docId: DocId,
      sectionId: z.string().regex(SECTION_ID_RE),
      sectionHash: Sha256,
      question: z.string().min(LIMITS.questionMinChars).max(LIMITS.questionMaxChars).regex(ONE_LINE_RE),
    }),
  ])
  .superRefine((j, ctx) => {
    if (j.kind !== 'capture') return;
    unique(ctx, j.focus, ['focus'], 'focus chip');
    unique(
      ctx,
      j.attachments.map((a) => a.sha),
      ['attachments'],
      'attachment',
    );
    if (j.attachments.reduce((s, a) => s + a.size, 0) > LIMITS.jobAttachmentBytes) {
      ctx.addIssue({ code: 'custom', message: 'attachments exceed 50 MiB per job', path: ['attachments'] });
    }
    if (j.urls.length === 0 && BLANK_RE.test(j.text) && j.attachments.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'a capture needs a URL, text or an attachment', path: ['urls'] });
    }
  })
  .meta({ title: 'JobRequest', description: 'job-<jobId>.json (16 §5.1)' });

/** `jobcancel-<jobId>.json` (16 §4.2, §5.2): immutable, written by the phone. */
export const JobCancelSchema = z
  .strictObject({ jobId: JobId, at: Timestamp })
  .meta({ title: 'JobCancel', description: 'jobcancel-<jobId>.json (16 §4.2)' });

/** `jobstatus-<jobId>.json` (16 §5.3): rewritten by the primary. */
export const JobStatusSchema = z
  .strictObject({
    v: V,
    jobId: JobId,
    updatedAt: Timestamp,
    state: z.enum(JOB_STATES),
    /** The 06 §6 one-line status. */
    stage: z.string().max(200).regex(ONE_LINE_RE).optional(),
    docId: DocId.optional(),
    versionId: VersionId.optional(),
    skippedSources: Count.optional(),
    /** Where to open the document: a Q&A or section id, never free text (the phone puts it in a URL fragment). */
    anchorId: z.string().regex(ANCHOR_ID_RE).optional(),
    code: z.string().regex(ERROR_CODE_RE).optional(),
    /** The user-facing one-liner. */
    reason: z.string().max(300).regex(ONE_LINE_RE).optional(),
  })
  .superRefine((s, ctx) => {
    const failed = s.state === 'failed' || s.state === 'rejected';
    if (failed && (s.code === undefined || s.reason === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'failed and rejected need a code and a reason', path: ['code'] });
    }
    if (!failed && s.code !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'only failed and rejected carry a code', path: ['code'] });
    }
    if (s.state === 'done' && s.docId === undefined) {
      ctx.addIssue({ code: 'custom', message: 'done needs a docId', path: ['docId'] });
    }
  })
  .meta({ title: 'JobStatus', description: 'jobstatus-<jobId>.json (16 §5.3)' });

/** `acks-<deviceId>.json` (16 §4.7): terminal job ids the phone has shown, rewritten by that phone. */
export const AcksSchema = z
  .strictObject({ terminalJobIds: z.array(JobId).max(LIMITS.ackedJobs) })
  .superRefine((a, ctx) => unique(ctx, a.terminalJobIds, ['terminalJobIds'], 'jobId'))
  .meta({ title: 'Acks', description: 'acks-<deviceId>.json (16 §4.7)' });

// ------------------------------------------------------------------------------------ types

export type SyncInfo = z.infer<typeof SyncInfoSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;
export type LibraryManifest = z.infer<typeof LibraryManifestSchema>;
export type ManifestDoc = LibraryManifest['docs'][number];
export type VersionTree = z.infer<typeof VersionTreeSchema>;
export type RemoteVersionNode = VersionTree['nodes'][number];
export type JobRequest = z.infer<typeof JobRequestSchema>;
export type JobKind = (typeof JOB_KINDS)[number];
export type FocusChip = (typeof FOCUS_CHIPS)[number];
export type JobCancel = z.infer<typeof JobCancelSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobState = (typeof JOB_STATES)[number];
export type Acks = z.infer<typeof AcksSchema>;

/**
 * Every protocol file type by its fixture prefix (`<type>.valid.<name>.json`). The order is the
 * order of the exported `*.schema.json` files.
 */
export const SYNC_SCHEMAS = Object.freeze({
  'sync-info': SyncInfoSchema,
  claim: ClaimSchema,
  device: DeviceRecordSchema,
  manifest: LibraryManifestSchema,
  tree: VersionTreeSchema,
  job: JobRequestSchema,
  jobcancel: JobCancelSchema,
  jobstatus: JobStatusSchema,
  acks: AcksSchema,
});

export type SyncFileType = keyof typeof SYNC_SCHEMAS;
