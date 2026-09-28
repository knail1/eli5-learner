# URL fetching

This file specifies how the public web lane turns a URL into either extracted article content, a binary payload handed to a format extractor, or a skipped source. It covers the plain HTTP fetch (headers, redirects, timeouts, size caps, content-type routing), Readability-style article extraction, the heuristics that detect empty or client-rendered pages, the hidden `BrowserWindow` render fallback, login-wall detection, and politeness rules. It implements PRD "Fetching strategy" and the "Public URLs" row of "Inputs and extraction". It does not cover authenticated organization sources (the MCP lane, see HOOK-SRC-01) or the decision of which lane a URL takes (HOOK-SRC-03). The code lives in `src/main/fetch/`.

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [07-output-document.md](07-output-document.md) · [09-library-storage.md](09-library-storage.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Position in the system

```
URL resolver (sources/url.ts, see 03)
  │  lane = routeUrl(url)        ← HOOK-SRC-03 (public build: always 'web')
  ▼
fetchUrl(url, ctx)               ← this file, src/main/fetch/index.ts
  ├─ 1. httpFetch                 (fetch/http.ts)
  ├─ 2. content-type routing      (fetch/route.ts)
  │     ├─ HTML  → readability     (fetch/readability.ts, in worker thread)
  │     │          → emptiness check (fetch/detect.ts)
  │     │          → if client-rendered: renderInHiddenWindow (fetch/render-window.ts)
  │     └─ PDF / image / office / text → body streamed to ctx.stagingDir → FetchedBinary
  ├─ 3. login-wall detection      (fetch/login-wall.ts), at every stage
  └─ 4. politeness gate           (fetch/politeness.ts), wraps every network access
  ▼
FetchOutcome → ResolvedSource | SkippedSource  (built by the resolver; extraction runs later, in the extracting stage, 04/06)
```

The PRD rules apply here. Fetch first and render only as a fallback. Use no browser dependency beyond Electron's own Chromium: no Puppeteer, no Playwright at runtime, no bundled headless browser. A failure never fails the job. It becomes a `SkippedSource` with a human-readable reason (PRD "Processing pipeline", "Error handling").

### Module files

| File | Responsibility |
| --- | --- |
| `fetch/index.ts` | `fetchUrl()` orchestration, budget, cancellation |
| `fetch/http.ts` | Plain HTTP GET over an Electron session, redirects, caps, decoding |
| `fetch/route.ts` | Content-type and magic-byte sniffing, routing table |
| `fetch/readability.ts` | Worker-thread wrapper around `@mozilla/readability` + `jsdom` (imports the worker via `?nodeWorker`, section 5.2) |
| `fetch/readability.worker.ts` | The worker entry point (no Electron imports), bundled by electron-vite as a separate chunk |
| `fetch/detect.ts` | Empty / client-rendered scoring |
| `fetch/login-wall.ts` | Login-wall and paywall classification |
| `fetch/render-window.ts` | Hidden `BrowserWindow` fallback |
| `fetch/politeness.ts` | Per-host and global concurrency, spacing, `Retry-After` |
| `fetch/network.ts` | Session creation, proxy and trust configuration (HOOK-FETCH-01) |
| `fetch/constants.ts` | All limits in section 11 (single source of truth) |
| `fetch/errors.ts` | `FetchSkipCode` → reason string mapping |

## 2. Public API

`ExtractedContent`, `ContentBlock`, `SourceInput`, and `SkippedSource` are owned by [04-extraction.md](04-extraction.md) and [03-source-resolvers.md](03-source-resolvers.md). This module defines only the fetch-specific types.

```ts
// src/main/fetch/index.ts
export interface FetchContext {
  jobId: string;
  signal: AbortSignal;                 // job cancellation; aborts network + render window
  stagingDir: string;                  // <userData>/jobs/<jobId>/ (03 ResolveContext, 06 §9.2); binary bodies are written here
  onProgress?: (detail: FetchProgress) => void; // optional, pipeline may ignore (status stays one line)
}

export type FetchProgress =
  | { phase: 'http'; url: string }
  | { phase: 'render'; url: string }
  | { phase: 'extract'; url: string };

export type FetchOutcome =
  | { kind: 'article'; content: FetchedArticle }
  | { kind: 'binary'; content: FetchedBinary }
  | { kind: 'skipped'; code: FetchSkipCode; reason: string; finalUrl?: string };

export interface FetchedArticle {
  requestedUrl: string;
  finalUrl: string;                    // after redirects / client navigation
  title: string | null;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null;        // ISO 8601 when discoverable
  excerpt: string | null;
  contentHtml: string;                 // Readability output, sanitized (section 5.3)
  textLength: number;
  via: 'http' | 'render';              // which lane produced it
  imageUrls: string[];                 // absolute URLs of in-article images (not fetched here)
}

export interface FetchedBinary {
  requestedUrl: string;
  finalUrl: string;
  mime: string;                        // normalized, e.g. 'application/pdf'
  filename: string;                    // from Content-Disposition or URL path, sanitized
  path: string;                        // absolute path of the body, streamed into ctx.stagingDir
  sizeBytes: number;
}

export type FetchSkipCode =
  | 'invalid-url' | 'blocked-scheme' | 'credentials-in-url'
  | 'dns-failure' | 'connect-failure' | 'tls-error'
  | 'timeout' | 'too-large' | 'too-many-redirects'
  | 'http-not-found' | 'http-gone' | 'http-client-error' | 'http-server-error' | 'rate-limited'
  | 'login-required' | 'paywall'
  | 'unsupported-type' | 'empty-content' | 'render-failed'
  | 'blocked-private-address';

export function fetchUrl(url: string, ctx: FetchContext): Promise<FetchOutcome>;
```

The URL resolver (03 §7) turns each outcome into a `ResolvedSource` or `SkippedSource`. It never extracts. Extraction happens later in the pipeline's `extracting` stage ([06-generation-pipeline.md](06-generation-pipeline.md)), which is where [04-extraction.md](04-extraction.md) runs.

- `article`: the resolver returns `ResolvedSource { format: 'html', payload: { kind: 'html', html: contentHtml, baseUrl: finalUrl }, ref: requestedUrl, location: finalUrl, title }`. During `extracting`, 04 runs its HTML-to-blocks converter (`htmlToBlocks`) on that payload. `finalUrl` is kept for the References section ([07-output-document.md](07-output-document.md)).
- `binary`: `fetchUrl` has already streamed the body to a file under `ctx.stagingDir` (section 4.5). The resolver runs `sniff()` on that file and returns a `ResolvedSource` with the matching format and `payload: { kind: 'path', path }`, exactly as for a dropped file. Text, Markdown, JSON, and CSV bodies take the same path, and the resolver may convert them to a `text`/`markdown` payload per 03. The file name and URL are both kept for references. The pipeline deletes `stagingDir` when the job ends.
- `skipped`: records `SkippedSource { ref: url, reason }`.

`fetchUrl` never throws for network or content problems. It throws only for programmer errors and for `AbortError` when `ctx.signal` aborts. The pipeline ([06-generation-pipeline.md](06-generation-pipeline.md)) treats an abort as job cancellation, not as a skip.

## 3. Orchestration algorithm

`fetchUrl(url, ctx)` runs these steps:

1. **Normalize and validate** (section 4.1). On failure, return `skipped` with `invalid-url`, `blocked-scheme`, or `credentials-in-url`.
2. Start the **overall budget** timer (`URL_TOTAL_BUDGET_MS`, 75 s). Link it with `ctx.signal` into a single `AbortController`.
3. **Per-job dedupe**: if the same normalized URL is already in flight or finished in this job, return the cached outcome. The cache is keyed by `jobId + normalizedUrl` and dropped when the job ends.
4. Acquire a **politeness slot** for the host (section 9).
5. `httpFetch` (section 4). On a network or HTTP error, map it to a skip code (section 10). **One exception:** if the error is `http-client-error` 403 or 429 *without* login-wall signals, or the response is a bot-challenge interstitial (section 6.3), go to step 9 (render fallback) instead of skipping; if the render also fails, return the original HTTP skip (`http-client-error` / `rate-limited`), because some sites serve real pages only to a full browser.
6. **Route by content type** (section 4.6):
   - binary type → return `binary`.
   - unsupported → return `skipped: unsupported-type`.
   - HTML → continue.
7. **Login-wall check on the HTTP response** (section 7). If the result is conclusive, return `skipped: login-required` or `paywall`.
8. **Readability** on the HTML in the worker (section 5), then compute the **emptiness score** (section 6).
   - `verdict = 'ok'` → return `article` (via `http`).
   - `verdict = 'client-rendered'` or `'empty'` → continue to the render fallback.
9. **Render fallback** (section 8), if the remaining budget is at least `RENDER_MIN_BUDGET_MS` (15 s). Otherwise return `skipped: timeout`.
10. On the rendered DOM: run the login-wall check again, then Readability, then the emptiness check.
    - ok → return `article` (via `render`).
    - login wall → `skipped: login-required` / `paywall`.
    - still empty → `skipped: empty-content`.
    - render error → `skipped: render-failed` (or `timeout`).
11. Release the politeness slot in `finally`.

The PRD's "if both fail, record as skipped" is steps 9 and 10. There is no third lane in the public build.

## 4. Plain HTTP fetch

### 4.1 URL validation and normalization

| Rule | Behavior |
| --- | --- |
| Parse with WHATWG `URL` | Parse failure → `invalid-url` |
| Scheme | Only `http:` and `https:`. `file:` URLs are rewritten to the file resolver by 03 before reaching here. `data:`, `javascript:`, `blob:`, `ftp:`, and anything else → `blocked-scheme` |
| Userinfo (`user:pass@host`) | → `credentials-in-url`. The public build never sends credentials (PRD "Public build: no authentication of any kind") |
| Fragment | Stripped for fetching and kept for display in references |
| Host | Lowercased and IDNA-encoded. Trailing dot removed |
| Bare host typed by the user (`example.com/x`) | Prefixed with `https://` by the URL resolver (03 §7.1) before `fetchUrl` is called. It is not guessed here |

### 4.2 Transport

- Requests go through Electron's `net.request({ url, method: 'GET', redirect: 'manual', session: fetchSession, useSessionCookies: true })` (a `ClientRequest`), not `session.fetch()`/`net.fetch()`. Under the WHATWG fetch spec, `redirect: 'manual'` yields an opaque redirect with no readable `Location`, so per-hop checks (4.4) are impossible through the fetch API. `ClientRequest` emits a `'redirect'` event with `statusCode`, `method`, and `redirectUrl`, and the hop proceeds only when `request.followRedirect()` is called. This behavior is part of Electron's documented `net` API; the implementation pins the Electron major in `package.json` and a unit test in section 13 asserts the `'redirect'` event fires with the `Location` target on the pinned version. The fetch session is dedicated: `session.fromPartition('eli5-fetch')`. This partition has no `persist:` prefix, so it lives in memory, shares no cookies with the app UI session, and is cleared on quit.
- Using the Electron session, rather than Node's `fetch`, gives Chromium's network stack: system proxy resolution (PAC/WPAD), the macOS trust store for TLS, HTTP/2 and HTTP/3, and Brotli. It also means network behavior matches the render fallback exactly.
- Cookies: the fetch session accepts cookies within a single `fetchUrl` call, because some sites set a consent or session cookie on redirect. `network.ts` clears the session's cookies when each job ends (`ses.clearStorageData({ storages: ['cookies'] })`), so no state carries across jobs.
- The session is configured by `network.ts`, which applies the enterprise network binding when present.

<!-- hook:HOOK-FETCH-01 -->
> **Private hook · HOOK-FETCH-01 · Enterprise network configuration (proxy and TLS trust).** Public behavior: the fetch session and every render-window partition use `proxy mode 'system'` and Chromium's default certificate verification against the macOS trust store. There is no custom CA handling, no proxy credentials, and no certificate-verify override. Private binding supplies: the proxy mode and PAC URL or explicit proxy rules, a proxy bypass list, extra CA certificates to trust (for TLS-inspecting egress proxies) or a policy to require them in the system trust store instead, whether proxy authentication is needed and how it is satisfied without the app holding credentials, and the dormant `fetch.network.*` setting values delivered through HOOK-CFG-01. Binding lives in the private spec under "HOOK-FETCH-01".

`network.ts` exposes `configureSession(ses: Session): Promise<void>`. It is called for the fetch session once at startup and for each pooled render partition once, when the pool is created (8.1). The public implementation calls `ses.setProxy({ mode: 'system' })` and nothing else.

Enterprise replacement goes through two registry slots declared in 01 §6.2 (the registry is frozen after bootstrap, so these are registrations, not runtime swaps):

```ts
// CapabilityRegistry (01 §6.2)
registerNetworkConfigurator(fn: NetworkConfigurator): void;  // HOOK-FETCH-01; replaces the public configureSession
registerLoginSignatures(sigs: LoginSignature[]): void;       // HOOK-FETCH-02; appended to the public (empty) list

// src/main/fetch/types.ts
export type NetworkConfigurator = (ses: Session) => Promise<void>;
export interface LoginSignature { hostPattern?: RegExp; urlPattern?: RegExp; domSelector?: string; kind: 'conclusive' | 'strong'; }
```

Bootstrap calls `configureFetch({ configureSession: registry.networkConfigurator(), loginSignatures: registry.loginSignatures() })` from `fetch/index.ts` once after `registry.freeze()` and before the first `fetchUrl`. The public build registers the public `configureSession` and an empty signature list.

### 4.3 Request headers

| Header | Value |
| --- | --- |
| `User-Agent` | Electron's default Chromium UA string with ` ELI5Learner/<appVersion>` appended. This is honest about the client while staying compatible with sites that reject non-browser agents |
| `Accept` | `text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.8,image/*;q=0.7,*/*;q=0.5` |
| `Accept-Language` | `app.getPreferredSystemLanguages()` joined with q-values, with `en;q=0.5` as a fallback |
| `Accept-Encoding` | Set by Chromium (gzip, deflate, br, zstd) |
| `Referer` | Not sent |
| `Authorization`, `Cookie` (initial) | Never set by the app |
| `DNT`, `Sec-GPC` | `1` |

The render window uses the same UA (`webContents.setUserAgent`) so the two lanes look the same to the server.

### 4.4 Redirects

Redirects are followed manually so each hop can be checked. `http.ts` listens for the `ClientRequest` `'redirect'` event (4.2), runs the checks below on `redirectUrl`, and then either calls `request.followRedirect()` or calls `request.abort()` and returns the skip:

1. Allow at most `MAX_REDIRECTS` (10) hops. Beyond that → `too-many-redirects`. A loop (the same URL seen twice) is treated the same way.
2. Each `Location` is resolved against the current URL and put through the section 4.1 validation again. A scheme change to anything other than http/https → `blocked-scheme`.
3. An `https` → `http` downgrade is allowed. It is recorded in `finalUrl`, and the downgrade is logged at debug level.
4. **Private-address guard.** If a redirect target (not the URL the user typed) resolves to a loopback, link-local, RFC 1918, or unique-local address, or its host is `localhost` or ends in `.local` or `.internal`, return `blocked-private-address`. A URL the user *typed* that points to a private address is allowed, because the user may be reading a local dev server. What is blocked is a public page bouncing the app into the user's network. The render fallback applies the same guard to every request the page makes (8.2). The check uses `dns.lookup` from `node:dns/promises` on the redirect host before the next hop. Resolution failures fall through to the real request, which then fails normally.
5. Each hop is checked against login-wall URL patterns (section 7.1). A match stops redirecting immediately: return `login-required` with `finalUrl` set to the login URL.
6. `meta http-equiv="refresh"` with a delay of 5 s or less, found in an HTML body under 4 KB of text, counts as one more redirect hop (the same checks apply). Longer delays are ignored.

### 4.5 Timeouts and size caps

| Limit | Constant | Value | Skip code |
| --- | --- | --- | --- |
| Time to response headers | `HTTP_HEADERS_TIMEOUT_MS` | 15 000 | `timeout` |
| Time for the full body | `HTTP_BODY_TIMEOUT_MS` | 45 000 | `timeout` |
| Stall (no bytes received) | `HTTP_STALL_TIMEOUT_MS` | 15 000 | `timeout` |
| HTML body | `MAX_HTML_BYTES` | 5 MiB | `too-large` |
| Text/Markdown/JSON body | `MAX_TEXT_BYTES` | 5 MiB | `too-large` |
| Image body | `MAX_IMAGE_BYTES` | 20 MiB | `too-large` |
| PDF / office body | `MAX_DOCUMENT_BYTES` | 50 MiB | `too-large` |

Algorithm:

1. When `Content-Length` is present and exceeds the cap for the declared type, abort before reading the body.
2. Otherwise read the body as a stream, count bytes, and abort as soon as the cap is exceeded. The cap is chosen after routing (4.6), so sniffing uses at most the first 4 KiB. HTML bodies are buffered in memory. Binary bodies are streamed to `<ctx.stagingDir>/<random>-<filename>` (created with `wx`, so nothing is overwritten); a partial file is deleted on any skip or abort.
3. **HTML exception:** a truncated HTML body is *not* a skip when at least `MIN_HTML_PREFIX_BYTES` (1 MiB) was read. Parse the prefix and set `truncated = true` in the debug log. Article text is almost always in the first megabyte, and a partial article beats none.

### 4.6 Content-type routing and sniffing

The MIME type comes from `Content-Type` with parameters stripped and the value lowercased. The type is **sniffed** from the first bytes when the header is missing, is `application/octet-stream`, or is `binary/octet-stream`, or when it contradicts the magic bytes of a PDF or image (servers mislabel often).

| Magic bytes | Sniffed type |
| --- | --- |
| `%PDF-` | `application/pdf` |
| `89 50 4E 47` | `image/png` |
| `FF D8 FF` | `image/jpeg` |
| `GIF87a` / `GIF89a` | `image/gif` |
| `RIFF....WEBP` | `image/webp` |
| `PK 03 04` + URL/filename extension `.pptx`/`.docx`/`.xlsx` | matching OOXML type |
| leading `<!doctype html` / `<html` (case-insensitive, after whitespace/BOM) | `text/html` |

Routing table:

| MIME | Outcome | Handled by |
| --- | --- | --- |
| `text/html`, `application/xhtml+xml` | HTML path (section 5) | this file |
| `application/pdf` | `binary` | PDF extractor, text or scanned ([04-extraction.md](04-extraction.md)) |
| `image/png`, `image/jpeg`, `image/gif`, `image/webp` | `binary` | image extractor → LLM vision input |
| `image/svg+xml` | `binary` as `text/plain` of the SVG source when it is 1 MiB or less, otherwise `unsupported-type` | text extractor |
| `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `binary` | pptx extractor |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `binary` | docx extractor |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `binary` | xlsx extractor |
| `text/plain`, `text/markdown`, `text/x-markdown` | `binary` (decoded later as text) | text/Markdown extractor |
| `application/json`, `text/csv` | `binary` | text extractor (as-is) |
| anything else (video, audio, archives, executables, `application/xml` feeds) | `skipped: unsupported-type`, with the MIME type in the reason | — |

`FetchedBinary.filename` comes from `Content-Disposition` `filename*`/`filename` if present, otherwise from the last URL path segment, otherwise from `download` + an extension derived from the MIME type. Path separators and control characters are removed and the name is limited to 120 chars.

### 4.7 Character decoding (HTML and text)

The charset is taken from the first of these that is present:

1. a BOM (UTF-8, UTF-16LE/BE)
2. the `charset` parameter of `Content-Type`
3. `<meta charset>` or `<meta http-equiv="Content-Type">` in the first 1024 bytes
4. UTF-8

Decoding uses `TextDecoder(label, { fatal: false })`. An unknown label falls back to `windows-1252`, following the WHATWG encoding spec.

## 5. Readability extraction

### 5.1 Libraries

- `@mozilla/readability` performs the article extraction. `isProbablyReaderable` supplies one signal to the emptiness score.
- **`jsdom` is the DOM implementation.** It is configured with `runScripts` unset (scripts never execute), `resources: undefined` (no subresource loading), a silent `VirtualConsole`, and `url: finalUrl` so relative links resolve. jsdom was chosen over lighter DOMs because it is the implementation Readability is tested against. Its cost is paid off the main thread (5.2).

### 5.2 Worker thread

Parsing multi-megabyte HTML would freeze the UI if it ran on the Electron main thread. `readability.ts` therefore keeps a small pool of Node `worker_threads` (size `READABILITY_WORKERS` = 2). They start lazily and are terminated after 60 s idle.

```ts
// message into worker
interface ReadabilityJob { html: string; url: string; }
// message out of worker
interface ReadabilityResult {
  article: null | {
    title: string | null; byline: string | null; siteName: string | null;
    lang: string | null; publishedTime: string | null; excerpt: string | null;
    contentHtml: string; textLength: number; imageUrls: string[];
  };
  signals: PageSignals;          // raw inputs for detect.ts and login-wall.ts (section 6.1)
}
```

- A per-job worker timeout `READABILITY_TIMEOUT_MS` (20 s) terminates the worker and replaces it. The URL then goes to the render fallback, because a pathological DOM is often a script-built page, and if that also fails the result is `skipped: empty-content`.
- The worker imports no Electron modules, so it can be unit tested under Vitest with plain Node.

**Build and packaging.** The worker is not loaded from a hand-written file path.

1. `readability.ts` imports it with electron-vite's worker suffix: `import createReadabilityWorker from './readability.worker?nodeWorker'`, then `createReadabilityWorker({ workerData })`. electron-vite emits the worker as its own chunk in `out/main/` and resolves the path, so it works both in dev and inside the packaged `app.asar`.
2. `jsdom` and `@mozilla/readability` are listed in the main build's `rollupOptions.external` (electron-vite's `externalizeDepsPlugin` covers this when both are in `dependencies`). jsdom has dynamic `require`s and an optional native `canvas` peer that Vite cannot bundle. Both packages are therefore **production `dependencies`**, not `devDependencies`, and electron-builder ships them in `node_modules` inside the asar. `canvas` is not installed; jsdom degrades gracefully without it.
3. A packaging smoke test (13) runs one Readability job in the built, packaged app to catch asar or externalization regressions.

If the packaged-app smoke test cannot be made to pass, the fallback is to run Readability inside the 04 extract `utilityProcess` instead of a `worker_threads` pool, with the same `ReadabilityJob`/`ReadabilityResult` messages.

### 5.3 Readability configuration and post-processing

- `new Readability(doc, { charThreshold: 500, keepClasses: false, nbTopCandidates: 5 })`.
- The worker runs on a clone of the document (`doc.cloneNode(true)`), because Readability mutates the DOM and `PageSignals` are computed from the unmutated original.
- Post-processing of `contentHtml`, in the worker:
  1. Remove `script`, `style`, `iframe`, `object`, `embed`, `form`, `input`, `button`, `noscript`, and all `on*` attributes.
  2. Rewrite `href`/`src` to absolute URLs. Remove `javascript:` URLs.
  3. Collect `img[src]` (and the largest `srcset` candidate) into `imageUrls`. Images are **not** fetched here. Whether an in-article image is worth sending to vision is the extraction stage's decision (04).
  4. Keep `table`, `pre`, `code`, `figure`/`figcaption`, `blockquote`, headings, and lists as-is for the HTML-to-blocks converter.
- `publishedTime` comes from Readability, or else from `meta[property="article:published_time"]`, or else from the first `time[datetime]` in the article.
- `title` precedence: Readability title, then `og:title`, then `<title>`, then the URL host plus path.

## 6. Empty and client-rendered detection

### 6.1 Page signals

The worker computes these from the **original** (pre-Readability) DOM:

```ts
export interface PageSignals {
  bodyTextLength: number;          // visible-ish text: body.textContent minus script/style/noscript, whitespace-collapsed
  articleTextLength: number;       // Readability textLength, 0 if null
  readerable: boolean;             // isProbablyReaderable(doc, { minContentLength: 140, minScore: 20 })
  scriptBytes: number;             // sum of inline script text + (count of external scripts × 50 000 estimate)
  htmlBytes: number;
  mountPointEmpty: boolean;        // see 6.2 rule R3
  noscriptSaysEnableJs: boolean;   // noscript text matches /enable javascript|requires javascript|javascript is (disabled|required)/i
  hasPasswordField: boolean;       // input[type=password] present
  formCount: number;
  metaRefreshUrl: string | null;
  titleText: string;
  challengeMarkers: boolean;       // see 6.3
}
```

### 6.2 Verdict rules

`detect.ts` exports `classify(signals): 'ok' | 'client-rendered' | 'empty'`. It evaluates the rules in order and the first match wins.

| # | Rule | Verdict |
| --- | --- | --- |
| R1 | `articleTextLength >= 1500` | `ok` |
| R2 | `articleTextLength >= 500` and `readerable` | `ok` |
| R3 | `mountPointEmpty`: an element matching `#root, #app, #__next, #__nuxt, #svelte, [data-reactroot], [ng-version], [data-server-rendered], app-root` exists and has fewer than 200 chars of text, **or** `body` has 5 or fewer element children and one of them is a lone `div` with text under 200 chars | `client-rendered` |
| R4 | `noscriptSaysEnableJs` and `bodyTextLength < 1000` | `client-rendered` |
| R5 | `scriptBytes / max(bodyTextLength, 1) > 20` and `bodyTextLength < 2000` | `client-rendered` |
| R6 | `challengeMarkers` | `client-rendered` (the browser may pass the check) |
| R7 | `articleTextLength < 200` and `bodyTextLength < 500` | `empty` |
| R8 | `articleTextLength >= 200` | `ok` (a short but real page, such as a glossary entry or changelog) |
| R9 | otherwise | `empty` |

Both `client-rendered` and `empty` trigger the render fallback when the HTTP stage produced them. `empty` exists as a separate verdict so the reason text can be accurate when the render fallback also finds nothing ("page had no readable content" rather than "page could not be rendered").

The thresholds live in `constants.ts`. They are calibrated by the fixture suite (section 12), and changing one requires the fixture expectations to stay green.

### 6.3 Bot-challenge interstitials

`challengeMarkers` is true when any of these hold: the title matches `/just a moment|checking your browser|attention required|verify you are human/i`; there is a `form` whose action contains `challenge`; or an element's id or class matches `/challenge|captcha/i` and `bodyTextLength < 1500`. The render fallback gets **one** attempt with the normal wait strategy. If the rendered page still has challenge markers, the result is `skipped: render-failed` with the reason "site blocked automated access". The app never tries to solve CAPTCHAs.

## 7. Login-wall and paywall detection

The public build never authenticates. When a page is behind a login, the correct outcome is a clean, explained skip (PRD "Fetching strategy" step 3; reason example "page required login"). In the enterprise build, HOOK-SRC-03 sends known organization hosts to the MCP lane *before* this module runs. Detection here is the safety net for hosts routing did not catch.

### 7.1 Signals

| Kind | Signal | Weight |
| --- | --- | --- |
| HTTP | Status `401`, or any status with a `WWW-Authenticate` header | conclusive |
| HTTP | Status `407` (proxy auth) | conclusive (reason: "network proxy requires sign-in"). See HOOK-FETCH-01 |
| URL | Redirect hop or final URL path/query matches `/(^|\/)(login|log-in|signin|sign-in|sso|saml2?|oauth2?|openid|authorize|auth|account\/login|session\/new)(\/|\?|$)/i` or has query keys `returnUrl`, `return_to`, `redirect_uri`, `continue`, `RelayState`, `SAMLRequest` | strong |
| URL | Final host differs from the requested host and the host's first label is `login`, `signin`, `sso`, `auth`, `id`, `accounts`, or `idp` | strong |
| URL | Host matches the organization identity-provider patterns from HOOK-FETCH-02 | conclusive |
| DOM | `hasPasswordField` and `articleTextLength < 1500` | strong |
| DOM | `formCount >= 1` and title or `h1` matches `/sign in|log in|login|single sign-on/i` | strong |
| DOM | Paywall markers: `meta[name="robots"]` absent AND text matches `/subscribe to (continue|read)|already a subscriber|this content is for subscribers/i` near the end of short article text, or `isAccessibleForFree: false` in JSON-LD | paywall |
| HTTP | `403` with a strong DOM login signal | strong |

### 7.2 Classification

1. Any **conclusive** signal → `login-required`.
2. Two or more **strong** signals → `login-required`.
3. One strong signal plus a verdict of `empty` or `client-rendered` → go to the render fallback, then re-evaluate on the rendered DOM, where rules 1 and 2 apply. If there is still one strong signal and the content is empty → `login-required`.
4. A paywall signal with `articleTextLength < 1500` → `paywall` (reason "page required a subscription"). With more text than that, keep the partial article: the PRD prefers carrying on with what was ingested. The extraction stage adds the note "article may be truncated by a paywall", which becomes a warning line in `meta.json` (09).
5. Otherwise, not a login wall.

<!-- hook:HOOK-FETCH-02 -->
> **Private hook · HOOK-FETCH-02 · Organization identity-provider and login-page signatures.** Public behavior: login walls are detected only by the generic HTTP, URL, and DOM heuristics in section 7.1, and the result is always `skipped: login-required`. Private binding supplies: the organization's identity-provider hostnames and URL patterns (SSO portal, federation endpoints) to treat as conclusive login signals; any organization-specific login-page DOM markers; and whether a login-wall hit on an unrouted host should produce a skip reason that tells the user to add the host to the MCP routing rules (HOOK-SRC-03). Binding lives in the private spec under "HOOK-FETCH-02".

The signature list is registered through `registerLoginSignatures` (section 4.2). The public build registers no policy, so the list is empty. The enterprise overlay contributes entries at bootstrap (see HOOK-CFG-02).

## 8. Hidden BrowserWindow fallback

### 8.1 Window and session configuration

Electron never releases a session created for a new partition during the life of the process, so a partition per render would grow memory with every rendered URL. Renders therefore use a **fixed pool** of `MAX_RENDER_WINDOWS` non-persistent partitions, `eli5-render-0` and `eli5-render-1`, created lazily and configured once. The render semaphore (8.5) hands out a slot index together with the permit, so each partition is used by one render at a time.

```ts
// render-window.ts, once per slot (lazily)
const partition = `eli5-render-${slot}`;                   // non-persistent (no 'persist:'), pooled
const ses = session.fromPartition(partition, { cache: false });
await configureSession(ses);                               // proxy/trust, HOOK-FETCH-01
installSessionHandlers(ses);                               // permissions, downloads, the single webRequest listeners (8.2)

// per render
const win = new BrowserWindow({
  show: false,
  width: 1280, height: 2000,                               // tall viewport: more lazy content renders
  paintWhenInitiallyHidden: true,
  webPreferences: {
    partition,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    javascript: true,
    images: false,                                         // bytes not needed; alt text survives
    webgl: false,
    plugins: false,
    backgroundThrottling: false,                           // hidden windows otherwise throttle timers
    spellcheck: false,
    preload: undefined,                                    // no preload: the page gets no bridge
  },
});
win.webContents.setAudioMuted(true);
win.webContents.setUserAgent(FETCH_USER_AGENT);
```

Each render still starts from a clean cookie jar, cache, and storage, because teardown (8.4) runs `clearStorageData()` and `clearCache()` on the slot's session before the slot is released. Nothing leaks between renders or into the fetch session or the app UI, and memory stays bounded at two sessions.

### 8.2 Lockdown handlers (installed before `loadURL`)

Session-level handlers are installed once per pooled session. Per-render state (the current top-level URL, whether it was user-typed private, the in-flight counter, the `loginRedirect` flag) lives in a `RenderState` object that the slot points at while a render is active; the session handlers read it. Window-level handlers are installed on each new `BrowserWindow`.

Electron keeps **only one listener per `webRequest` event** on a session; a second `onBeforeRequest` call silently replaces the first. So each session has exactly one `onBeforeRequest`, one `onCompleted`, and one `onErrorOccurred`, and all concerns (blocking, the private-address guard, in-flight counting) are combined inside them:

```ts
ses.webRequest.onBeforeRequest(async (d, cb) => {
  const st = currentState(slot);
  if (!st || d.webContentsId !== st.webContentsId) return cb({ cancel: true });
  if (BLOCKED_TYPES.has(d.resourceType)) return cb({ cancel: true });   // media, font, image, object, ping, cspReport
  if (!st.allowPrivate && await isPrivateTarget(d.url)) {               // same check as 4.4 rule 4 (host names + dns.lookup)
    if (d.resourceType === 'mainFrame') st.blockedPrivate = true;
    return cb({ cancel: true });
  }
  if (d.resourceType !== 'webSocket') st.inflight.add(d.id);
  cb({});
});
ses.webRequest.onCompleted(d => currentState(slot)?.inflight.delete(d.id));
ses.webRequest.onErrorOccurred(d => currentState(slot)?.inflight.delete(d.id));
```

`allowPrivate` is true only when the user-typed top-level URL itself is a private or loopback address (4.4 rule 4). Otherwise every request from the page, including subresources, XHR/`fetch`, WebSocket upgrades, and subframes, is cancelled when its host is `localhost`, ends in `.local` or `.internal`, is a literal private/loopback/link-local IP, or resolves to one. This stops page JavaScript from reaching the user's LAN or local services (a CSRF path), not only main-URL redirects. `isPrivateTarget` caches lookups per host for the duration of the render. A main-frame block ends the render with `blocked-private-address`.

| Concern | Handler |
| --- | --- |
| Permissions (camera, mic, geolocation, notifications, clipboard, and so on) | `ses.setPermissionRequestHandler((_, __, cb) => cb(false))` and `setPermissionCheckHandler(() => false)` |
| Downloads | `ses.on('will-download', (e, item) => item.cancel())`. A URL that downloads (for example a PDF with `Content-Disposition: attachment`) was already routed as binary by the HTTP stage, so reaching this point is an anomaly |
| Popups | `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` |
| Navigation | `will-navigate` / `will-redirect`: allow http/https only. Apply the private-address guard (4.4 rule 4) and the login URL patterns (7.1). A login pattern match calls `preventDefault()`, marks `loginRedirect = true`, and ends the render |
| Heavy resources | Inside the single combined `onBeforeRequest` above: cancel `resourceType` in `media`, `font`, `image`, `object`, `ping`, `cspReport`. Allow `mainFrame`, `subFrame`, `script`, `stylesheet`, `xhr`, `fetch`, `webSocket`, `other` (subject to the private-address check) |
| Private network | Inside the same listener: cancel any request to a private/loopback target unless `allowPrivate` |
| Certificate errors | Default Chromium behavior (reject). No `certificate-error` override in the public build |
| Dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) | `will-prevent-unload` → `e.preventDefault()`. On `dom-ready`, `webContents.executeJavaScript` (main world, the one deliberate main-world call) replaces `alert`/`confirm`/`prompt` with no-ops returning `undefined`/`false`/`null`. A dialog fired before `dom-ready` blocks the renderer. The probe then stops answering, and the 8.4 watchdog destroys the window, giving `render-failed` |
| Crashes | `render-process-gone` → finish as `render-failed` |

### 8.3 Wait strategy

The goal is to decide as early as possible that the page is *settled*, within a hard timeout.

1. `win.loadURL(url, { userAgent })`. Wait for `did-finish-load` or `did-fail-load`. `did-fail-load` on the main frame maps its error code to a skip code (`ERR_NAME_NOT_RESOLVED` → `dns-failure`, `ERR_CERT_*` → `tls-error`, `ERR_TIMED_OUT` → `timeout`, other → `render-failed`). `ERR_ABORTED` caused by our own navigation block is not a failure.
2. **In-flight request tracking.** The combined session listeners from 8.2 maintain `RenderState.inflight` (no additional `webRequest` listeners are registered). `webSocket` requests are never counted, and requests older than 5 s (long-polls) are ignored when evaluating idleness.
3. **Settle polling.** Every `RENDER_POLL_MS` (250 ms), call `webContents.executeJavaScriptInIsolatedWorld(999, [{ code: PROBE }])`. `PROBE` returns `{ textLength: document.body?.innerText.length ?? 0, nodeCount: document.getElementsByTagName('*').length, readyState }`. It runs in an isolated world, so page scripts cannot tamper with it or observe it.
4. After `did-finish-load`, scroll once: `window.scrollTo(0, document.body.scrollHeight)` in the isolated world, then back to top after 300 ms. This triggers lazy-loaded sections.
5. The page is **settled** when all of these hold:
   - at least `RENDER_MIN_WAIT_MS` (1 500 ms) since `did-finish-load`;
   - `inflight == 0` for 500 ms (the network-idle approximation);
   - `textLength` and `nodeCount` unchanged across `RENDER_QUIET_MS` (1 000 ms) of polls;
   - **or**, as an early exit, `textLength >= 3000` and unchanged for 500 ms.
6. **Hard timeout** `RENDER_TIMEOUT_MS` = 20 000 ms from `loadURL`, capped by the remaining overall budget. On timeout, **snapshot anyway**: a page that never goes idle (analytics beacons, tickers) usually has its content by then. It becomes `timeout` only when the snapshot is also empty.
7. **Snapshot:** `executeJavaScriptInIsolatedWorld(999, [{ code: 'document.documentElement.outerHTML' }])`, capped at `MAX_HTML_BYTES` (truncated on the renderer side with `slice`). Record `finalUrl = webContents.getURL()`.
8. Run section 5 (Readability in the worker) and sections 6 and 7 on the snapshot, with `via = 'render'`.

### 8.4 Teardown (always, in `finally`)

1. Detach the slot's `RenderState` so the session listeners cancel any late request (the listeners themselves stay installed for the pooled session).
2. `if (!win.isDestroyed()) { win.webContents.stop(); win.destroy(); }`. Use `destroy()`, not `close()`, so no `beforeunload` can block it.
3. `await ses.clearStorageData(); await ses.clearCache();`. This is required, not a precaution: the partition is reused by the next render in this slot.
4. Drop the window reference and release the render semaphore (and with it the slot). If step 3 throws, the slot's session is marked dirty and is not handed out again for this process lifetime; the pool shrinks, and with zero usable slots renders return `render-failed`.
5. If `ctx.signal` aborted, steps 1 to 4 still run and then `AbortError` is rethrown.

A watchdog timer set to `RENDER_TIMEOUT_MS + 5 000` destroys the window unconditionally, in case a hung `executeJavaScript` promise prevents normal teardown. The e2e suite asserts that no hidden windows remain after a job (`BrowserWindow.getAllWindows()` count check, section 12).

### 8.5 Concurrency

At most `MAX_RENDER_WINDOWS` (2) hidden windows exist app-wide, enforced by a semaphore shared by all jobs. The permit carries the pooled partition slot index (8.1). Queued renders wait, and their wait time counts against their URL budget.

## 9. Politeness

The app fetches only what the user explicitly gave it. It is a reader, not a crawler.

| Rule | Value |
| --- | --- |
| Link following | None. Only the given URL, its redirects, and the subresources the render window loads |
| Global concurrent HTTP fetches | `MAX_GLOBAL_FETCHES` = 4 |
| Concurrent fetches per host | 1 (a queue per registrable domain, computed with the public suffix list via the `tldts` package) |
| Minimum spacing per host | `HOST_MIN_INTERVAL_MS` = 1 000 ms between request starts (HTTP stage and render stage both count) |
| `429` / `503` with `Retry-After` of 10 s or less | One retry after the indicated delay, within budget |
| `429` / `503` otherwise | No retry. `429` → `rate-limited` ("site is rate limiting requests"). `503` → `http-server-error` |
| `5xx` other | One retry after 2 s for idempotent GET, then `http-server-error` |
| Network errors (reset, DNS temp failure) | One retry after 1 s |
| `robots.txt` | **Not consulted.** Each fetch is a single user-initiated page view equivalent to opening it in a browser, and robots.txt governs automated crawling. This decision is recorded here so it is not reopened. |
| Caching | Per-job dedupe only (section 3 step 3). No cross-job HTTP cache (the fetch session is in-memory and cleared per job) |
| Identity | The UA includes the `ELI5Learner/<version>` token (4.3) |

## 10. Errors and skip reasons

`errors.ts` maps each `FetchSkipCode` to the human-readable reason stored in `SkippedSource.reason`. That text appears in the document's References section and in `meta.json` (PRD "Error handling"). The strings are short, plain, and non-technical.

| Code | Trigger | Reason text |
| --- | --- | --- |
| `invalid-url` | Parse failure | "not a valid web address" |
| `blocked-scheme` | Non-http(s) scheme | "only http and https links are supported" |
| `credentials-in-url` | Userinfo present | "links with embedded credentials are not supported" |
| `dns-failure` | `ENOTFOUND`, `ERR_NAME_NOT_RESOLVED` | "site could not be found" |
| `connect-failure` | Refused/reset after retry | "could not connect to the site" |
| `tls-error` | Certificate or TLS failure | "site's security certificate was not trusted" |
| `timeout` | Any timeout in 4.5 / 8.3, or budget exhausted | "fetch timed out" |
| `too-large` | Size caps | "file was too large (limit N MB)" |
| `too-many-redirects` | 4.4 rule 1 | "too many redirects" |
| `http-not-found` | 404 | "page not found (404)" |
| `http-gone` | 410 | "page no longer exists (410)" |
| `http-client-error` | Other 4xx after the render attempt | "site refused the request (HTTP n)" |
| `http-server-error` | 5xx after retry | "site returned an error (HTTP n)" |
| `rate-limited` | 429 | "site is rate limiting requests" |
| `login-required` | Section 7 | "page required login" (or "network proxy requires sign-in" for 407) |
| `paywall` | Section 7.2 rule 4 | "page required a subscription" |
| `unsupported-type` | Routing table | "unsupported content type (mime)" |
| `empty-content` | Both lanes empty | "page had no readable content" |
| `render-failed` | Render crash, challenge, load failure | "page could not be rendered" / "site blocked automated access" |
| `blocked-private-address` | 4.4 rule 4 | "link redirected to a private network address" |

The full technical detail (status, Chromium error code, timings, lane) goes to the main-process debug log only. It is never written into the document. URLs are logged without query strings, because query strings can contain tokens.

## 11. Constants

All values live in `src/main/fetch/constants.ts`. They are not user settings. Enterprise values that differ (such as proxy configuration) arrive through HOOK-FETCH-01, not by editing these.

| Constant | Value |
| --- | --- |
| `URL_TOTAL_BUDGET_MS` | 75 000 |
| `HTTP_HEADERS_TIMEOUT_MS` / `HTTP_BODY_TIMEOUT_MS` / `HTTP_STALL_TIMEOUT_MS` | 15 000 / 45 000 / 15 000 |
| `MAX_REDIRECTS` | 10 |
| `MAX_HTML_BYTES` / `MIN_HTML_PREFIX_BYTES` | 5 MiB / 1 MiB |
| `MAX_TEXT_BYTES` / `MAX_IMAGE_BYTES` / `MAX_DOCUMENT_BYTES` | 5 / 20 / 50 MiB |
| `READABILITY_WORKERS` / `READABILITY_TIMEOUT_MS` | 2 / 20 000 |
| `RENDER_MIN_BUDGET_MS` / `RENDER_TIMEOUT_MS` | 15 000 / 20 000 |
| `RENDER_MIN_WAIT_MS` / `RENDER_QUIET_MS` / `RENDER_POLL_MS` | 1 500 / 1 000 / 250 |
| `MAX_RENDER_WINDOWS` | 2 |
| `MAX_GLOBAL_FETCHES` / `HOST_MIN_INTERVAL_MS` | 4 / 1 000 |

Dormant enterprise settings keys read by `network.ts` only when the overlay is loaded (values defined under HOOK-FETCH-01, delivered through HOOK-CFG-01): `fetch.network.proxyMode`, `fetch.network.pacUrl`, `fetch.network.proxyRules`, `fetch.network.bypassList`, `fetch.network.extraCaPaths`. The public build ignores them.

## 12. Security notes

- Fetched HTML is never executed in the main process or in any worker (jsdom without scripts). It runs only inside the sandboxed, context-isolated, preload-free hidden window.
- The hidden window cannot reach the app. It has no preload, no `window.eli5`, no IPC, a separate partition, and denied permissions.
- The article HTML handed onward is sanitized (5.3). The output-document builder (07) sanitizes again before anything reaches a generated document, and fetched markup is never inlined verbatim.
- No credentials are sent, stored, or prompted for (PRD "Public build"). The one exception is the proxy authentication path under HOOK-FETCH-01, and even there the app does not hold proxy credentials.
- Fetched content goes to the LLM provider as text or images. That is the product's purpose, and it is covered in [12-configuration-security.md](12-configuration-security.md).

## 13. Testing

Fixtures are served by a local HTTP test server (`test/fixtures/web/`, started per suite on `127.0.0.1:0`). Since the fixture server is user-typed loopback, the private-address guard permits it, while a separate fixture asserts that a redirect *into* loopback from a non-loopback host is blocked. That test fakes DNS by injecting a resolver into `http.ts`. See [13-testing-quality.md](13-testing-quality.md).

| Fixture | Expected outcome |
| --- | --- |
| Static news-style article | `article` via `http`, title/byline present, R1 |
| SPA shell (`<div id="root"></div>` + script that renders 3 000 chars after 300 ms) | `article` via `render` |
| SPA that renders nothing | `skipped: empty-content` |
| 401 with `WWW-Authenticate` | `skipped: login-required`, no render attempted |
| 302 → `/login?returnUrl=…` | `skipped: login-required`, `finalUrl` is the login URL |
| Page with password form only | `skipped: login-required` |
| Paywall teaser (400 chars + "subscribe to continue") | `skipped: paywall` |
| PDF with `Content-Type: application/octet-stream` | `binary`, mime sniffed `application/pdf` |
| PNG at URL | `binary` image |
| `.docx` via `Content-Disposition` filename | `binary`, correct filename |
| Latin-1 page with meta charset | Decoded correctly |
| Redirect loop | `skipped: too-many-redirects` |
| Slow body (stalls 20 s) | `skipped: timeout` |
| 60 MiB PDF (Content-Length) | `skipped: too-large`, body not read |
| 8 MiB HTML with article in first 200 KB | `article` from the truncated prefix |
| `video/mp4` | `skipped: unsupported-type` |
| 429 with `Retry-After: 1`, then 200 | `article`, exactly one retry |
| Challenge interstitial that never clears | `skipped: render-failed` ("site blocked automated access") |
| Page opening a popup, requesting geolocation, and triggering a download | All denied, `article` produced |
| Page that never goes network-idle | `article` via snapshot at hard timeout |
| Public page whose script issues `fetch`/`img`/iframe requests to `127.0.0.1` and a `.local` host | Those requests cancelled (fixture server sees no hit), `article` produced |
| 50 sequential renders | Only `eli5-render-0`/`-1` sessions exist, and cookies/storage are empty between renders |
| 302 hop observed | `ClientRequest` `'redirect'` event exposes `redirectUrl` on the pinned Electron version |

Unit tests (Vitest, pure Node) cover the worker, `detect.ts`, `login-wall.ts`, sniffing, charset decoding, URL validation, and politeness scheduling (with fake timers). Render-window tests run under Playwright `_electron` against the fixture server. After each render test they assert `BrowserWindow.getAllWindows().length` equals the app's visible-window count (no leaked hidden windows) and that the render partition's cookie store is empty.

## Acceptance criteria

- [ ] `fetchUrl` returns `article`, `binary`, or `skipped` for every input and never throws except on abort. Skips carry a reason string from section 10.
- [ ] Only http/https URLs are fetched. URLs with embedded credentials are skipped. No `Authorization` or app-set cookies are ever sent.
- [ ] Redirects are followed manually, up to 10. A redirect into a private address is blocked, while a user-typed private address is allowed.
- [ ] Timeouts and size caps match section 4.5. An oversized `Content-Length` aborts before the body is read, and a truncated large HTML body still yields an article.
- [ ] PDFs, images, and office files at URLs are routed as `binary` to the 04 extractors, including when the server mislabels them (magic-byte sniffing).
- [ ] Readability runs in a worker thread with jsdom and no script execution. The main thread never parses fetched HTML. The worker is built via `?nodeWorker`, jsdom is external and a production dependency, and the packaged-app smoke test passes.
- [ ] HTTP uses `net.request` with `redirect: 'manual'` and `followRedirect()` per hop. Binary bodies are written under `ctx.stagingDir`, and the resolver (not this module) builds the `ResolvedSource`.
- [ ] The emptiness rules R1–R9 are implemented in `detect.ts` with thresholds in `constants.ts`. The fixture suite passes.
- [ ] Client-rendered and empty pages trigger the hidden-window fallback. It uses a pooled non-persistent partition (`eli5-render-0`/`-1`) cleared after every render, one combined listener per `webRequest` event that also blocks private-network requests from page scripts, `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, no preload, and `backgroundThrottling: false`.
- [ ] The hidden window denies permissions, popups, and downloads, blocks media/font/image requests, and probes and snapshots the DOM only through an isolated world. The only main-world script is the dialog no-op override.
- [ ] The wait strategy implements minimum wait, network idle, DOM quiet, early exit, and a 20 s hard timeout with snapshot-anyway.
- [ ] Teardown always destroys the window and clears the partition, including on abort and on a hung script (watchdog). No hidden windows leak (e2e-asserted).
- [ ] At most 2 render windows and 4 global fetches run at once, with 1 per host and 1 s spacing per host. `Retry-After` of 10 s or less is honored once. There is no link following.
- [ ] Login walls (401, `WWW-Authenticate`, login redirects, password forms) produce `skipped: login-required` without leaking credentials or prompting the user. Paywalls produce `paywall` or a partial article per 7.2.
- [ ] Network configuration goes through `configureSession()`, which in the public build uses the system proxy and trust store only (HOOK-FETCH-01).
- [ ] Login signatures and the `configureSession` override arrive via `registerLoginSignatures` and `registerNetworkConfigurator` (01 §6.2), and the public build ships an empty list (HOOK-FETCH-02). Lane routing before fetch is delegated to HOOK-SRC-03.
- [ ] Debug logs omit URL query strings. Generated documents contain only the friendly reason text.
