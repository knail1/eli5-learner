# LLM provider

This file specifies the intelligence layer in `src/main/llm/`. It covers the `LLMProvider` interface and its request and result types, the Claude and OpenAI implementations (SDKs, image input, token limits, retries, timeouts, rate limits), the documented Bedrock stub, how long inputs are fitted into the context window, the structured JSON contract the model returns (a `DocumentDraft` that the document builder turns into a `DocumentModel`, never raw HTML), the prompt catalogue in `resources/prompts/*.md`, and where the user-supplied HTML skills plug in. It implements PRD sections "Build editions and swap seams" (LLM row, `LLMProvider` seam), "Output document" (skills, glossary, tabs), "Interactive reading" (section actions), "Library, storage, and merge suggestions" (summary and merge match), and "Configuration" (`llm.provider`, model name, keychain key).

Related: [01-architecture.md](01-architecture.md) · [03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) · [05-url-fetching.md](05-url-fetching.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [07-output-document.md](07-output-document.md) · [08-interactive-reading.md](08-interactive-reading.md) · [09-library-storage.md](09-library-storage.md) · [10-publishing.md](10-publishing.md) · [11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Responsibilities and boundaries

| In scope (this module) | Out of scope (owner) |
| --- | --- |
| Talking to model APIs, retries, timeouts, rate limiting | Job queue and status lines ([06](06-generation-pipeline.md)) |
| Prompt loading, templating, skill injection | Turning `DocumentDraft` into HTML, assigning `SectionId`s ([07](07-output-document.md)) |
| Context budgeting and chunk-then-synthesize | Extracting files into `ExtractedContent` ([04](04-extraction.md)) |
| Validating model JSON against schemas, repair pass | Writing `index.html`, `meta.json`, `catalog.json` ([09](09-library-storage.md)) |
| Provider factory and Bedrock stub | Keychain access primitives and settings schema ([12](12-configuration-security.md)) |

The module runs only in the Electron main process. The renderer never sees API keys, prompts, or raw model output. No module outside `src/main/llm/` imports a vendor SDK.

## 2. File layout

```
src/main/llm/
  provider.ts          LLMProvider interface, GenerationRequest/Result, LLMError
  factory.ts           createProvider(settings) -> LLMProvider (consults editions registry)
  claude.ts            ClaudeProvider (@anthropic-ai/sdk)
  openai.ts            OpenAIProvider (openai)
  bedrock.stub.ts      BedrockProvider stub, throws NotAvailableInEdition
  models.ts            DEFAULT_MODELS, per-model limits table
  budget.ts            token estimation, context budgeting, chunk planner
  retry.ts             backoff policy, error classification
  limiter.ts           per-provider concurrency + token-bucket limiter
  structured.ts        schema-constrained calls, validation, repair pass
  schemas/draft.ts     zod schemas for DocumentDraft and friends (+ JSON Schema export)
  prompts/             prompt catalogue (*.md), see section 9
  prompts.ts           loader, front-matter parser, {{var}} renderer
  skills.ts            HTML skill discovery and injection
  net.ts               llmFetch: Electron net.fetch on the 'eli5-llm' session (section 7.4)
  tasks.ts             task functions: prepareContent, generateIndepth, generateEli5, generateGlossary,
                       summarize, runSectionAction, matchMerge
```

`tasks.ts` is the only surface other main-process modules call. The pipeline ([06](06-generation-pipeline.md)) calls `prepareContent`, then `generateIndepth`, `generateEli5`, `generateGlossary`, and `summarize` in that order, checkpointing between steps; the library ([09](09-library-storage.md)) calls `matchMerge`; interactive reading ([08](08-interactive-reading.md)) calls `runSectionAction`.

## 3. Core types

```ts
// src/main/llm/provider.ts
export type ProviderId = 'claude' | 'openai' | 'bedrock';

export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: Buffer;              // raw bytes; providers encode as needed
  label: string;             // e.g. "screenshot-1.png" or "deck.pdf p.4"; used in prompts and references
  sourceRef: string;         // ResolvedSource.ref this image came from
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: ImageInput[];     // only on role 'user'
}

export interface GenerationRequest {
  taskId: PromptId;          // which catalogue prompt produced this request (logging, metrics)
  system: string;            // fully rendered system prompt (skills already injected)
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;      // hint only: 0.4 writing, 0 classification; sent ONLY if limits.supportsTemperature
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; // reasoning effort; sent only if limits.supportsEffort
  jsonSchema?: {             // when present, output MUST be JSON matching this schema
    name: string;            // e.g. "document_draft"
    schema: object;          // JSON Schema draft 2020-12, generated from zod
  };
  cacheSystemPrompt?: boolean; // hint: system prompt is reused across calls in one job
  signal?: AbortSignal;      // job cancellation
  timeoutMs?: number;        // overrides llm.timeoutMs for this call
}

export interface TokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number }

export interface GenerationResult {
  text: string;              // raw text; for jsonSchema requests, the JSON string
  json?: unknown;            // parsed JSON when jsonSchema was set (not yet validated by zod)
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  usage: TokenUsage;
  model: string;             // model ID actually used, as reported by the API
  provider: ProviderId;
  latencyMs: number;
  attempts: number;          // 1 + retries performed
}

export type StreamChunk = { type: 'text'; delta: string } | { type: 'done'; result: GenerationResult };

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly limits: ModelLimits;
  generate(req: GenerationRequest): Promise<GenerationResult>;
  generateWithImages(req: GenerationRequest): Promise<GenerationResult>;
  stream?(req: GenerationRequest): AsyncIterable<StreamChunk>;
  countTokens?(req: Pick<GenerationRequest, 'system' | 'messages'>): Promise<number>;
  testConnection(): Promise<{ ok: true; model: string } | { ok: false; error: LLMError }>;
}

export interface ModelLimits {
  contextTokens: number;       // total window
  maxOutputTokens: number;     // hard cap per response
  supportsImages: boolean;
  maxImagesPerRequest: number;
  maxImageBytes: number;       // per image after re-encoding
  supportsTemperature: boolean; // false for models that reject sampling params (400); unknown models: false
  supportsEffort: boolean;      // Claude output_config.effort / OpenAI reasoning_effort
  thinkingReserveTokens: number;// output tokens reserved for reasoning/thinking inside maxOutputTokens (0 if none)
  systemRole: 'system' | 'developer'; // OpenAI only; Claude always uses the top-level `system` field
  structuredMode: 'output_config' | 'strict_tool_auto' | 'forced_tool' | 'json_schema_strict';
                               // how jsonSchema is enforced (sections 5, 6); unknown Claude models: 'output_config'
}
```

`generate` rejects requests that contain images (`LLMError{kind:'bad_request'}`) so callers state intent; `generateWithImages` accepts both. Both share one internal `send()` per provider. `stream` is optional (PRD seam requirement) and is used only for the in-app "generating" progress indicator in future work; v1 callers do not depend on it.

### 3.1 Errors

```ts
export type LLMErrorKind =
  | 'auth'            // 401/403, missing or invalid key: not retried
  | 'bad_request'     // 400, schema rejected, too many images: not retried
  | 'context_overflow'// input exceeds window: not retried, caller re-budgets
  | 'rate_limited'    // 429: retried with backoff, honors retry-after
  | 'overloaded'      // 529 / 503: retried
  | 'server'          // 500/502/504: retried
  | 'timeout'         // client-side timeout: retried (section 7.1)
  | 'network'         // DNS, TLS, reset: retried
  | 'refusal'         // model declined: not retried
  | 'invalid_output'  // JSON failed validation after repair: not retried
  | 'cancelled'       // AbortSignal fired
  | 'not_available';  // NotAvailableInEdition (stub provider)

export class LLMError extends Error {
  constructor(public kind: LLMErrorKind, message: string,
              public status?: number, public retryAfterMs?: number, public cause?: unknown) { super(message); }
  get retryable(): boolean { return ['rate_limited','overloaded','server','timeout','network'].includes(this.kind); }
}
```

The pipeline maps `auth`, `not_available`, and exhausted retryable errors to "LLM unavailable", which is a total failure per the PRD. Messages shown to the user are short and human readable ("Claude API key rejected. Check Settings."), and never contain the key or source text.

## 4. Provider factory and editions

```ts
// src/main/llm/factory.ts
export function createProvider(s: Settings, keys: KeyStore): LLMProvider
```

1. Read `llm.provider` (default `'claude'`) and resolve the model with `effectiveModel(s)` ([12](12-configuration-security.md) §3.2): `llm.model` is `string | null`, and `null` means `DEFAULT_MODELS[provider]`.
2. Other modules obtain the active provider through `registry.llm()` in `src/main/editions/registry.ts` ([01](01-architecture.md)), which calls the factory registered for `llm.provider`. At bootstrap the public build calls `registry.registerLLMProvider('claude', …)`, `registry.registerLLMProvider('openai', …)`, and `registry.registerLLMProvider('bedrock', …)` (the stub); `createProvider` is the factory body for `claude` and `openai`. An enterprise overlay may replace `bedrock` (HOOK-LLM-01) and may register additional IDs; see HOOK-CFG-02 for overlay loading.
3. For `claude` and `openai`, read the API key from the Keychain (service `ELI5 Learner`, accounts `llm.claude.apiKey` and `llm.openai.apiKey`, per [12](12-configuration-security.md)). A missing key throws `LLMError('auth', 'No API key set')` at call time, not at app start, so the app still opens.
4. Wrap the provider in the shared limiter (section 7) and cache it. Any settings change to `llm.*` or a key update invalidates the cache; in-flight calls finish on the old instance.

## 5. Claude implementation (`claude.ts`)

| Concern | Decision |
| --- | --- |
| SDK | `@anthropic-ai/sdk`, Messages API. SDK built-in retries disabled (`maxRetries: 0`); section 7 owns retries. The client is constructed with `fetch: llmFetch` (section 7.4), never Node's default fetch. |
| Model | `llm.model`, default `DEFAULT_MODELS.claude` in `models.ts`. Defaults are pinned per app release, not hard-coded at call sites. Unknown model IDs are allowed; limits fall back to a conservative row (200k context, 8k output). |
| System prompt | Sent as the `system` field. When `cacheSystemPrompt` is set, the system block carries `cache_control: {type:'ephemeral'}` so the skills text (large, stable) is cached across chunk calls in one job. |
| Images | Content blocks `{type:'image', source:{type:'base64', media_type, data}}` placed before the text block of the same message, each preceded by a short text label (`[Image: <label>]`) so the model can cite it. |
| Structured output | Selected per model by `limits.structuredMode`. **Default `output_config`:** the request sets `output_config: {format: {type:'json_schema', schema}}` (the deprecated `output_format` parameter is never used); `json` is `JSON.parse` of the concatenated text blocks (thinking blocks ignored). **`strict_tool_auto`:** one tool named `jsonSchema.name` with `input_schema = schema`, `strict: true`, `tool_choice: {type:'auto'}`, and a system instruction to answer only by calling it; the tool input is `json`. **`forced_tool`:** legacy models only, `tool_choice: {type:'tool', name}`. Current models reject forced `tool_choice` (`tool`/`any`) with a 400, and forcing a tool conflicts with thinking, so `forced_tool` is never the default. If a call in `forced_tool` mode gets that 400, it is classified `bad_request`, the provider switches that model to `output_config` for the rest of the session, and resends once (not counted as a retry). |
| Temperature | Sent only when `limits.supportsTemperature`. Current Claude models (and the unknown-model fallback row) reject `temperature`/`top_p`/`top_k` with a 400, so the parameter is dropped silently. |
| Thinking and effort | Thinking is left at the model default (adaptive where supported); the app never sends a disabled-thinking config. `output_config.effort` is set explicitly per task from the prompt front matter when `limits.supportsEffort` (defaults: `in-depth`/`eli5` `high`, `chunk-notes`/`glossary`/section actions `medium`, `summary`/`merge-match` `low`). |
| Max tokens | `min(req.maxOutputTokens, limits.maxOutputTokens)`. Thinking tokens count against it; budgeting reserves `limits.thinkingReserveTokens` inside it (section 8.2). |
| Transport | Every call streams internally: `client.messages.stream(params).finalMessage()`. `generate()` still returns one `GenerationResult`; streaming removes the whole-response HTTP timeout that large `max_tokens` values hit. |
| Stop reasons | `end_turn`/`tool_use` → `end`; `max_tokens` → `max_tokens`; `refusal` → `refusal`. |
| Streaming (public `stream()`) | Same stream; emits `text` deltas; for tool-mode calls, accumulates `input_json_delta` and emits only `done`. |
| Token counting | `messages.countTokens` when available; else the heuristic in section 8.1. |

## 6. OpenAI implementation (`openai.ts`)

| Concern | Decision |
| --- | --- |
| SDK | `openai` official SDK, `maxRetries: 0`, constructed with `fetch: llmFetch` (section 7.4). Chat Completions API (widest model coverage); the call site is isolated so switching to the Responses API is a local change. |
| Model | `llm.model`, default `DEFAULT_MODELS.openai`. Same fallback limits rule as Claude. |
| System prompt | First message with role `limits.systemRole` (`system`, or `developer` for reasoning models). Unknown models default to `developer` when the ID matches a reasoning-model prefix listed in `models.ts`, else `system`. |
| Temperature | Sent only when `limits.supportsTemperature`. Reasoning models (o-series, gpt-5 family) reject non-default values, so their rows set it false; so does the unknown-model fallback row. |
| Effort | `reasoning_effort` when `limits.supportsEffort`, mapped from the task's effort (`xhigh`/`max` → `high`). |
| Images | Content parts `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>', detail:'high'}}`, each preceded by a text label part. |
| Structured output | `response_format: {type:'json_schema', json_schema:{name, schema, strict:true}}`. Strict mode requires every property listed in `required` and `additionalProperties:false`; the zod-to-JSON-Schema export (section 10) emits that form, with optional fields expressed as nullable. `json` is `JSON.parse(message.content)`. A `refusal` field maps to `stopReason:'refusal'`. |
| Max tokens | `max_completion_tokens` (includes reasoning tokens; see section 8.2). |
| Transport | Every call uses `stream: true` with `stream_options: {include_usage: true}` and accumulates deltas into one `GenerationResult`. |
| Stop reasons | `stop` → `end`; `length` → `max_tokens`; `content_filter` → `refusal`. |
| Streaming (public `stream()`) | Same stream; text deltas as above. |
| Token counting | No API call; heuristic in section 8.1. |

## 7. Retries, timeouts, rate limits

### 7.1 Retry policy (`retry.ts`)

1. Classify each failure into an `LLMErrorKind` from HTTP status, SDK error class, and network error codes.
2. If not `retryable`, throw immediately.
3. Otherwise wait `delay = backoffMs[retry-1] * jitter`, with default `backoffMs = [2000, 8000, 30000]` and `jitter ∈ [0.8, 1.2]` (uniform, ±20%). If the response carries `retry-after` (seconds or HTTP date) or `retry-after-ms`, use `max(delay, retryAfter)`, capped at `maxRetryAfterMs` (default 120 s). A `retry-after` above the cap ends retrying with the classified error.
4. Max retries: 3 (4 attempts) for every retryable kind, including `timeout`.
5. Abort immediately with `cancelled` if the job's `AbortSignal` fires during a wait.
6. Record `attempts` on the result. Retries are silent apart from the ` (retrying)` suffix that [06](06-generation-pipeline.md) §6 appends to the status line while a wait is in progress; `retry.ts` reports waits through an `onRetry` callback for that purpose.

`retry.ts` is the single retry policy for all LLM calls; [06](06-generation-pipeline.md) does not wrap LLM calls in its own retry loop (its output-validation retry is the repair call in section 10.1). The numbers above are defaults read from the active `PipelinePolicy` (`llmRetryOverride.maxAttempts` per error kind, `llmRetryOverride.baseMs`, which scales the default backoff schedule, and `llmRetryOverride.maxRetryAfterMs`; see the `PipelinePolicy` type under HOOK-PIPE-01 in 06 §9.5); an enterprise `PipelinePolicy` (HOOK-PIPE-01) may override only these numbers, not the classification or the algorithm.

### 7.2 Timeouts

| Setting | Default | Notes |
| --- | --- | --- |
| Idle timeout | 120000 (`PipelinePolicy.llmTimeoutOverride.idleMs`) | Every call streams (sections 5, 6); no bytes, including thinking or keep-alive events, for 2 min → `timeout`. This is the primary liveness check. |
| `llm.timeoutMs` (total cap) | 1800000 (30 min) (`PipelinePolicy.llmTimeoutOverride.totalMs`) | Per attempt, generous backstop only. A 32k-token draft plus thinking at typical output rates approaches 10 min, so a 10-min whole-response limit would kill healthy calls. |
| `testConnection` | 20000 | Tiny request, `maxOutputTokens: 16`. |

### 7.3 Rate limiting (`limiter.ts`)

- One limiter per provider instance, shared across all jobs (PRD allows queued concurrent jobs).
- Concurrency cap `llm.maxConcurrency` (default 2). Chunk calls from one job and calls from other jobs share the cap; FIFO order, except section actions from the viewer get priority because the user is waiting on them.
- On a `rate_limited` response, the limiter pauses all new dispatches for that provider until `retryAfter` elapses, so parallel chunks do not stampede.
- Provider response headers with remaining-token counts, when present, are logged at debug level only; v1 does not do predictive throttling.

### 7.4 Network path (`net.ts`)

The vendor SDKs default to Node's undici fetch, which ignores the macOS system proxy (PAC/WPAD) and the Keychain CA trust store. On a network with a proxy or TLS inspection, LLM calls would fail with `network` errors while page fetching ([05](05-url-fetching.md)) works.

1. At startup, main creates `session.fromPartition('eli5-llm')` and runs `configureSession(ses)` from [05](05-url-fetching.md) on it (system proxy in the public build).
2. `llmFetch = ses.fetch.bind(ses)` (Chromium network stack: system proxy, PAC, Keychain trust) is passed as the `fetch` option of both the `@anthropic-ai/sdk` and `openai` clients.
3. HOOK-FETCH-01 network configuration (proxy, trust, client certificates) therefore also applies to LLM traffic; the enterprise overlay's `configureSession` replacement covers both lanes without changes here.
4. Streaming responses must work through `llmFetch` (Electron returns a web `ReadableStream` body); a contract test covers this.
5. Tests inject `cassetteFetch` in place of `llmFetch` (section 16).

## 8. Long-input strategy

### 8.1 Token estimation

`estimateTokens(text) = ceil(chars / 3.5)` for Latin text, `ceil(chars / 1.5)` when more than 30% of characters are CJK. Images cost `ceil(w*h / 750)` tokens after resizing, capped at 1600 per image. If the provider has `countTokens`, the planner uses it once for the final single-call check. Estimates are deliberately pessimistic.

### 8.2 Budget

```
inputBudget = floor(limits.contextTokens * 0.80)
            - tokens(system prompt incl. skills)
            - reservedOutput           // = min(llm.maxOutputTokens, limits.maxOutputTokens)
            - 2000                     // clarifying input, source list, framing
```

`reservedOutput` already includes thinking: `max_tokens` (Claude) and `max_completion_tokens` (OpenAI) count reasoning tokens. The visible-output budget a prompt may target is `reservedOutput - limits.thinkingReserveTokens`, and prompts state section-count limits against that figure so thinking does not push a draft into `max_tokens`.

### 8.3 Image handling

1. Images arrive from extraction ([04](04-extraction.md)) as `ContentBlock`s of kind image (screenshots, clipboard images, scanned PDF pages).
2. Re-encode images larger than `limits.maxImageBytes` or longer than 1568 px on the long edge to JPEG, quality 85, via Electron `nativeImage` (no extra native dependency).
3. If a request would exceed `limits.maxImagesPerRequest`, split images across chunk calls (section 8.4). Images are never silently dropped; an image that cannot be sent becomes a `SkippedSource` with reason "image too large for model".
4. If `limits.supportsImages` is false for the configured model, image-only sources are skipped with reason "selected model does not accept images".

### 8.4 Chunk-then-synthesize

Used when `estimate(allContent) > inputBudget`.

1. **Order** the `ExtractedContent` list as the user supplied it; within each, keep block order (slides, pages, headings).
2. **Split** into chunks at natural boundaries: source boundary, then slide/page/heading boundary, then paragraph. A chunk targets `0.6 * inputBudget` so notes fit alongside. A single block larger than a chunk is split at sentence boundaries with 200 tokens of overlap.
3. **Map:** for each chunk, call prompt `chunk-notes` (JSON schema `ChunkNotes`): dense factual notes, key numbers and tables preserved verbatim, candidate chart data, jargon candidates, and a list of `sourceRef`s covered. Calls run through the limiter in parallel.
4. **Reduce:** if the concatenated notes still exceed `inputBudget`, group notes and call `chunk-notes` again on the notes (at most 2 reduce levels; beyond that, truncate the lowest-priority chunks, those from later sources, and record a warning in `meta.json`).
5. **Hand off:** return the notes as `PreparedContent` (section 12). `generateIndepth` and `generateEli5` then use the notes in place of raw content. The system prompt tells the model it is reading notes, so it must not invent detail that the notes lack.
6. The in-depth and ELI5 calls always run as two separate requests (section 9), so each has its full output budget.

A single-chunk job skips steps 3 and 4; `PreparedContent` then carries the raw content.

### 8.5 Output overflow

If an in-depth call returns `stopReason: 'max_tokens'`, the module retries once with the prompt addendum "Produce at most N sections, prioritize the most important material", where N is 70% of the section count in the truncated partial (or 6 if unparseable). A second overflow is treated as `invalid_output`.

## 9. Prompt catalogue

Prompts are Markdown files with YAML front matter, loaded once at startup from `resources/prompts/` (01 §8.3; shipped as an extra resource in the packaged app). They are data, not code, so wording changes do not touch TypeScript.

```md
---
id: in-depth
version: 3
output: DocumentDraftTab        # schema name from schemas/draft.ts, or "text"
temperature: 0.4                # hint; dropped unless limits.supportsTemperature
effort: high                    # sent only if limits.supportsEffort
maxOutputTokens: 32000
skills: [beautiful-doc, eli5]   # which skill slots to inject (section 11)
---
# System
...instructions...{{glossaryInstructions}}...
# User
Clarifying input from the reader: {{clarifyingInput | "none"}}
Sources:
{{sourceList}}
{{content}}
```

`{{var}}` substitution only, with an optional `| "default"`. No logic, no includes. Unknown variables fail the prompt load at startup (unit test enforced). `# System` and `# User` split the file into the two parts of the request.

| Prompt ID | File | Called by | Inputs | Output schema |
| --- | --- | --- | --- | --- |
| `in-depth` | `prompts/in-depth.md` | pipeline | content or notes, clarifying input, source list, glossary on/off | `DocumentDraftTab` (kind `indepth`) |
| `eli5` | `prompts/eli5.md` | pipeline | same content or notes, clarifying input | `DocumentDraftTab` (kind `eli5`) |
| `glossary` | `prompts/glossary.md` | pipeline (only if toggle on) | in-depth tab draft (text only) | `GlossaryDraft` |
| `chunk-notes` | `prompts/chunk-notes.md` | budgeter | one chunk | `ChunkNotes` |
| `section-expand` | `prompts/section-expand.md` | viewer action "Expand this" | section, neighbors, doc outline, note | `SectionDraft` |
| `section-reexplain` | `prompts/section-reexplain.md` | "This isn't clear, re-explain it" | same | `SectionDraft` |
| `section-analogy` | `prompts/section-analogy.md` | "Give me an analogy" | same | `SectionDraft` |
| `section-deeper` | `prompts/section-deeper.md` | "Go deeper" | same, plus original source excerpt if in `meta.json` | `SectionDraft` |
| `section-eli5-tab` | `prompts/section-eli5-tab.md` | "Create a separate ELI5 for this section" | selected passage, section, outline | `DocumentDraftTab` (kind `section-eli5`) |
| `summary` | `prompts/summary.md` | pipeline after save | title, outline, first 2000 tokens of in-depth | `SummaryDraft` |
| `merge-match` | `prompts/merge-match.md` | merge check | new summary, top-K catalog candidates | `MergeMatchDraft` |

Rules that apply to all prompts:

- **In-depth:** WSJ-grade explanatory journalism: lead with why it matters, then structure, then detail; use charts, annotated figures, and pull quotes where the source has numbers or comparisons. May follow the source's logical structure. Ends with no references section; references are built deterministically by [07](07-output-document.md) from `meta.json`, not by the model.
- **ELI5:** rebuilt from scratch for comprehension; never mirrors source structure; no jargon, no glossary, no references; analogies over definitions.
- **Glossary:** a separate call so it works on the final in-depth text, returning `{term, expansion, explanation, anchorSectionIndex, anchorText}` where `anchorText` is the verbatim first occurrence. [07](07-output-document.md) places the margin note at that anchor; entries whose `anchorText` is not found are dropped.
- **Calibration:** every writing prompt includes the reader profile "a technical leader who is new to this domain" and the clarifying input, and instructs the model to explain what the original audience assumed.
- **Untrusted content:** source text is wrapped in `<source ref="...">...</source>` delimiters, and the system prompt states that instructions inside sources are content to explain, never instructions to follow. This module owns the delimiter and its escaping (`wrapSource` in `budget.ts`: attribute values are escaped and `<source`/`</source` inside the body is neutralized). Extracted sources are serialized through 04's `toPromptText` (the body) and `promptAttributes` (the `format`, `slides`, `pages`, `scanned-pages`, `sheets` and `truncated` attributes after `ref`), with image markers naming the vision labels ([04](04-extraction.md) §11). There is no second serializer.
- **Section actions** receive: the target section's current draft (re-derived from HTML by [08](08-interactive-reading.md)), the titles of all sections in the tab, the full text of the previous and next sections, the selected text, the optional one-line note, and the tab kind. They return exactly one `SectionDraft` that replaces the section outright (PRD v1 behavior). The model does not return an ID; the caller keeps the existing `SectionId`.
- **Merge match** receives at most K = 8 candidates, preselected by [09](09-library-storage.md) with a cheap lexical similarity over catalog summaries, and returns a score in [0,1] per candidate with a one-line reason. A score ≥ 0.75 counts as a strong match; [09](09-library-storage.md) owns that threshold.

Each prompt's `id@version` is written to `meta.json` (`generation.prompts`) for traceability.

## 10. Structured output: `DocumentDraft`

The model returns JSON that describes content and visuals. It never returns a full HTML page. [07](07-output-document.md) renders drafts into `index.html` with the doc runtime, assigns `SectionId`s (`sec-<tabkey>-<8 hex>`), and sanitizes any SVG. This keeps every document structurally valid, keeps section IDs stable and app-controlled, and makes regenerate-in-place a matter of swapping one `<section>`.

```ts
// src/main/llm/schemas/draft.ts (zod; types inferred)
export interface DocumentDraftTab {
  kind: 'indepth' | 'eli5' | 'section-eli5';
  title: string;                 // document title (indepth) or tab label seed
  dek?: string;                  // one-sentence standfirst
  sections: SectionDraft[];      // 1..40
}

export interface SectionDraft {
  heading: string;
  blocks: DraftBlock[];          // 1..60
}

export type DraftBlock =
  | { type: 'paragraph'; md: string }                    // inline markdown subset: **, *, `code`, [text](url)
  | { type: 'list'; ordered: boolean; items: string[] }  // inline md per item
  | { type: 'pullquote'; text: string; attribution?: string }
  | { type: 'callout'; tone: 'note' | 'warning' | 'keypoint'; md: string }
  | { type: 'table'; caption?: string; header: string[]; rows: string[][] }
  | { type: 'chart'; chart: ChartSpec }
  | { type: 'diagram'; title: string; svg: string; alt: string }  // inline SVG, sanitized by 07
  | { type: 'figure'; imageLabel: string; caption: string; annotations?: { x: number; y: number; text: string }[] }
  | { type: 'stepper'; title: string; steps: { label: string; md: string }[] } // light interactivity
  | { type: 'analogy'; md: string };

export interface ChartSpec {
  kind: 'bar' | 'stacked-bar' | 'line' | 'area' | 'pie' | 'scatter';
  title: string; subtitle?: string; source?: string;
  xLabel?: string; yLabel?: string; unit?: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
  highlight?: { category: string; note: string };
}

export interface ChunkNotes { notes: string; keyFacts: string[]; tables: { caption: string; header: string[]; rows: string[][] }[];
                              chartCandidates: ChartSpec[]; jargon: string[]; sourceRefs: string[] }
export interface GlossaryDraft { entries: { term: string; expansion?: string; explanation: string;
                                            anchorSectionIndex: number; anchorText: string }[] }  // 0..40
export interface SummaryDraft { title: string; topicSlugHint: string; summary: string } // summary: 1-2 sentences, <= 300 chars
export interface MergeMatchDraft { matches: { catalogId: string; score: number; reason: string }[] }
```

`figure.imageLabel` must equal the `label` of an `ImageInput` sent in the request; [07](07-output-document.md) embeds that image as a data URI. Charts are rendered to static inline SVG by [07](07-output-document.md) at build time from `ChartSpec`; the doc runtime only adds tooltips (no chart library fetched at view time).

### 10.1 Validation and repair (`structured.ts`)

1. Send the request with `jsonSchema` (provider-native structured output).
2. Parse and validate with zod. Also run semantic checks: `chart.series[i].values.length === categories.length`; `figure.imageLabel` exists; table rows match header width; `svg` starts with `<svg` and is under 100 KB.
3. On failure, drop the offending blocks when the rest is valid and at most 20% of blocks fail (for example, a malformed chart) and log a warning. Otherwise run one **repair call**: same request plus the assistant's invalid output and a user turn listing the validation errors ("Return corrected JSON only").
4. If repair also fails, throw `LLMError('invalid_output')`. For `in-depth` this fails the job; for `eli5`, `glossary`, and `summary` the pipeline degrades (ELI5 tab shows "ELI5 view could not be generated"; no glossary; summary falls back per [06](06-generation-pipeline.md) §7.1), per [06](06-generation-pipeline.md).

## 11. HTML skills

The PRD requires generation to follow two user-supplied HTML skills (the ELI5 skill and the beautiful documentation skill); either may be used for either tab. They are not yet delivered (PRD open item), so the mechanism is generic.

Reference approach: the prompts and the bundled default skills (`resources/skills/`) follow the "unreasonable effectiveness of HTML" article and its example repo: rich single-file HTML over Markdown, with visuals chosen for comprehension. The WSJ pattern study (chart takeaway headlines, annotated figures, pull quotes, steppers, graphics-first explainers) is recorded in `resources/skills/beautiful-doc/SKILL.md`, which serves as the fallback until the user supplies skills (PRD open item). [07](07-output-document.md) §7 uses that file as the source of its catalogue's WSJ conventions.

- **Format:** a skill is a directory containing `SKILL.md` (Markdown, optional front matter `name`, `slot`, `appliesTo: [indepth, eli5, section]`) and optional example files (`*.html`, `*.css`, `*.md`).
- **Locations, in priority order:** (1) the user skills folder `~/Library/Application Support/ELI5 Learner/skills/<name>/`; (2) bundled defaults in `resources/skills/<name>/`. Same name in both: the user copy wins.
- **Slots:** `beautiful-doc` and `eli5`. Prompt front matter lists which slots it wants (section 9). Missing slot: a short built-in fallback paragraph is used, and the app still works.
- **Injection:** the loader renders each skill into the system prompt under `## Style guide: <name>`, after the core instructions and before the output rules. Example HTML files are included as reference only, truncated to 8k tokens per skill. The system prompt tells the model to translate the skill's visual guidance into `DraftBlock` choices (charts, pull quotes, steppers, callouts), because the output is JSON, not HTML. Visual CSS from a skill that should apply to the rendered page is handed to [07](07-output-document.md) as a theme input, not sent to the model.
- **Budget:** skill text counts toward the system prompt in section 8.2. If all skills together exceed 20% of `contextTokens`, the examples are dropped first, then the skill body is truncated, and a warning is logged.
- **Caching:** because the skills are stable, `cacheSystemPrompt: true` is set on every call within a job.
- Skills are re-read when the folder changes (fs watch, debounced 1 s); no restart needed.

## 12. Task functions (`tasks.ts`)

```ts
export interface PreparedContent {
  mode: 'raw' | 'notes';
  contents?: ExtractedContent[];       // mode 'raw'
  notes?: ChunkNotes[];                // mode 'notes'
  images: ImageInput[];                // after re-encoding and per-request splitting
  sourceList: { ref: string; label: string }[];
  skipped: SkippedSource[];
  warnings: string[];                  // e.g. 'content-truncated'
  usage: TokenUsage; prompts: string[];
}                                       // JSON-serializable (images as base64) so 06 can checkpoint it

interface StepCtx { clarifyingInput: string; signal: AbortSignal;
                    onRetry?: (attempt: number, waitMs: number) => void }
interface StepResult<T> { draft: T; usage: TokenUsage; prompt: string }  // prompt = "id@version"

export async function prepareContent(input: { contents: ExtractedContent[];
  sourceList: { ref: string; label: string }[] } & StepCtx): Promise<PreparedContent>;
export async function generateIndepth(p: PreparedContent, ctx: StepCtx & { glossary: boolean })
  : Promise<StepResult<DocumentDraftTab>>;
export async function generateEli5(p: PreparedContent, ctx: StepCtx): Promise<StepResult<DocumentDraftTab>>;
export async function generateGlossary(indepth: DocumentDraftTab, ctx: StepCtx)
  : Promise<StepResult<GlossaryDraft>>;
export async function summarize(indepth: DocumentDraftTab, ctx: StepCtx): Promise<StepResult<SummaryDraft>>;

export async function runSectionAction(input: {
  action: 'expand' | 'reexplain' | 'analogy' | 'deeper' | 'eli5-tab';
  tabKind: Tab['kind']; section: SectionDraft; outline: string[];
  prev?: SectionDraft; next?: SectionDraft; selection: string; note?: string;
  sourceExcerpt?: string; signal: AbortSignal;
}): Promise<SectionDraft | DocumentDraftTab>;

export async function matchMerge(summary: string,
  candidates: { catalogId: string; title: string; summary: string }[]): Promise<MergeMatchDraft>;
```

Contract with [06](06-generation-pipeline.md) §5.4:

1. `prepareContent` does budgeting and, if needed, chunk-then-synthesize map/reduce (section 8). Chunk failures after retries mark the chunk's sources as skipped ("model error while reading") and continue, unless every chunk fails, which throws. Its result is reusable: 06 persists it and every later step takes it as input, so a resumed job never re-runs chunk notes.
2. 06 calls the step functions sequentially in the fixed order in-depth → ELI5 → glossary (only if the toggle is on) → summary, sets the status sub-line for each, and writes each `StepResult` to `<userData>/jobs/<jobId>/gen/<step>.json` before starting the next.
3. Each step function makes one logical call (plus the repair pass and the output-overflow retry of section 8.5) and throws `LLMError` on failure; it never decides whether the job fails. 06 applies the per-step failure rules (in-depth fails the job; ELI5, glossary and summary degrade per 06 §7.1).
4. Step functions are pure with respect to storage: they read nothing from disk except prompts and skills, and write nothing.

## 13. Bedrock stub and enterprise backend

`bedrock.stub.ts` exports `BedrockProvider implements LLMProvider` whose methods throw `new NotAvailableInEdition('llm:bedrock', 'HOOK-LLM-01', edition)` ([01](01-architecture.md) §6.4), and whose `testConnection` returns `{ok:false, error: LLMError('not_available')}`. Settings shows the `bedrock` option only when the edition registry reports it available ([11](11-app-shell-ui.md)); if `llm.provider = bedrock` is set by hand in a public build, generation fails with "Bedrock is available only in the enterprise edition", and the user can switch provider in Settings.

The dormant keys `llm.bedrock.region`, `llm.bedrock.modelId`, and `llm.bedrock.profile` are documented in [12](12-configuration-security.md) and ignored by the public build.

<!-- hook:HOOK-LLM-01 -->
> **Private hook · HOOK-LLM-01 · Enterprise LLM backend (cloud-hosted model gateway).** Public behavior: `llm.provider = bedrock` resolves to `BedrockProvider` stub, which throws `NotAvailableInEdition`; Claude and OpenAI with a user-supplied key are the only working backends. Private binding supplies: the real provider implementation registered with `registry.registerLLMProvider('bedrock', factory)` (or a gateway ID) and reached through `registry.llm()`; cloud account, region and model/inference-profile identifiers; how credentials are obtained (ambient cloud credentials or gateway token; never stored by the app in settings JSON); the model limits table rows for approved models; structured output and image input mapping for that backend; retry/rate-limit overrides for gateway quotas; whether the Claude/OpenAI direct providers are hidden or disabled in the enterprise build. Binding lives in the private spec under "HOOK-LLM-01".

The enterprise provider must pass the same provider contract test suite ([13](13-testing-quality.md)) as the public ones: same `GenerationRequest`/`GenerationResult` semantics, same `LLMErrorKind` classification, native structured output or the repair-loop fallback.

<!-- hook:HOOK-LLM-02 -->
> **Private hook · HOOK-LLM-02 · Enterprise prompt policy and data handling.** Public behavior: prompts load from `resources/prompts/` and skills from the bundled and user folders; no additional preamble; source content is sent only to the provider the user configured. Private binding supplies: an organization system-prompt preamble (for example, data-classification reminders or approved terminology), any prompt overrides directory shipped in the overlay (same file format as section 9, same IDs, overlay copy wins), organization-approved default skills, content that must never be sent to the model (patterns or classifications, enforced before `send()`), and logging and retention rules for token usage metadata. Binding lives in the private spec under "HOOK-LLM-02".

## 14. Settings, keys, and IPC

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `llm.provider` | `'claude' \| 'openai' \| 'bedrock'` | `'claude'` | `bedrock` dormant in public (HOOK-LLM-01) |
| `llm.model` | `string \| null` | `null` | `null` = provider default, resolved by `effectiveModel()` ([12](12-configuration-security.md) §3.2); free text with suggestions from `models.ts` |
| `llm.maxOutputTokens` | number | 32000 | Clamped to model limit |
| `llm.timeoutMs` | number | 1800000 | Per-attempt total cap; idle timeout 120 s (section 7.2) |
| `llm.maxConcurrency` | number | 2 | 1 to 6 |
| `llm.bedrock.*` | object | unset | Dormant; see [12](12-configuration-security.md) |

API keys: Keychain service `ELI5 Learner`, accounts `llm.claude.apiKey`, `llm.openai.apiKey`. Never in settings JSON, never logged, never sent to the renderer; the renderer sees only `{ hasKey: boolean }`.

IPC (handled in main, exposed via `window.eli5`, registered per [01](01-architecture.md)):

| Channel | Request | Response |
| --- | --- | --- |
| `eli5:llm:test-connection` | `{ provider?: ProviderId }` | `{ ok: boolean; model?: string; message?: string }` |
| `eli5:llm:models` | `{ provider: ProviderId }` | `{ suggested: string[]; default: string }` |

Setting and clearing keys goes through `eli5:settings:*` channels owned by [12](12-configuration-security.md).

## 15. Privacy and logging

- Logged per call: `taskId`, provider, model, attempts, latency, token usage, stop reason, error kind. Never logged: prompts, source text, images, model output, keys.
- A debug flag (`ELI5_DEBUG_LLM=1`, dev builds only) writes full request/response pairs to `userData/logs/llm/` for prompt tuning; the packaged public build ignores it.
- Source content goes only to the configured provider endpoint. No telemetry.

## 16. Testing hooks

- `FakeProvider implements LLMProvider` in `src/main/llm/testing/fake.ts`: returns fixture JSON keyed by `taskId`, can simulate each `LLMErrorKind`, latency, and `max_tokens` truncation. Used by pipeline and e2e tests ([13](13-testing-quality.md)); selected with `ELI5_LLM_FAKE=1` in test builds only.
- Provider contract tests run against recorded HTTP fixtures (cassettes, injected as `cassetteFetch` in place of `llmFetch`; no network in CI) for Claude and OpenAI: image encoding, structured output mapping, error classification, `retry-after` handling, streamed accumulation into one `GenerationResult`.
- Required cassettes: (a) a Claude `forced_tool` request answered with the 400 "tool_choice ... not supported for this model" is classified `bad_request`, not retried, and triggers the `output_config` fallback resend; (b) a model row with `supportsTemperature: false` produces a request body with no `temperature`, `top_p`, or `top_k`; (c) an OpenAI reasoning-model row sends the system prompt with role `developer` and no `temperature`.
- Prompt lint test: every prompt file parses, its `output` names a schema in `schemas/draft.ts`, and all `{{vars}}` are supplied by the corresponding task function.

## Acceptance criteria

- [ ] `LLMProvider` exposes `generate`, `generateWithImages`, optional `stream`, and `testConnection`; no vendor SDK is imported outside `src/main/llm/`.
- [ ] Claude and OpenAI providers both produce schema-valid `DocumentDraftTab` JSON through native structured output (`output_config.format` json_schema and `response_format` json_schema strict mode respectively); forced tool use is only a per-model fallback and its 400 triggers the `output_config` fallback.
- [ ] `temperature` is never sent to a model whose row has `supportsTemperature: false`, including the unknown-model fallback row; OpenAI system role follows `limits.systemRole`.
- [ ] Every Claude and OpenAI call streams internally; only the 120 s idle timeout and the 30 min total cap apply; effort is set explicitly per task; thinking tokens are budgeted inside `reservedOutput`.
- [ ] Both SDK clients use `llmFetch` (the `eli5-llm` session configured by `configureSession()`), so the system proxy, PAC, Keychain trust, and HOOK-FETCH-01 configuration apply to LLM traffic.
- [ ] Images from files, clipboard, and scanned PDF pages reach the model as native vision input with labels; oversized images are re-encoded; unsendable images are recorded as skipped with a reason.
- [ ] Model name is configurable; defaults live only in `models.ts`; unknown model IDs work with conservative limits.
- [ ] Retries follow section 7.1 (the single LLM retry policy; `PipelinePolicy` may override only its numbers), honor `retry-after` up to the cap, and stop on cancellation; `auth` and `bad_request` are never retried.
- [ ] A source set larger than the context budget completes through chunk-then-synthesize without a `context_overflow` error.
- [ ] `prepareContent`, `generateIndepth`, `generateEli5`, `generateGlossary`, and `summarize` are separate functions that [06](06-generation-pipeline.md) calls in order with checkpoints between them; step functions throw `LLMError` and leave the degrade/fail decision to 06.
- [ ] The model never emits `SectionId`s or full HTML; section actions return one `SectionDraft` that replaces the section while keeping its ID.
- [ ] All eleven catalogue prompts exist as `resources/prompts/*.md`, pass the prompt lint test, and record `id@version` in `meta.json`.
- [ ] Skills placed in the user skills folder are picked up without restart and override bundled skills of the same name; the app works with no skills installed.
- [ ] Source text is delimited as untrusted content in every prompt.
- [ ] `llm.provider = bedrock` in the public build fails with the enterprise-edition message, and the stub satisfies the interface; HOOK-LLM-01 and HOOK-LLM-02 are marked with machine marker and callout.
- [ ] API keys are read only from the Keychain, never logged, never exposed to the renderer.
- [ ] Provider contract tests and `FakeProvider` exist and run offline.
