# Configuration and security

This file specifies how ELI5 Learner stores and validates its settings, where API keys live, and the security and privacy rules every process and module must follow. It covers the zod settings schema in `src/main/config/`, the storage location, defaults, validation and migration, the dormant enterprise keys, Keychain storage of API keys (and why the chosen library is used), the Electron security baseline (process flags, CSP, navigation and window-open guards, permission handling, fuses), isolation of the hidden fetch window, sandboxing of generated documents in the viewer, the privacy model (source material leaves the machine only for the chosen LLM), logging that never records content, and repository hygiene for a public repo with a private overlay. It implements PRD "Configuration, scope, and open items" (Settings v1, dormant keys), "Build editions and swap seams" (public build runs with nothing but an API key, enterprise UI hidden by flag), "Fetching strategy" (public lane has no authentication; the enterprise edition never lets the app handle credentials), "Output document" (self-contained `index.html` viewable in any browser), and "Library, storage, and merge suggestions" (documents stay local).

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) · [05-url-fetching.md](05-url-fetching.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [07-output-document.md](07-output-document.md) · [08-interactive-reading.md](08-interactive-reading.md) · [09-library-storage.md](09-library-storage.md) · [10-publishing.md](10-publishing.md) · [11-app-shell-ui.md](11-app-shell-ui.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Principles

1. **Secrets never touch settings JSON, logs, IPC responses, or renderers.** API keys live in the macOS Keychain. The renderer can only write a key, clear it, or ask whether one exists.
2. **One schema, one source of truth.** `src/main/config/schema.ts` declares every settings key with zod. Types, defaults, validation, and IPC payload checks are all derived from it.
3. **A bad setting never stops the app.** An invalid value falls back to its default, is logged by key path, and is reported in Settings. A corrupt file is moved aside, not deleted.
4. **Every renderer is untrusted.** This includes the app UI, the document viewer, and above all the hidden fetch window. Main validates every IPC payload and grants no permissions by default.
5. **Generated documents are untrusted content.** They are produced by an LLM from third-party material and could carry injected script. They are rendered sandboxed with no network, and they reach the app only through a narrow, slug-bound bridge.
6. **Source material leaves the machine only to the chosen LLM endpoint.** The only other outbound requests are the public URLs the user entered. There is no telemetry.

## 2. Module layout

```
src/main/config/
  schema.ts          zod schema, Settings type, DEFAULTS, DORMANT_NAMESPACES
  store.ts           load / validate / migrate / atomic save, change events
  migrations.ts      schemaVersion N -> N+1 steps
  extension.ts       SettingsExtension composition (HOOK-CFG-01)
  keystore.ts        KeyStore interface, KeychainKeyStore, MemoryKeyStore (tests)
  guards.ts          secret-in-settings detection, key format checks
  ipc.ts             eli5:settings:* handlers
  edition.ts         re-exports __ELI5_EDITION__ (flag defined in 01, HOOK-CFG-02)
src/main/security/
  harden.ts          app-wide web-contents guards, permission handlers, CSP headers
  csp.ts             CSP strings for app renderer and document viewer
  log.ts             structured logger with field allowlist and redaction
```

`config/index.ts` exports `getSettings()`, `updateSettings()`, `onSettingsChanged()`, `keyStore`, `Settings`, `SettingsExtension`. `security/index.ts` exports `hardenApp()`, `log`, `redact()`.

## 3. Settings schema

### 3.1 Types

```ts
// src/main/config/schema.ts
import { z } from 'zod';

/** Closed set (shared conventions). The enterprise backend registers under 'bedrock' (HOOK-LLM-01). */
export const ProviderId = z.enum(['claude', 'openai', 'bedrock']);
export type ProviderId = z.infer<typeof ProviderId>;

/** Dormant namespaces: accepted, preserved, inert in the public build. */
const Dormant = z.record(z.string(), z.unknown()).default({});

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  llm: z.object({
    provider: ProviderId.default('claude'),
    model: z.string().trim().min(1).max(200).nullable().default(null), // null = provider default (02)
    maxOutputTokens: z.number().int().min(1024).max(128000).default(32000),
    timeoutMs: z.number().int().min(10_000).max(1_800_000).default(1_800_000),
    maxConcurrency: z.number().int().min(1).max(6).default(2),
    bedrock: Dormant,                                   // HOOK-LLM-01
  }).strict().default({}),
  glossary: z.object({
    defaultOn: z.boolean().default(true),
  }).strict().default({}),
  sources: z.object({
    mcp: z.object({
      url: z.string().url().refine(u => u.startsWith('https://'), 'https only').nullable().default(null),
    }).passthrough().default({}),                        // HOOK-SRC-01, HOOK-AUTH-01
  }).strict().default({}),
  fetch: z.object({
    network: Dormant,                                    // HOOK-FETCH-01 (05)
  }).passthrough().default({}),
  pipeline: z.object({
    maxConcurrentJobs: z.number().int().min(1).max(3).default(1),  // 06 §4.1
  }).strict().default({}),
  publish: z.object({
    local: z.object({
      dir: z.string().default('~/Documents/ELI5 Learner'),         // 10 §5.1
      revealAfter: z.boolean().default(true),
    }).strict().default({}),
    drive: Dormant,                                      // HOOK-PUB-01, HOOK-PUB-02
    github: Dormant,                                     // HOOK-PUB-03, HOOK-PUB-04
  }).passthrough().default({}),
  logging: z.object({
    level: z.enum(['info', 'debug']).default('info'),
  }).strict().default({}),
  notifications: z.object({                              // 11 (completion notification)
    enabled: z.boolean().default(true),
    clickAction: z.enum(['app', 'published-link']).default('app'),
    preferredLink: z.enum(['most-recent', 'drive', 'site']).default('most-recent'),
  }).strict().prefault({}),                            // prefault: inner defaults apply when the key is absent (zod 4)
  enterprise: Dormant,                                   // reserved for SettingsExtension (HOOK-CFG-01)
}).strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export const DEFAULTS: Settings = SettingsSchema.parse({});

export const DORMANT_NAMESPACES = [
  'llm.bedrock', 'sources.mcp', 'fetch.network', 'publish.drive', 'publish.github', 'enterprise',
] as const;
```

Sibling modules own the **meaning** of their keys (02 for `llm.*`, 05 for `fetch.*`, 06 for `pipeline.*`, 10 for `publish.*`, 11 for `notifications.*`), but declare them only here. A module that needs a new key adds it to `schema.ts` in the same change, with a default, and lists it in its own spec.

### 3.2 Key reference

| Key | Type | Default | Owner | Public build |
| --- | --- | --- | --- | --- |
| `schemaVersion` | `1` | `1` | 12 | Migration marker |
| `llm.provider` | `'claude' \| 'openai' \| 'bedrock'` | `'claude'` | 02 | Closed enum. `bedrock` is selectable only when the registry reports it available; hand-set in a public build it fails at generation with `NotAvailableInEdition` (02 §13). The enterprise backend must register under the `bedrock` ID (HOOK-LLM-01); an overlay cannot add other selectable IDs, because §8.2 rule 1 forbids changing a public key's type |
| `llm.model` | `string \| null` | `null` | 02 | `null` resolves to `DEFAULT_MODELS[provider]` |
| `llm.maxOutputTokens` | int | 32000 | 02 | Clamped to model limit by 02 |
| `llm.timeoutMs` | int | 1800000 | 02 | Per attempt total cap; idle timeout 120 s |
| `llm.maxConcurrency` | int 1..6 | 2 | 02 | |
| `llm.bedrock.*` | record | `{}` | 02 | Dormant |
| `glossary.defaultOn` | boolean | `true` | 06, 11 | Initial state of the per-job "Explain domain specific terms" toggle |
| `sources.mcp.url` | https URL or null | `null` | 03 | Dormant; ignored by `mcp.stub.ts` |
| `fetch.network.*` | record | `{}` | 05 | Dormant (HOOK-FETCH-01) |
| `pipeline.maxConcurrentJobs` | int 1..3 | 1 | 06 | Create-lane slots (06 §4.1) |
| `publish.local.dir` | string | `'~/Documents/ELI5 Learner'` | 10 | Local publisher target folder (10 §5.1); `~` expanded by 10 |
| `publish.local.revealAfter` | boolean | `true` | 10 | Reveal in Finder after a local publish (10 §5.1) |
| `publish.drive.*` | record | `{}` | 10 | Dormant |
| `publish.github.*` | record | `{}` | 10 | Dormant |
| `logging.level` | `'info' \| 'debug'` | `'info'` | 12 | `debug` adds timing and IDs only, never content |
| `notifications.enabled` | boolean | `true` | 11 | Post a native macOS notification when a create job reaches `done` (11). Not dormant |
| `notifications.clickAction` | `'app' \| 'published-link'` | `'app'` | 11 | `'app'` opens the document in the viewer. `'published-link'` opens its published link in the default browser via §7.5, resolved at click time, and falls back to `'app'` when no remote published link exists. With no remote publisher in the public build, the UI disables `'published-link'`; `set` still accepts it and the fallback applies |
| `notifications.preferredLink` | `'most-recent' \| 'drive' \| 'site'` | `'most-recent'` | 11 | Which link `'published-link'` opens: `'drive'` = organization cloud drive share link (PublishLink kind `share`), `'site'` = GitHub Pages link (kind `site`). Local exports (`file:` links) never count. An overlay may set defaults or lock these keys (HOOK-UI-03 via HOOK-CFG-01) |
| `enterprise.*` | record | `{}` | overlay | Dormant; only a `SettingsExtension` may give it a schema |

There is deliberately **no** settings key for the edition. The edition is a build-time constant (`__ELI5_EDITION__`, 01 §6.1, HOOK-CFG-02), so editing settings cannot enable enterprise code paths.

Effective model: `effectiveModel(s) = s.llm.model ?? DEFAULT_MODELS[s.llm.provider]`. Changing `llm.provider` in the UI leaves `llm.model` as it is only when the user typed a custom model for the new provider; otherwise the UI sends `llm.model: null` along with the provider change (11).

### 3.3 Dormant keys

Dormant keys exist so that the public build can read an enterprise-shaped settings file without loss (PRD "Settings (v1)": "Dormant, documented keys").

- **Accepted:** any JSON value under a dormant namespace passes validation in the public build, except `sources.mcp.url`, which keeps its URL check so typos show up early.
- **Preserved:** `store.ts` writes dormant subtrees back unchanged, including keys it does not understand.
- **Inert:** no public code path reads them. The stubs (`bedrock.stub.ts`, `mcp.stub.ts`, `drive.stub.ts`, `git.stub.ts`) throw `NotAvailableInEdition` whatever these values are.
- **Hidden:** the public Settings UI does not render them (HOOK-UI-01 controls enterprise UI). `eli5:settings:describe` reports them with `dormant: true`.
- **Secret-free:** the secret guard (§5.4) also covers dormant subtrees. A token pasted into `publish.github.*` is rejected like any other.

## 4. Storage, loading, and saving

### 4.1 Location

| Item | Path | Mode |
| --- | --- | --- |
| Settings | `<userData>/settings.json` | `0600` |
| Corrupt backups | `<userData>/settings.corrupt-<ISO8601>.json` | `0600`, keep newest 3 |
| Logs | `<userData>/logs/main.log` (+ `.1`, `.2`) | `0600` |
| Job staging | `<userData>/jobs/` (06) | `0700` dir |
| API keys | macOS Keychain, service `ELI5 Learner` | Keychain ACL |
| Documents | library root: gitignored `<repo>/.library` in dev, `<userData>/docs` packaged, or `ELI5_LIBRARY_DIR` (09 §3.1) | per 09 |

`userData` is `app.getPath('userData')`, which resolves to `~/Library/Application Support/ELI5 Learner/` in a packaged build. Dev builds call `app.setPath('userData', …/ELI5 Learner (dev))` before `ready` so dev runs never touch a real profile. E2E tests set `ELI5_USER_DATA_DIR` to a temp directory; only unpackaged builds honor it (`!app.isPackaged`).

### 4.2 Load algorithm

Runs in bootstrap step 1 (01 §6.3), before the registry is built, and again in step 4 with the extended schema.

1. Read `settings.json`. If it is missing, use `{}` and log `settings.created`.
2. `JSON.parse`. On failure, rename the file to `settings.corrupt-<ts>.json`, use `{}`, and set `loadIssue = 'corrupt'`.
3. If `raw.schemaVersion` is below the current version, apply `migrations.ts` steps in order. If it is higher (a newer app wrote it), load in **read-compatible mode**: validate what is known, keep the rest, and do not save until the user changes a setting. Then save with the unknown top-level keys dropped and log their names.
4. Run the secret guard (§5.4) on the raw object. Any matching value is removed and its path logged. The value itself is never logged.
5. Validate **leaf by leaf**: `SettingsSchema.safeParse(raw)`. For each issue, delete the offending path from `raw` and re-parse. The default then fills it in. Repeat at most 50 times, then fall back to `DEFAULTS` plus preserved dormant subtrees. Record each reset path in `loadIssues`.
6. Apply the extension layers (§8.2): `defaults < extension.defaults < user file < extension.managed`.
7. Freeze the result (`Object.freeze`, deep) and publish it as the current snapshot.
8. If steps 2 to 5 changed anything, save once (§4.3) so the file on disk is normalized.

`loadIssues` is exposed through `eli5:settings:describe` and shown as one non-modal line in Settings ("2 settings were reset to defaults"). It is never a dialog.

### 4.3 Save algorithm

1. Serialize writes through an in-process mutex. The single-instance lock (01) rules out a second process.
2. Write only the **user layer**, not the merged snapshot. Values that equal a managed or extension default are not written.
3. Write `settings.json.tmp` with mode `0600`, `fsync`, then `rename` over `settings.json`.
4. If the write fails (`ENOSPC`, `EACCES`), keep the in-memory snapshot, return `E_SETTINGS_IO`, and log the errno. Do not retry in a loop.

The app reads the file only at startup. External edits made while the app runs are overwritten by the next in-app change and are otherwise picked up on restart. This is documented in the README rather than handled with a file watcher.

### 4.4 Change propagation

```ts
export function onSettingsChanged(cb: (next: Settings, changed: string[]) => void): () => void;
```

`changed` lists dotted leaf paths. Consumers include the LLM provider cache (02 §5 step 4, which invalidates on `llm.*`), the job queue (a running job keeps its snapshot, 06), and the renderer via `eli5:settings:changed`.

## 5. IPC surface

The four `eli5:settings:*` channels in the 01 §5.2 table are owned here. This file adds two more.

| Channel | Dir | Request | Response |
| --- | --- | --- | --- |
| `eli5:settings:get` | R→M | — | `Settings` (merged snapshot; contains no secrets by construction) |
| `eli5:settings:set` | R→M | `DeepPartial<Settings>` | `Settings`, or `IpcError` `E_SETTINGS_INVALID` / `E_SETTINGS_LOCKED` / `E_SECRET_IN_SETTINGS` / `E_SETTINGS_IO` |
| `eli5:settings:set-api-key` | R→M | `{provider: 'claude' \| 'openai'; key: string}` | `void`, or `E_KEY_FORMAT` / `E_KEYCHAIN_UNAVAILABLE` |
| `eli5:settings:has-api-key` | R→M | `{provider}` | `boolean` |
| `eli5:settings:clear-api-key` | R→M | `{provider}` | `void` |
| `eli5:settings:describe` | R→M | — | `SettingsDescription` |
| `eli5:settings:changed` | M→R | — | `{changed: string[]; settings: Settings}` |

```ts
export interface SettingsDescription {
  keys: { path: string; dormant: boolean; locked: boolean; source: 'default' | 'extension' | 'user' | 'managed' }[];
  loadIssues: { path: string; reason: 'invalid' | 'secret-removed' | 'unknown-dropped' | 'corrupt-file' }[];
  keychain: { available: boolean };
}
```

### 5.1 `set` algorithm

1. Validate the payload shape against `SettingsSchema.deepPartial()`. Unknown keys return `E_SETTINGS_INVALID` with `issues: {path, message}[]` and no partial apply.
2. Run the secret guard. A hit returns `E_SECRET_IN_SETTINGS` naming the path only.
3. If any path is locked by `extension.managed`, return `E_SETTINGS_LOCKED` with that path.
4. Deep-merge into the user layer, re-validate the full merged object, save, and emit the change event.
5. Return the new snapshot.

### 5.2 `set-api-key` algorithm

1. Require `provider ∈ {'claude','openai'}`. Other IDs, including `bedrock`, return `E_SETTINGS_INVALID`. Enterprise credentials are never entered into the app (HOOK-LLM-01, HOOK-AUTH-01).
2. Trim the key. Reject it with `E_KEY_FORMAT` if it is empty, longer than 512 characters, contains whitespace or control characters, or is not printable ASCII.
3. Prefix checks (`sk-ant-` for Claude, `sk-` for OpenAI) produce a **warning** in the response, not a rejection, because providers change their formats.
4. `keyStore.set(account(provider), key)`.
5. Emit an internal `keys-changed` event (02 invalidates its provider cache). Nothing is sent to the renderer except success.
6. Drop the local variable. The key is never echoed, logged, or kept in any main-process structure other than the provider client that 02 builds.

The Settings UI (11) uses `<input type="password" autocomplete="off" spellcheck="false">`, clears the field after a successful save, and afterwards shows only "Key saved" or "No key".

### 5.3 Edge cases

| Case | Behavior |
| --- | --- |
| Renderer sends `llm.apiKey` in `set` | `E_SETTINGS_INVALID` (unknown key) |
| Renderer sends `llm.provider: 'bedrock'` in the public build | Rejected with `E_SETTINGS_INVALID` "not available in this edition", because the registry reports it `available: false`. A hand-edited file is still accepted (dormant) and fails at generation time (02) |
| `set` during a running job | Applied. The running job keeps its snapshot (06) |
| Keychain locked, or the user clicked "Deny" on the access prompt | `E_KEYCHAIN_UNAVAILABLE`. `has-api-key` returns `false`, generation fails `LLM_AUTH` with "Keychain access denied. Check Settings" |
| Two `set` calls race | The mutex serializes them. The last write wins per leaf |

### 5.4 Secret guard

`guards.ts` exports `findSecrets(obj): string[]` (it returns paths only). A leaf counts as a secret when:

- its key name matches `/(api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|client[-_]?secret|bearer)/i`, or
- its string value matches a known credential shape: `^sk-(ant-)?[A-Za-z0-9_-]{20,}`, `^gh[pousr]_[A-Za-z0-9]{30,}`, `^github_pat_`, `^AKIA[0-9A-Z]{16}$`, `^xox[abpr]-`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`, a JWT (`^eyJ[\w-]+\.[\w-]+\.[\w-]+$`), or any string of 32 or more characters with Shannon entropy above 4.5 bits per character.

The guard runs on load, on `set`, and on every `SettingsExtension` layer. An overlay that tries to ship a secret in `defaults` or `managed` fails bootstrap in the enterprise build.

## 6. API keys in the Keychain

### 6.1 Library choice

| Option | Where the secret lives | Status | Native build | Verdict |
| --- | --- | --- | --- | --- |
| `keytar` | Keychain item | Archived upstream (2022), no maintained Electron prebuilds | node-gyp + `electron-rebuild` | Rejected: unmaintained native code in the most security-sensitive path |
| Electron `safeStorage` | Encrypted blob in a file under `userData`; only the wrapping key is in the Keychain (item "ELI5 Learner Safe Storage") | Maintained, built in | None | Viable, but the key is not a Keychain item under service `ELI5 Learner`, the blob travels with backups and profile copies, and any code in main can decrypt it without per-item ACL |
| **`@napi-rs/keyring`** | Keychain generic password, service `ELI5 Learner` | Maintained, keytar-compatible API | N-API prebuilt per-arch binaries (01 §8.3); no rebuild per Electron version | **Chosen** |

Justification: it meets the convention that keys are Keychain items under service `ELI5 Learner`. The secret is protected by the Keychain's per-item ACL, which is bound to the app's code signature. The user can inspect or delete the key in Keychain Access. N-API keeps the binary stable across Electron upgrades. `safeStorage` is the documented fallback if the native module ever fails to load; the fallback would store `<userData>/keys.enc` with the same `KeyStore` interface. It is not shipped in v1.

### 6.2 Interface

```ts
// src/main/config/keystore.ts
export type KeyAccount = 'llm.claude.apiKey' | 'llm.openai.apiKey' | `ext.${string}`;

export interface KeyStore {
  get(account: KeyAccount): Promise<string | null>;   // main only; never crosses IPC
  set(account: KeyAccount, secret: string): Promise<void>;
  delete(account: KeyAccount): Promise<boolean>;
  has(account: KeyAccount): Promise<boolean>;
  available(): Promise<boolean>;
}

export const KEYCHAIN_SERVICE = 'ELI5 Learner';
export const account = (p: 'claude' | 'openai'): KeyAccount => `llm.${p}.apiKey`;
```

- `KeychainKeyStore` wraps `new Entry(KEYCHAIN_SERVICE, account)`. It maps "item not found" to `null` or `false`, and maps all other errors to `KeychainUnavailable` (`E_KEYCHAIN_UNAVAILABLE`).
- `MemoryKeyStore` is used by unit and e2e tests. It is selected when `ELI5_KEYSTORE=memory` and `!app.isPackaged`, and a packaged build ignores the variable. E2E tests seed it from `ELI5_TEST_API_KEY_*` environment variables (13).
- `ext.*` accounts may be registered only by a `SettingsExtension` (HOOK-CFG-01). The public build uses only the two LLM accounts.
- `has()` is cached for 30 seconds and invalidated on `set` and `delete`, so the Settings screen does not trigger repeated Keychain prompts.
- Unsigned dev builds get a new code identity on every rebuild, so macOS may prompt for Keychain access again. This is expected, and the README documents it.

## 7. Electron security baseline

This section adds detail to the table in 01 §2.2. `hardenApp()` runs before `app.whenReady()` resolves, and before any window is created.

### 7.1 Per-window `webPreferences`

All windows set `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, `experimentalFeatures: false`, `webviewTag: false`, `navigateOnDragDrop: false`, `spellcheck: false`, and they set no `enableBlinkFeatures`. `app.enableSandbox()` is called at startup, so a missed flag still gets a sandbox.

### 7.2 App-wide guards (`web-contents-created`)

For every `webContents`:

1. `will-attach-webview`: `preventDefault()`.
2. `setWindowOpenHandler`: always `{action:'deny'}`. In the viewer, an `http(s)` target is passed to `shell.openExternal` after the URL check (§7.5). Other schemes are dropped.
3. `will-navigate` and `will-redirect`: allowed only when the target is on the contents' allowlist:
   - app renderer: the app URL origin only (01, 11);
   - viewer: the currently loaded `eli5doc://doc/<slug>/` document or `eli5doc://help/<file>.html` page, where fragment changes are allowed and loading another slug or help page is done only by main through `loadURL`;
   - fetch windows: any `http(s)` (05). `file:`, `eli5doc:`, `data:`, `javascript:`, and custom schemes are blocked in every window.
4. `will-frame-navigate`: apply the same allowlist to subframes. In the viewer, subframes are blocked outright.
5. `devtools-opened` in a packaged build: close DevTools immediately. `webContents.openDevTools` is never called in production code.
6. Every `ipcMain` handler runs `assertSender(event, surface)` before touching the payload, checking identity first and URL last:
   1. `event.sender.id` must equal the expected `webContents.id`: `viewerView.webContents.id` for `eli5:doc:*` channels, the main window's `webContents.id` for all other channels.
   2. `event.senderFrame` must be non-null and `event.senderFrame === event.sender.mainFrame`. A null `senderFrame` (the frame navigated away or was destroyed) is rejected.
   3. The frame URL scheme must match the surface: `eli5doc:` with host `doc` for the viewer, the app origin for the app renderer.
   A failure at any step returns `E_FORBIDDEN`, drops the message, and logs `ipc.rejected-sender` with the channel name only.

### 7.3 Permissions

`session.setPermissionRequestHandler` and `setPermissionCheckHandler` deny **everything** on the default session, the viewer session, and every fetch or render partition. That covers media, geolocation, notifications, clipboard-read, midi, hid, serial, usb, fullscreen, pointer-lock, openExternal, and idle-detection. The web `notifications` permission stays denied for **every** renderer session, including the app renderer, so neither generated documents nor the app UI can post notifications through the Web Notifications API. Only main posts native macOS notifications, through Electron's main-process `Notification` class in `src/main/shell/notifications.ts` (11). The macOS permission for those is granted by the user in System Settings, not by these handlers. Clipboard paste reaches the app through the renderer's native `paste` event and the clipboard resolver in main (03), so no clipboard permission is needed. `will-download` is cancelled on all sessions except when main starts a download itself.

### 7.4 Content Security Policy

CSP is delivered as a **response header** by the protocol handlers, so page content cannot loosen it. Generated documents also carry their own, stricter `<meta http-equiv>` policy, owned by 07 §6.2 (hash-based `script-src`, `img-src data:` only), so a policy applies when the file is opened in an external browser (§9). In the viewer both policies are enforced and the stricter one wins; 13's `csp` check verifies the meta tag against 07 §6.2.

| Surface | Policy |
| --- | --- |
| App renderer (prod) | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'` |
| App renderer (dev) | As prod, plus `http://localhost:*` and `ws://localhost:*` in `script-src` and `connect-src` for the Vite dev server. Selected only when `!app.isPackaged` |
| Document viewer (response header) | `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| Fetch / render windows | None injected. They load hostile public pages as-is, and isolation comes from §7.6 |

The viewer header policy is a stricter form of 01 §2.2's `default-src 'self' 'unsafe-inline' data:`. It allows inline script and style because documents are self-contained, and its `connect-src 'none'` blocks exfiltration from any injected script. The header is the outer bound for anything served over `eli5doc://` (including help pages, §7.7); each generated document narrows it further with the 07 §6.2 meta policy, which admits only the hashed `src/doc-runtime` script. The app renderer uses no inline script and no `eval`.

### 7.5 `shell.openExternal`

This is used only for `eli5:viewer:open-external`, for `setWindowOpenHandler` in the viewer, for published-link actions (10), and for a completion-notification click when `notifications.clickAction = 'published-link'` (11). A notification click that fails the checks below falls back to opening the document in the app.

1. Parse with `new URL()`. The scheme must be `http:` or `https:`, with no credentials in the URL, a host, and a length of 2048 characters or less.
2. Rate limit to 2 per second and 20 per minute per sender. Excess calls are dropped and logged.
3. Call `shell.openExternal(url, { activate: true })`. The app never opens `file:`, `smb:`, `x-apple.systempreferences:`, or other scheme handlers, with the one exception below.

**Exception: notification settings deep link.** `eli5:app:open-notification-settings` (no payload) opens the fixed main-process constant `x-apple.systempreferences:com.apple.Notifications-Settings.extension`, with the app's bundle id appended as the `id` query when available. The URL is never renderer-supplied or built from renderer input, so this is the only `x-apple.systempreferences:` URL the app opens. The call is subject to the same sender checks (§7.2) and rate limit (step 2).

### 7.6 Hidden fetch window isolation

05 §8 defines the mechanics. The security requirements are these:

- no preload, no `window.eli5`, and no IPC channel accepts its frames (§7.2 step 6);
- one of two pooled non-persistent partitions (`eli5-render-0`, `eli5-render-1`; 05 §8.1), separate from the in-memory fetch session `eli5-fetch` and from the app and viewer sessions; the window is destroyed after extraction and the slot's storage and cache are cleared before the slot is reused (Electron never frees a per-render partition's session, so a fresh partition per render would leak memory);
- all permissions, popups, downloads, and dialogs denied (§7.3), `show: false`, never focused or attached to the app window;
- the DOM is read only through an isolated world; the isolated-world snapshot (`outerHTML`, a plain string) goes to the Readability worker in main (05), and nothing else from the page crosses into main;
- the proxy and TLS trust configuration is the only enterprise difference (HOOK-FETCH-01). The public build never adds certificate-verify overrides (`setCertificateVerifyProc` is not called) and never ignores certificate errors (the `certificate-error` event keeps its default, which rejects).

### 7.7 Custom protocols

`eli5doc://` (01 §2.1) is set up in two steps:

1. **Privileges, at module load.** `protocol.registerSchemesAsPrivileged([{ scheme: 'eli5doc', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, bypassCSP: false, stream: false } }])` runs at the top level of the main entry module, before `app.whenReady()`. Electron ignores this call after `ready`.
2. **Handler, on the viewer session.** After `ready`, main registers the handler on the viewer's partition: `session.fromPartition('eli5-viewer').protocol.handle('eli5doc', handler)`. The global `protocol` module applies only to the default session, so registering there would leave the viewer with `ERR_UNKNOWN_URL_SCHEME`. The handler uses `protocol.handle` (returns a `Response`), not the deprecated `registerFileProtocol`. No other session registers the scheme, so the app renderer and fetch windows cannot load it.

The handler serves exactly two hosts:

| URL | Serves |
| --- | --- |
| `eli5doc://doc/<slug>/index.html` (and `eli5doc://doc/<slug>/`) | `<libraryRoot>/<slug>/index.html`, only when `<slug>` is a slug in the current catalog (09) |
| `eli5doc://help/<file>.html` | `resources/help/<file>.html` from the app bundle (help page, 10 §8, 11 About) |

Algorithm:

1. Parse the URL. The host must be `doc` or `help`; anything else returns 404.
2. Decode the path, and reject `..`, NUL, backslashes, empty or absolute segments, and any segment starting with `.` (dot-paths). Rejections return 404.
3. For `doc`: the path must be exactly `/<slug>/` or `/<slug>/index.html`, and `<slug>` must be listed in the catalog. Every other path under a document folder returns 404, including `meta.json`, staging files, and assets, because documents are self-contained (07). `meta.json` holds private data such as clarifying input (09, 10 §1) and is never served.
4. For `help`: the path must be a single segment naming an `.html` file in `resources/help/`.
5. Resolve the file with `path.resolve`, then `fs.realpath`, and require the result to start with the root (`libraryRoot + path.sep`, or the help root) so symlinks cannot escape it.
6. Respond with `Content-Type: text/html; charset=utf-8`, `Content-Security-Policy` (the viewer header policy, §7.4), `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`.

### 7.8 Electron fuses and packaging

Fuses are set in electron-builder's `afterPack` hook with `@electron/fuses`:

| Fuse | Value |
| --- | --- |
| `RunAsNode` | off |
| `EnableNodeOptionsEnvironmentVariable` | off |
| `EnableNodeCliInspectArguments` | off |
| `EnableEmbeddedAsarIntegrityValidation` | on |
| `OnlyLoadAppFromAsar` | on |
| `EnableCookieEncryption` | on |
| `GrantFileProtocolExtraPrivileges` | off |

The build is signed with the hardened runtime and has no `com.apple.security.cs.allow-unsigned-executable-memory` or `disable-library-validation` entitlements beyond what Electron needs (`allow-jit`). Notarization is required for release DMGs. The public signing identity comes from CI secrets. The enterprise packaging identity is part of HOOK-CFG-02.

## 8. Enterprise settings overlay

### 8.1 Hook

<!-- hook:HOOK-CFG-01 -->
> **Private hook · HOOK-CFG-01 · Enterprise settings overlay (dormant keys and their values).** Public behavior: `llm.bedrock.*`, `sources.mcp.*`, `fetch.network.*`, `publish.drive.*`, `publish.github.*`, and `enterprise.*` are loose, preserved, inert records; no `SettingsExtension` is registered; there are no organization defaults, no managed (locked) keys, and no `ext.*` Keychain accounts; Settings shows only the public keys. Private binding supplies: the strict zod schema for each dormant namespace (field names, types, allowed values); organization default values (non-secret only) for model gateway selection, the MCP server URL, publish targets, and network settings; which keys are managed and locked against user change; where managed values come from (bundled with the overlay, or read at startup from a managed-preferences source) and their precedence; any extra `ext.*` Keychain accounts and what non-MCP secret, if any, justifies each; migration steps from earlier enterprise settings versions; and which enterprise keys Settings displays, read-only or editable (together with HOOK-UI-01). Binding lives in the private spec under "HOOK-CFG-01".

### 8.2 `SettingsExtension` contract

The overlay registers this through `registry.registerSettingsExtension()` (01 §6.2) during bootstrap step 3.

```ts
// src/main/config/extension.ts
export type DormantNamespace = typeof DORMANT_NAMESPACES[number];

export interface SettingsExtension {
  id: string;                                                 // overlay name, for logs
  /** Replace the loose record schema of a dormant namespace with a strict one. */
  schemas?: Partial<Record<DormantNamespace, z.ZodTypeAny>>;
  /** Organization defaults: user may override. Non-secret values only. */
  defaults?: DeepPartial<Settings>;
  /** Managed values: override user values and lock the key paths. */
  managed?: DeepPartial<Settings> | (() => Promise<DeepPartial<Settings>>);
  /** Additional Keychain accounts, each must start with "ext.". */
  keychainAccounts?: `ext.${string}`[];
  /** enterprise-edition schemaVersion migrations for dormant namespaces. */
  migrate?(raw: Record<string, unknown>): Record<string, unknown>;
}
```

Composition rules:

1. An extension may give a schema only to `DORMANT_NAMESPACES`. It cannot change the type or default of a public key. It may put a public key in `defaults` or `managed`, for example to lock `llm.provider = 'bedrock'`.
2. Layer precedence, lowest to highest: `DEFAULTS` < `extension.defaults` < user file < `extension.managed`.
3. The secret guard (§5.4) runs on `defaults` and on the resolved `managed`. A hit is fatal in the enterprise build (01 §6.3).
4. A managed loader that throws or takes longer than 3 seconds is fatal in the enterprise build. Starting with unmanaged values could violate organization policy.
5. Only one extension may be registered. A second call throws.
6. Once the extension is applied, the store re-runs §4.2 steps 5 to 8 against the extended schema. Values that were loose in the public build and fail the strict schema are reset and reported in `loadIssues`.

## 9. Generated document sandboxing

Documents are built by 07 from a `DocumentModel`. The model returns structured JSON, not raw HTML (02). The document is still treated as hostile, because source material can contain prompt injection and the model output is untrusted.

| Layer | Control | Spec |
| --- | --- | --- |
| Build | Model-provided rich text passes an allowlist sanitizer: no `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<base>`, `<meta>`, event-handler attributes, `javascript:` or `data:text/html` URLs, or `style` containing `url()` / `expression`. The only scripts in a document are `src/doc-runtime` and builder-generated chart code from data, not from model-authored JS | 07 |
| File | The builder emits the document CSP of 07 §6.2 (hash-based `script-src`, `img-src data:`, `connect-src 'none'`) as the first `<head>` element in `<meta http-equiv="Content-Security-Policy">`, so a document opened in Chrome, Safari, or Edge also cannot make network requests | 07 §6.2 |
| Viewer | Separate sandboxed `WebContentsView`, its own session partition `eli5-viewer` (non-persistent) with the `eli5doc` handler registered on that session (§7.7), the viewer header CSP (§7.4) enforced on top of the document's meta CSP, no Node, no `file://`, navigation locked to its own document | 01, §7 |
| Bridge | `window.eli5Doc` exposes five functions. The preload fixes `slug` from the loaded URL, so a document cannot act on another document | 01 §5.3, 08 |
| Main | After the sender check (§7.2 step 6), every `eli5:doc:*` payload is validated with 08's zod schema, which this file does not redefine: `sectionId` must match 07's SectionId pattern (`^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$`) and exist in that document's `DocumentModel`, `selectionText` is at most 4000 characters, `note` is at most 200 characters, and `action` is from the enum (08 §3). Rate limit: 10 section actions per minute per document. Excess calls return `E_RATE_LIMITED` | 07, 08 |
| Output | A regenerated section goes through the same sanitizer before being written back | 07, 08 |

A document cannot read settings, keys, other documents, the library catalog, or the file system. The worst an injected script can do is change how its own document looks in the viewer, or ask main to regenerate its own sections within the rate limit.

## 10. Privacy

### 10.1 Data flow

| Data | Leaves the machine? | Destination |
| --- | --- | --- |
| Source content (file text, images, clipboard, fetched page text) | Yes, only in LLM requests | The one configured provider endpoint (02) |
| Public URLs entered by the user | Yes | That URL's host (05), with the Chromium user agent plus an `ELI5Learner/<version>` token (05 §4.3). No cookies, keys, or user identifiers are sent |
| Clarifying input, selection text, notes | Yes, only in LLM requests | Configured provider |
| Generated documents, catalog, meta | No | Local library (09). The public build has only the local publisher (10) |
| API keys | Only as the auth header to their own provider | Provider API |
| Settings, logs, job staging | No | `userData` |
| Completion notification (document title only) | No | macOS Notification Center on this Mac (11). An overlay may hide the title (HOOK-UI-03) |
| Telemetry, analytics, crash uploads | Never | None. `crashReporter` is not started, and there is no update checker in v1 |

Enforcement:

- A main-process `session.defaultSession.webRequest.onBeforeRequest` filter on the **app and viewer sessions** allows only `self` origins and the Vite dev server in dev. The app UI and viewer never make network calls themselves.
- LLM SDK clients are created only in `src/main/llm/` with base URLs from 02's provider table. The ESLint rule `no-restricted-imports` bans `node:http`, `node:https`, `undici`, and global `fetch` outside `src/main/llm/` and `src/main/fetch/`.
- The enterprise edition may add content rules before `send()` (HOOK-LLM-02) and routes authenticated sources through the MCP lane (HOOK-SRC-01, HOOK-SRC-03). The app never holds the organization credentials (HOOK-AUTH-01).

### 10.2 Retention

Job staging under `<userData>/jobs/` is deleted when a job reaches `done`. A `failed` job keeps its staging for up to 7 days so it can be retried, then it is deleted (06 §9.5). Extracted content is not cached across jobs. Clipboard images are written to staging only, never to `docs/`. Deleting a document removes its folder. Clearing an API key deletes the Keychain item.

## 11. Logging without content

### 11.1 Logger

`security/log.ts` writes JSON lines to `<userData>/logs/main.log`, rotates at 5 MB, and keeps 3 files. Each line is `{ts, level, event, ...fields}`. `event` is a dotted constant (`job.transition`, `llm.call`, `settings.reset`, `ipc.rejected-sender`, `notification.shown`, `notification.clicked`, `notification.fallback`).

```ts
export type LogFieldValue = string | number | boolean | null;
export interface Logger {
  info(event: string, fields?: Record<string, LogFieldValue>): void;
  warn(event: string, fields?: Record<string, LogFieldValue>): void;
  error(event: string, fields?: Record<string, LogFieldValue>, err?: unknown): void;
  debug(event: string, fields?: Record<string, LogFieldValue>): void;
}
```

### 11.2 Rules

1. **Field allowlist.** Only these field names are written: `jobId, taskId, slug, sectionId, tabKey, attempt, attempts, errorKind, from, to, status, step, code, kind, provider, model, latencyMs, durationMs, inputTokens, outputTokens, stopReason, count, bytes, sourceKind, sourceRef, path, channel, errno, hookId, capability, overlayName`. Other fields are dropped, and `log.unknown-field` is logged with the field name only (dev builds throw instead).
2. **String caps and redaction.** String values are truncated to 200 characters and passed through `redact()`, which replaces any credential shape from §5.4 with `[REDACTED]`.
3. **Source references.** `sourceRef` is a file **basename**, never a full path (full paths reveal the user name). For URLs it is `origin + pathname`, with query and fragment removed. Pasted items are logged as `clipboard:image` or `clipboard:text`.
4. **Errors.** `error()` logs `err.name`, `err.code`, and a stack trace with absolute paths rewritten to be relative to the app. It never logs `err.message` from LLM SDKs or HTTP bodies, because provider errors can echo request content. Those are mapped to `LLMError.kind` (02).
5. **Never logged:** source text, extracted content, images, prompts, model output, clarifying input, selection text, notes, document HTML, clipboard contents, API keys, settings values under dormant namespaces, or Keychain results. Document titles are model output and are never logged, including in notification events: `notification.shown`, `notification.clicked`, and `notification.fallback` carry only `slug` and `kind`.
6. `logging.level = 'debug'` adds timings and per-stage counts only. The dev-only LLM transcript flag (02 §15, `ELI5_DEBUG_LLM`) is the single exception to rule 5, and packaged builds ignore it.
7. Renderer `console-message` events are not forwarded to the log file.
8. Logs are never uploaded. "Reveal logs in Finder" in Settings is the only way to get at them.

## 12. Repository hygiene

The repository is public, so the rules below keep generated content, secrets, and private code out of it.

| Path / artifact | Rule |
| --- | --- |
| `docs/*` | Gitignored (learnings are built from possibly private material). Only `docs/.gitkeep`, `docs/.nojekyll`, `docs/index.html`, and `docs/sample/` are un-ignored for the public Pages site; `docs/sample/` must be built from public sources only |
| Enterprise overlay (`./enterprise/` or `$ELI5_OVERLAY_DIR`) | Must be gitignored (`/enterprise/`). The current `.gitignore` does not list it yet, and adding it is a v1 task. An overlay outside the repo tree is preferred |
| Private spec | The private spec and its hook bindings are gitignored and never linked from public files by path |
| `.env*` | Gitignored except `.env.example`, which lists variable names with empty values |
| `*.pem`, `*.p12`, `config.local.json` | Gitignored |
| Test fixtures | Synthetic or public-domain only. No real API keys. Tests use `MemoryKeyStore` with fake keys matching `sk-test-…` |
| Build output | `out/`, `dist/`, `release/`, `*.dmg` gitignored |

CI gates (run on every push and PR):

1. **Secret scan:** a generic secret scanner runs over the diff with public rules only. Any finding fails the build.
2. **Ignored-path check:** the build fails if any tracked file matches `docs/**` (other than the un-ignored exceptions), `enterprise/**`, or `.env` (other than `.env.example`).
3. **Overlay isolation:** in the public build, the bundle must not contain the string `@eli5/overlay` resolved to anything other than `overlay.none.ts` (checked from the Vite manifest).
4. **Public-tree term check:** described in HOOK-CFG-03. This is the only denylist check and the only hook for it. 13 §11 (`scripts/check-hygiene.ts`, CI job `hygiene`) runs it as its deny-list step and refers to HOOK-CFG-03 rather than defining its own hook; 01 §6.5 uses the same env var.

<!-- hook:HOOK-CFG-03 -->
> **Private hook · HOOK-CFG-03 · Public-tree leak check (organization term denylist).** Public behavior: the deny-list step of `scripts/check-hygiene.ts` (13 §11) scans tracked files and the built public bundle, case-insensitively, for terms from env `ELI5_HYGIENE_DENYLIST`. The variable holds either inline newline-separated terms or, when its value starts with `@`, a path to a file of newline-separated terms (`@/path/to/list`). When the variable is unset (forks, public contributors), the step passes with the notice `deny-list scan skipped`. The public repo contains no denylist, because the list itself would reveal private details. Private binding supplies: the denylist contents (organization names, internal system names, internal hostnames and URL patterns, internal tool names), where the file is stored and how CI obtains it (for example, as a CI secret), whether it also runs as a local pre-commit hook for maintainers, and the allowed exceptions. Binding lives in the private spec under "HOOK-CFG-03".

## 13. Error codes (config and security)

| Code | Raised by | User-facing text (11) |
| --- | --- | --- |
| `E_SETTINGS_INVALID` | `set` validation | "That value isn't valid: <path>" |
| `E_SETTINGS_LOCKED` | managed key | "This setting is managed by your organization" |
| `E_SECRET_IN_SETTINGS` | secret guard | "Keys and tokens go in the API key field, not in settings" |
| `E_SETTINGS_IO` | save | "Couldn't save settings (disk)" |
| `E_KEY_FORMAT` | `set-api-key` | "That doesn't look like an API key" |
| `E_KEYCHAIN_UNAVAILABLE` | keystore | "Keychain access denied. Unlock or allow access, then retry" |
| `E_NO_API_KEY` | registry `llm()` (01) | "Add an API key in Settings" |
| `E_RATE_LIMITED` | doc bridge / openExternal | none (logged only) |
| `E_FORBIDDEN` | IPC sender check (§7.2 step 6) | none (logged only) |

## 14. Testing notes

13 owns the suite. Security-specific cases:

- Unit: leaf-level validation fallback, the corrupt file moved aside, a newer `schemaVersion` loaded read-compatibly, dormant subtrees round-tripping byte-for-byte, the secret guard over every pattern and over dormant subtrees, extension precedence and locking, and redaction plus the field allowlist in the logger.
- E2E: every window's `webPreferences` asserted through `webContents.getLastWebPreferences()`. The viewer blocks `fetch('https://example.com')` (CSP violation, no request seen by the fixture server). `window.open` and top navigation from a document fail. A document cannot call `eli5:settings:*`. `eli5doc://doc/../settings.json`, `eli5doc://doc/<slug>/meta.json`, a dot-path, an uncatalogued slug, and a symlink escape all return 404. An IPC call from a destroyed or navigated frame (null `senderFrame`) returns `E_FORBIDDEN`. No `settings.json`, log file, or IPC response contains a seeded fake key.

## Acceptance criteria

- [ ] `src/main/config/schema.ts` is the only place settings keys are declared, and `Settings`, `DEFAULTS`, and IPC validation are all derived from it.
- [ ] Settings persist at `<userData>/settings.json` with mode `0600`, written atomically. Dev and test runs use a separate `userData`.
- [ ] One invalid value resets only that key to its default and is reported as a non-modal notice. A corrupt file is moved aside, and the app starts with defaults.
- [ ] Dormant namespaces (`llm.bedrock`, `sources.mcp`, `fetch.network`, `publish.drive`, `publish.github`, `enterprise`) round-trip unchanged, are hidden in the public UI, and have no effect in the public build.
- [ ] There is no settings key for the edition. Editing settings cannot enable enterprise code.
- [ ] API keys are stored as Keychain generic passwords (service `ELI5 Learner`, accounts `llm.claude.apiKey` and `llm.openai.apiKey`) via `@napi-rs/keyring`. They never appear in settings JSON, logs, IPC responses, or renderer memory after save.
- [ ] The secret guard rejects credential-shaped keys or values in `set`, on load, and in extension layers.
- [ ] Every window runs with `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`, and `webviewTag: false`. `app.enableSandbox()` is called.
- [ ] All permission requests are denied on all sessions. `window.open` is denied everywhere. Navigation is limited by per-surface allowlists.
- [ ] IPC handlers check sender `webContents.id`, require a non-null `senderFrame` equal to the sender's main frame, then check the URL scheme; failures return `E_FORBIDDEN`. `eli5:doc:*` is accepted only from the viewer.
- [ ] App and viewer response-header CSPs match §7.4. Generated documents carry the 07 §6.2 meta CSP; both are enforced in the viewer, and a document cannot make network requests in the viewer or in an external browser.
- [ ] `eli5doc` privileges are registered before `ready`, and the handler is registered with `protocol.handle` on the `eli5-viewer` session. It serves only `<slug>/index.html` for catalogued slugs and `help/<file>.html` from `resources/help/`, and returns 404 for everything else, including `meta.json`, dot-paths, traversal, and symlink escapes.
- [ ] The schema declares `pipeline.maxConcurrentJobs`, `publish.local.dir`, and `publish.local.revealAfter` with the defaults in §3.2.
- [ ] `shell.openExternal` is used only for validated `http(s)` URLs, with a rate limit.
- [ ] Hidden fetch windows have no preload, use unique non-persistent partitions, have all permissions denied, and are destroyed after use. No certificate override exists in the public build.
- [ ] The Electron fuses in §7.8 are set in the packaged app. Release builds are signed with the hardened runtime and notarized.
- [ ] Source content is sent only to the configured LLM endpoint. There is no telemetry, no crash upload, and no update check. Network imports are lint-restricted to `llm/` and `fetch/`.
- [ ] Logs use the field allowlist and redaction, record basenames and query-less URLs only, and never contain content, prompts, output, or keys.
- [ ] `.gitignore` covers `docs/*` (with the public exceptions), `/enterprise/`, `.env*`, and the private spec. The CI secret scan, ignored-path check, overlay-isolation check, and the HOOK-CFG-03 term check run on every push.
- [ ] The schema declares `notifications.enabled`, `notifications.clickAction`, and `notifications.preferredLink` with the defaults in §3.2; a `'published-link'` value with no remote published link behaves as `'app'`.
- [ ] The web `notifications` permission is denied on every renderer session; only main posts native notifications (11).
- [ ] The only `x-apple.systempreferences:` URL opened is the fixed notification-settings constant from `eli5:app:open-notification-settings` (§7.5); notification-click links go through the §7.5 `http(s)` checks.
- [ ] `notification.*` log events carry only `slug` and `kind`, never the document title.
- [ ] HOOK-CFG-01 (`SettingsExtension`) is implemented with the precedence, locking, and fail-closed rules in §8.2. The public build registers no extension.
