# Private hook registry

This file lists every private hook in the public technical spec. A private hook is a named point where the enterprise edition behaves differently from the public build, or where it needs organization-specific details that must not appear in this public repository. This registry does not define any hooks. Each hook is defined once, with a machine marker and a visible callout, in the spec file that owns its area. This file collects those definitions into one table, then gives each hook a short summary. Use it to see what a private binding has to supply and where the public contract for each hook is written. It implements the edition split in the PRD (public vs enterprise edition, "Edition differences", and the open item on enterprise publishing targets).

Related: [01-architecture.md](./01-architecture.md) · [02-llm-provider.md](./02-llm-provider.md) · [03-source-resolvers.md](./03-source-resolvers.md) · [05-url-fetching.md](./05-url-fetching.md) · [06-generation-pipeline.md](./06-generation-pipeline.md) · [07-output-document.md](./07-output-document.md) · [09-library-storage.md](./09-library-storage.md) · [10-publishing.md](./10-publishing.md) · [11-app-shell-ui.md](./11-app-shell-ui.md) · [12-configuration-security.md](./12-configuration-security.md) · [13-testing-quality.md](./13-testing-quality.md)

## 1. Mechanism

Four layers share one ID per hook:

1. **Public spec: generic definition.** The owning spec file defines each hook with the stable ID `HOOK-<AREA>-<NN>` (two-digit number). The areas are LLM, SRC, AUTH, FETCH, PUB, CFG, UI, DOC, LIB, PIPE and TEST. The definition is written in generic terms: "organization cloud drive", "document system", "observability system", "code host", "ticketing system" and "secret-scanning push tool". It states what the public build does and lists what a private binding has to fill in. Each definition is exactly:

   ```markdown
   <!-- hook:HOOK-<AREA>-<NN> -->
   > **Private hook · HOOK-<AREA>-<NN> · <Title>.** Public behavior: <...>. Private binding supplies: <...>. Binding lives in the private spec under "HOOK-<AREA>-<NN>".
   ```

   A spec file may define hooks only in its own area. When it refers to a hook from another area, it uses the ID in plain prose.

2. **Private spec: bindings.** The concrete values and decisions go in `spec/internal.md`. These include product names, hostnames, tool names, repositories and policies. The file is gitignored and never committed. It has one heading per hook, and each heading contains the hook ID (for example `## HOOK-PUB-01 · Organization cloud drive publisher`). The public spec never quotes or paraphrases what the private spec contains.

3. **Code: overlay registration.** `ELI5_EDITION=public|enterprise` is set at build time (default `public`). An enterprise build bundles the private overlay from `ELI5_OVERLAY_DIR` (default `./enterprise/`, gitignored). The overlay registers its implementations and policies into `src/main/editions/registry.ts` through the slot listed for each hook in the table below. The public build resolves the overlay to `overlay.none.ts`. Its capabilities are stubs that throw `NotAvailableInEdition`, and its policies are inert public defaults. The full registry API is in [01-architecture.md](./01-architecture.md) §6.2, and overlay loading is covered by HOOK-CFG-02.

4. **Verification: `scripts/check-spec-hooks.mjs`.** This script has no dependencies and requires Node 20 or later. It exits 1 on any failure.
   - **Public checks (always run):**
     - every `<!-- hook:ID -->` marker in `spec/*.md` and `spec/tech/*.md` is defined exactly once;
     - each marker is followed by a line starting `> **Private hook · ID ·`;
     - every hook ID mentioned anywhere in the public spec is defined;
     - this file lists every defined hook and no ID that is not defined.
   - **Private checks (only when `spec/internal.md` exists):**
     - every defined hook has a binding heading;
     - no binding heading names an undefined ID (an orphan);
     - no tracked or untracked-but-not-ignored file contains a term from the `## Public denylist` section of `spec/internal.md`. The denylist exists only in the private spec. The CI-side equivalent is HOOK-CFG-03.

   The canonical code-side index is the §6.1 hook index in [01-architecture.md](./01-architecture.md). A new hook must be added in three places: its owning file, this registry and that index.

## 2. Registry table

| ID | Title | Defined in | Registry slot | Public behavior (short) | Related config / env |
| --- | --- | --- | --- | --- | --- |
| HOOK-LLM-01 | Enterprise LLM backend (cloud-hosted model gateway) | [02-llm-provider.md](./02-llm-provider.md) | `registerLLMProvider('bedrock' \| gateway id)` | `bedrock` resolves to a stub that throws `NotAvailableInEdition` | `llm.provider`, `llm.model`, `llm.bedrock.region`, `llm.bedrock.profile`, `llm.bedrock.modelId` |
| HOOK-LLM-02 | Enterprise prompt policy and data handling | [02-llm-provider.md](./02-llm-provider.md) | `registerPromptPolicy` | no preamble, no overrides, pass-through filter | overlay prompt overrides dir |
| HOOK-AUTH-01 | MCP single sign-on lifecycle | [03-source-resolvers.md](./03-source-resolvers.md) | `registerAuth` | `AuthBroker` reports `unavailable`; no tokens ever | `sources.mcp.url` |
| HOOK-SRC-01 | MCP-brokered source resolver | [03-source-resolvers.md](./03-source-resolvers.md) | `registerSourceResolver` (id `mcp`) | `mcp.stub.ts`, never selected | `sources.mcp.*` |
| HOOK-SRC-02 | Ticket-link resolver | [03-source-resolvers.md](./03-source-resolvers.md) | `registerSourceResolver` (id `ticket`) | `ticket.stub.ts`, never selected; bare keys rejected | `sources.mcp.*` |
| HOOK-SRC-03 | Lane routing rules | [03-source-resolvers.md](./03-source-resolvers.md) | `registerLaneRules`, `registerLaneRouter` | empty rules; all http(s) goes to the web lane | via HOOK-CFG-01 when not compiled in |
| HOOK-SRC-04 | Handling of organization-sourced material on disk | [03-source-resolvers.md](./03-source-resolvers.md) | `registerStagingPolicy` | standard staging and retention (06 §9) | none |
| HOOK-SRC-05 | MCP connection and transport | [03-source-resolvers.md](./03-source-resolvers.md) | `registerMcpClient` | no MCP client; `sources.mcp.url` inert | `sources.mcp.url` |
| HOOK-FETCH-01 | Enterprise network configuration (proxy and TLS trust) | [05-url-fetching.md](./05-url-fetching.md) | `registerNetworkConfigurator` | system proxy, macOS trust store | `fetch.network.proxyMode`, `.pacUrl`, `.proxyRules`, `.bypassList`, `.extraCaPaths` |
| HOOK-FETCH-02 | Organization identity-provider and login-page signatures | [05-url-fetching.md](./05-url-fetching.md) | `registerLoginSignatures` | generic heuristics only | none |
| HOOK-PIPE-01 | Enterprise job policy | [06-generation-pipeline.md](./06-generation-pipeline.md) | `registerPipelinePolicy` | default concurrency, retry, retention | `pipeline.maxConcurrentJobs` |
| HOOK-DOC-01 | Organization document theme and branding | [07-output-document.md](./07-output-document.md) | `registerDocTheme` | neutral theme, "Made with ELI5 Learner" | none |
| HOOK-DOC-02 | References for organization sources | [07-output-document.md](./07-output-document.md) | `registerReferenceFormatter` | never produces `kind:'org'` | none |
| HOOK-LIB-01 | Enterprise library storage policy | [09-library-storage.md](./09-library-storage.md) | `registerLibraryPolicy` | library root per 09 §3.1, 30-day trash | library root setting |
| HOOK-LIB-02 | Merge eligibility across source sensitivity | [09-library-storage.md](./09-library-storage.md) | `registerMergeEligibility` | every pair eligible (`() => true`) | none |
| HOOK-PUB-01 | Organization cloud drive publisher | [10-publishing.md](./10-publishing.md) | `registerPublisher('drive')` | `drive.stub.ts`, `available:false` | `publish.drive.*` |
| HOOK-PUB-02 | Organization-wide sharing policy | [10-publishing.md](./10-publishing.md) | inside `drive` publisher; values via `registerSettingsExtension` | never shares | `publish.drive.*` |
| HOOK-PUB-03 | Git publisher: secret-scanning push tool integration and invocation mode | [10-publishing.md](./10-publishing.md) | `registerPublisher('git')`, `registerSecretScanner` | `git.stub.ts`; baseline scanner tested, no git spawned | `GitPublisherConfig.invocationMode`, `workspace`, `delegateTimeoutMs` |
| HOOK-PUB-04 | Publish targets: repo, branch, docs path, Pages URL pattern | [10-publishing.md](./10-publishing.md) | `registerSettingsExtension` (`publish.github.*`) | keys inert; `repo` unset | `publish.github.repo`, `.branch`, `.docsPath`, `.pagesUrlPattern`, `.waitForSite`; `readinessCheck` |
| HOOK-PUB-05 | Pre-publish content policy | [10-publishing.md](./10-publishing.md) | `registerPrePublishPolicy` | no-op; only git runs the scanner | none |
| HOOK-CFG-01 | Enterprise settings overlay (dormant keys and their values) | [12-configuration-security.md](./12-configuration-security.md) | `registerSettingsExtension` | dormant namespaces loose and inert | `llm.bedrock.*`, `sources.mcp.*`, `fetch.network.*`, `publish.drive.*`, `publish.github.*`, `enterprise.*` |
| HOOK-CFG-02 | Edition build flag and overlay loading | [01-architecture.md](./01-architecture.md) | build time, no runtime slot | `overlay.none.ts`; stubs only | env `ELI5_EDITION`, `ELI5_OVERLAY_DIR` |
| HOOK-CFG-03 | Public-tree leak check (organization term denylist) | [12-configuration-security.md](./12-configuration-security.md) | none (`scripts/check-hygiene.ts`) | deny-list scan skipped with a notice | env `ELI5_HYGIENE_DENYLIST` |
| HOOK-UI-01 | Enterprise-only UI (publish buttons, sign-in state) | [11-app-shell-ui.md](./11-app-shell-ui.md) | `enableUiFeatures` | no enterprise elements in the DOM | `enterprise.*` (Settings > Enterprise) |
| HOOK-UI-02 | Edition branding and help links | [11-app-shell-ui.md](./11-app-shell-ui.md) | `EditionOverlay.name` + `registerSettingsExtension` | "ELI5 Learner", "Public edition", public help links | `enterprise.*` |
| HOOK-UI-03 | Completion notification defaults | [11-app-shell-ui.md](./11-app-shell-ui.md) | `registerNotificationPolicy` + `registerSettingsExtension` | enabled; click opens the document in the app; `published-link` disabled in the UI; body shows the document title (`{hideTitle:false}`) | `notifications.enabled`, `notifications.clickAction`, `notifications.preferredLink` |
| HOOK-TEST-01 | Private overlay contract test suite | [13-testing-quality.md](./13-testing-quality.md) | none (overlay `contracts/` entry) | `contracts:enterprise` skipped with a notice | env `ELI5_OVERLAY_DIR` |
| HOOK-TEST-02 | Private fixture corpus and eval set | [13-testing-quality.md](./13-testing-quality.md) | none (private corpus) | synthetic fixtures and public evals only | none |

There are 28 hooks. Their pre-assigned IDs are LLM-01, AUTH-01, SRC-01 to SRC-03, PUB-01 to PUB-04, CFG-01, CFG-02 and UI-01. The owning files added the rest in their own areas.

## 3. Hooks by area

The one-paragraph summaries below are not the contract. The callout in the defining file is authoritative. If a summary and a callout disagree, the callout wins, and this file should be fixed.

### LLM

**HOOK-LLM-01 · Enterprise LLM backend.** Defined in [02-llm-provider.md](./02-llm-provider.md).
- *Public:* `llm.provider = bedrock` resolves to `BedrockProvider`, a stub that throws `NotAvailableInEdition`. Claude and OpenAI with a user-supplied key are the only working backends.
- *Binding supplies:*
  - the real provider factory;
  - cloud account, region and model or inference-profile IDs;
  - how credentials are obtained (ambient credentials or a gateway token, never stored in settings JSON);
  - model limit rows;
  - structured-output and image-input mapping;
  - retry and rate-limit overrides for gateway quotas;
  - whether the direct providers are hidden in the enterprise build.

**HOOK-LLM-02 · Enterprise prompt policy and data handling.** Defined in [02-llm-provider.md](./02-llm-provider.md).
- *Public:* prompts come from the bundled prompts and skills folders, with no preamble. Content goes only to the provider the user configured.
- *Binding supplies:*
  - an organization system-prompt preamble;
  - an overlay prompt-overrides directory;
  - approved default skills;
  - a pre-send filter for content that must never reach the model;
  - token-usage logging and retention rules.

### AUTH

**HOOK-AUTH-01 · MCP single sign-on lifecycle.** Defined in [03-source-resolvers.md](./03-source-resolvers.md), which owns the AUTH area.
- *Public:* `AuthBroker` reports `unavailable`. Sign-in and sign-out throw `NotAvailableInEdition`. No auth UI is shown and no token is ever stored.
- *Binding supplies:*
  - the OAuth flow variant and where it runs;
  - the second-factor method;
  - how the app learns a session is established;
  - session lifetime, refresh behavior and expiry signalling;
  - how sign-out is propagated;
  - the account display string;
  - the `expired` and `error` messages;
  - confirmation that no token material crosses into the app process.
- *Related:* the token is held by the MCP server only (PRD, Authentication).

### SRC

**HOOK-SRC-01 · MCP-brokered source resolver.** Defined in [03-source-resolvers.md](./03-source-resolvers.md).
- *Public:* `mcp.stub.ts` is registered but never offered an input. If it is called, the chain records a `not-available-in-edition` skip.
- *Binding supplies:*
  - the MCP tool or resource names for each system (document system, org file store, observability system, code host);
  - resolving org file-store links, with folder-expansion limits;
  - version and permalink handling;
  - mapping each response to `SourceFormat` and payload;
  - whether each system's content is downloaded as a file or returned as text;
  - per-system size and timeout limits;
  - mapping MCP errors to `SkipCode`;
  - reporting of scope violations;
  - `ref` and `title` conventions.

**HOOK-SRC-02 · Ticket-link resolver.** Defined in [03-source-resolvers.md](./03-source-resolvers.md).
- *Public:* `ticket.stub.ts` is never selected. Ticket URLs follow the web lane and are usually skipped as login-required. Bare ticket keys are rejected as `not-a-url`.
- *Binding supplies:*
  - the ticketing system's URL shapes and bare-key pattern (fed into HOOK-SRC-03);
  - the MCP tools that read a ticket, its comments, links and attachments;
  - the field order in the Markdown rendering;
  - link-following depth;
  - attachment rules;
  - `ref` and `title` formatting.

**HOOK-SRC-03 · Lane routing rules.** Defined in [03-source-resolvers.md](./03-source-resolvers.md).
- *Public:* the rule list is empty, so every http(s) URL goes to the web lane, and `routeBare()` returns null.
- *Binding supplies:*
  - the ordered `LaneRule[]` of host globs, path prefixes and patterns for each host class;
  - which routes set `noWebFallback`;
  - bare-identifier patterns and the URLs they expand to;
  - hosts refused outright on the web lane;
  - how the rules are delivered: compiled into the overlay or through HOOK-CFG-01.

**HOOK-SRC-04 · Handling of organization-sourced material on disk.** Defined in [03-source-resolvers.md](./03-source-resolvers.md).
- *Public:* drafts, per-job input snapshots and downloads are staged under `<userData>` and kept according to 06 §9.
- *Binding supplies:*
  - whether MCP-delivered content may be staged to disk at all;
  - deletion timing and secure-deletion rules;
  - whether organization source locations may appear verbatim in `meta.json` and in the references;
  - any labelling required on documents built from organization material.
- *Related:* HOOK-PIPE-01 and HOOK-LIB-01.

**HOOK-SRC-05 · MCP connection and transport.** Defined in [03-source-resolvers.md](./03-source-resolvers.md).
- *Public:* no MCP client is created, and `sources.mcp.url` is inert.
- *Binding supplies:*
  - the transport: a remote HTTP/SSE endpoint, or a local stdio server that the app launches and supervises;
  - the connection lifecycle and reconnect or backoff policy;
  - confirmation that the SRC, PUB and AUTH capabilities share one session;
  - per-call timeouts and concurrency limits;
  - the capability or version check made on connect;
  - mapping server errors to `McpError.kind`.

### FETCH

**HOOK-FETCH-01 · Enterprise network configuration.** Defined in [05-url-fetching.md](./05-url-fetching.md).
- *Public:* proxy mode is `system`, and certificates are checked against the default macOS trust store. There is no custom CA handling, no proxy credentials and no verify override.
- *Binding supplies:*
  - proxy mode, PAC URL or proxy rules;
  - a bypass list;
  - extra CA certificates, or a policy that requires them in the system store;
  - proxy authentication without the app holding credentials;
  - the `fetch.network.*` values (through HOOK-CFG-01).

**HOOK-FETCH-02 · Organization identity-provider and login-page signatures.** Defined in [05-url-fetching.md](./05-url-fetching.md).
- *Public:* only the generic HTTP, URL and DOM login-wall heuristics apply. A hit is always reported as `skipped: login-required`.
- *Binding supplies:*
  - identity-provider hostnames and URL patterns;
  - organization login-page DOM markers;
  - whether a hit on an unrouted host should tell the user to add a routing rule (HOOK-SRC-03).

### PIPE

**HOOK-PIPE-01 · Enterprise job policy.** Defined in [06-generation-pipeline.md](./06-generation-pipeline.md).
- *Public:* the defaults are create-lane concurrency of 1 to 3, the retry policy and timeouts from 02 §7, a 200 MB file-copy threshold, 7-day staging retention for failed jobs and 30-day job-record retention.
- *Binding supplies:*
  - overrides of these values sized to gateway quotas (HOOK-LLM-01);
  - stricter purge rules for MCP-lane content;
  - whether organization-sourced jobs resume after a crash or fail as `INTERRUPTED`.

### DOC

**HOOK-DOC-01 · Organization document theme and branding.** Defined in [07-output-document.md](./07-output-document.md).
- *Public:* a neutral default `DocTheme`, the footer "Made with ELI5 Learner", no logo and no classification label.
- *Binding supplies:*
  - token overrides for colors, fonts and optional embedded fonts, within a size cap;
  - a sanitized logo SVG;
  - a footer or classification label;
  - whether the theme applies to every document or only to published ones (HOOK-PUB-01, HOOK-PUB-03);
  - theme `id` and `version`.

**HOOK-DOC-02 · References for organization sources.** Defined in [07-output-document.md](./07-output-document.md).
- *Public:* reference kinds are `file`, `url`, `clipboard-text` and `clipboard-image` only. `kind='org'` is never produced.
- *Binding supplies:*
  - labels per system kind (`ReferenceEntry.orgKind` values);
  - whether and how canonical organization URLs are linked;
  - ticket ID display format;
  - fields that must be omitted from documents shared organization-wide.

### LIB

**HOOK-LIB-01 · Enterprise library storage policy.** Defined in [09-library-storage.md](./09-library-storage.md).
- *Public:* the library root is resolved as in 09 §3.1. Files are protected only by the user account and OS disk encryption, and trash is kept for 30 days.
- *Binding supplies:*
  - whether the library root is pinned or restricted;
  - at-rest protection for organization-sourced documents;
  - trash and staging retention;
  - whether `meta.json` may store source URLs or only redacted forms.

**HOOK-LIB-02 · Merge eligibility across source sensitivity.** Defined in [09-library-storage.md](./09-library-storage.md).
- *Public:* eligibility depends on similarity alone, so any pair may be suggested.
- *Binding supplies:*
  - exclusion rules based on source provenance (MCP-lane vs public web) or publish state;
  - the user-facing wording when a pair is excluded.

### PUB

**HOOK-PUB-01 · Organization cloud drive publisher.** Defined in [10-publishing.md](./10-publishing.md).
- *Public:* `drive` reports `available:false` and throws `NotAvailableInEdition('publisher:drive', 'HOOK-PUB-01')`. It makes no network calls and has no UI.
- *Binding supplies:*
  - the drive product and the MCP tool names and argument shapes for upload, replace and lookup;
  - the root location and folder naming;
  - `publish.drive.*` values;
  - how a stable share link is obtained, and its URL shape;
  - size and rate limits;
  - behavior when the target folder was moved or deleted;
  - error mapping to `PublishErrorCode`.

**HOOK-PUB-02 · Organization-wide sharing policy.** Defined in [10-publishing.md](./10-publishing.md).
- *Public:* nothing is ever shared. The contract requires sharing to be applied after upload. If sharing fails, the file stays owner-only and the user sees a warning.
- *Binding supplies:*
  - the exact permission applied (organization link, group or domain);
  - whether edit or comment rights are ever granted;
  - link expiry;
  - classification labels;
  - blocking of external sharing;
  - the `PublishResult.sharing.description` wording;
  - any audit or approval step.

**HOOK-PUB-03 · Git publisher: secret-scanning push tool integration and invocation mode.** Defined in [10-publishing.md](./10-publishing.md).
- *Public:* `git` is a stub. The baseline secret scanner and the explicit file set are real, tested code, but no git process is ever spawned.
- *Binding supplies:*
  - the organization's push tool: how it is located and version-checked, and whether it replaces or adds to the baseline scanner;
  - the `invocationMode` (`direct`, `push-tool` or `delegate`) and how the tool fits into the push;
  - the tool or delegate command and argument vector, invoked through an `execFile`-safe wrapper;
  - exit codes and output parsing into `SecretFinding`;
  - the delegate manifest and result formats, and `delegateTimeoutMs`;
  - the clone workspace;
  - working-copy hazard handling (stash, rewrite, clean);
  - the fallback when the tool is missing;
  - required versions;
  - the host credential mechanism, described without secrets;
  - the remediation text for `E_PUBLISH_SECRET_FOUND`.

**HOOK-PUB-04 · Publish targets.** Defined in [10-publishing.md](./10-publishing.md).
- *Public:* the `publish.github.*` keys are inert. The defaults are `repo: ""` (shown as "Not configured"), `branch: "main"`, `docsPath: "docs"` and `pagesUrlPattern: "https://{owner}.github.io/{repo}/{path}/{slug}/"`.
- *Binding supplies:*
  - the repositories, branch and docs layout;
  - the Pages URL pattern, including any custom domain;
  - site index ownership;
  - the unpublish and retention policy;
  - Pages privacy;
  - `readinessCheck` (`none`, `redirect-is-deployed` or `code-host-status`).
- *Related:* this hook closes the PRD open item on enterprise publishing targets.

**HOOK-PUB-05 · Pre-publish content policy.** Defined in [10-publishing.md](./10-publishing.md).
- *Public:* `runPublish` step 5 is a no-op. The secret scanner is the only content gate, and only the git publisher runs it.
- *Binding supplies:*
  - whether scanning also runs before drive publishing;
  - classification banners injected into the published copy only;
  - rules that forbid publishing certain source kinds (for example HOOK-SRC-01 material) to certain targets;
  - the wording shown when a publish is blocked.

### CFG

**HOOK-CFG-01 · Enterprise settings overlay.** Defined in [12-configuration-security.md](./12-configuration-security.md).
- *Public:* the dormant namespaces `llm.bedrock.*`, `sources.mcp.*`, `fetch.network.*`, `publish.drive.*`, `publish.github.*` and `enterprise.*` are loose, preserved and inert. There are no managed keys and no `ext.*` Keychain accounts.
- *Binding supplies:*
  - the strict schema for each namespace;
  - organization defaults, non-secret only;
  - managed or locked keys, where their values come from and their precedence;
  - any `ext.*` Keychain accounts and the justification for each;
  - migrations;
  - which enterprise keys Settings shows (with HOOK-UI-01).
- *Related:* API keys always stay in the Keychain under service "ELI5 Learner".

**HOOK-CFG-02 · Edition build flag and overlay loading.** Defined in [01-architecture.md](./01-architecture.md).
- *Public:* `ELI5_EDITION` defaults to `public`, and the overlay import resolves to `overlay.none.ts`.
- *Binding supplies:*
  - the overlay location and how it is obtained;
  - the entry file and `EditionOverlay.name`;
  - the capability list, mapped to every hook in this registry;
  - extra runtime dependencies;
  - enterprise packaging identity (app ID, signing, notarization source, distribution channel);
  - the enterprise CI build job.

**HOOK-CFG-03 · Public-tree leak check.** Defined in [12-configuration-security.md](./12-configuration-security.md).
- *Public:* the deny-list step of `scripts/check-hygiene.ts` reads `ELI5_HYGIENE_DENYLIST`, which holds either inline terms or an `@path` to a file. When the variable is unset, the step passes with the notice `deny-list scan skipped`. The public repo contains no denylist.
- *Binding supplies:*
  - the denylist contents;
  - where the list is stored and how CI obtains it;
  - whether it also runs as a local pre-commit hook;
  - allowed exceptions.
- *Related:* `scripts/check-spec-hooks.mjs` runs a matching local check against the `## Public denylist` section of `spec/internal.md`.

### UI

**HOOK-UI-01 · Enterprise-only UI.** Defined in [11-app-shell-ui.md](./11-app-shell-ui.md).
- *Public:* `EditionInfo.uiFeatures` is empty, so the DOM has no publish buttons, sign-in indicator or Settings > Enterprise section. A forged IPC call fails with `E_NOT_AVAILABLE_IN_EDITION`.
- *Binding supplies:*
  - the enabled `UiFeature` flags;
  - publish-target labels, order and icon hints;
  - confirmation steps, for example before an organization-wide share (HOOK-PUB-02);
  - how the returned link is presented;
  - sign-in indicator copy;
  - URL field placeholder and hint text for bare identifiers (HOOK-SRC-02, HOOK-SRC-03);
  - Settings > Enterprise fields (HOOK-CFG-01).

**HOOK-UI-02 · Edition branding and help links.** Defined in [11-app-shell-ui.md](./11-app-shell-ui.md).
- *Public:* About shows "ELI5 Learner", the version and "Public edition", with public help links.
- *Binding supplies:*
  - the edition display name;
  - internal help and support URLs and their labels;
  - any extra About text.
- *Related:* all values arrive through the settings extension (HOOK-CFG-01), never as renderer constants.

**HOOK-UI-03 · Completion notification defaults.** Defined in [11-app-shell-ui.md](./11-app-shell-ui.md).
- *Public:* a native macOS notification is posted when a create job finishes (`notifications.enabled` defaults to true). Clicking it opens the document in the app (`notifications.clickAction = 'app'`). The `published-link` option is shown disabled in Settings because no remote publisher is registered; a hand-set value falls back to `app`. The body shows the document title (`notificationPolicy()` returns `{hideTitle:false}`).
- *Binding supplies:*
  - the organization default for `notifications.clickAction` and `notifications.preferredLink` (for example preferring the organization cloud drive share link);
  - whether these keys are managed or locked;
  - whether the body must hide the document title and use a generic "Your document is ready";
  - any organization rule about notifications for documents built from organization sources (HOOK-SRC-01).
- *Related:* key defaults and managed state arrive through `registerSettingsExtension` (HOOK-CFG-01); the body policy arrives through the single-slot `registerNotificationPolicy(p: NotificationPolicy)`. Links resolve from the drive publisher (HOOK-PUB-01) and the git publisher's Pages link (HOOK-PUB-04).

### TEST

**HOOK-TEST-01 · Private overlay contract test suite.** Defined in [13-testing-quality.md](./13-testing-quality.md).
- *Public:* the `contracts:enterprise` project is skipped with a notice when no overlay is present.
- *Binding supplies:*
  - the overlay `contracts/` entry that calls each `describe*Contract` with the real implementations;
  - sandbox tenants and accounts, and which systems are live and which are replayed;
  - credential provisioning in private CI;
  - enterprise-specific assertions;
  - the private CI workflow and schedule;
  - release pass criteria.

**HOOK-TEST-02 · Private fixture corpus and eval set.** Defined in [13-testing-quality.md](./13-testing-quality.md).
- *Public:* only synthetic fixtures (`provenance: 'synthetic'`) and public evals.
- *Binding supplies:*
  - the location and access control of the private corpus;
  - private eval cases and `mustCover` facts;
  - which judge backend may see private material;
  - output retention;
  - enterprise quality thresholds.

## 4. Consistency notes

Fixes made while building this registry:

- **Undefined hook.** [01-architecture.md](./01-architecture.md) listed a third TEST hook for the denylist scan, but no file defined it. The denylist scan is HOOK-CFG-03, so the row was removed and the range references were narrowed to HOOK-TEST-01 and HOOK-TEST-02.
- **Missing index entry.** HOOK-SRC-05 was defined in 03 but missing from the 01 §6.1 hook index, the edition table, the HOOK-CFG-02 list and the registry API. It was added to all four, with `registerMcpClient(c: McpClient)` and the lookup `mcp()`.
- **Denylist name mismatch.** HOOK-CFG-03 was described inconsistently. The 01 index used env `ELI5_DENYLIST_FILE`, and 13 used the script name `check-public-tree.ts`. Both now match the definition in 12: `scripts/check-hygiene.ts` with `ELI5_HYGIENE_DENYLIST`.
- **Marker check.** No marker is duplicated or malformed. Every marker is followed directly by its callout, and every file defines hooks only in its own area (03 owns AUTH).

## Acceptance criteria

- [ ] Every `<!-- hook:ID -->` marker in `spec/tech/*.md` has a row in §2 and a summary in §3, and this file names no ID that is not defined.
- [ ] Each row's "Defined in" link points to the file that holds the marker.
- [ ] Each row's registry slot matches the §6.1 hook index in 01-architecture.md.
- [ ] `node scripts/check-spec-hooks.mjs` reports no public-side errors. Examples in this file use the placeholder `HOOK-<AREA>-<NN>` so they are not counted as markers.
- [ ] With `spec/internal.md` present, the same script reports one binding heading per hook and no orphans.
- [ ] This file contains no organization names, internal system names or internal hostnames, and uses the generic vocabulary only.
- [ ] Any new hook is added to its owning file, this registry and the 01 §6.1 index in the same change.
