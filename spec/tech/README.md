# ELI5 Learner engineering spec

The [product requirements document](../ELI5%20Learner%20Product%20Requirements%20Document.md) says
**what** ELI5 Learner does and why. The files in this folder say **how** to build v1: the Electron
process model, module boundaries, types, IPC channels, algorithms, error handling, and acceptance
criteria for each module. Each file owns one slice of `src/` and cites the PRD sections it
implements. When a file here and the PRD disagree on behavior, the PRD wins and the file gets fixed;
when two files here disagree on a boundary, [01-architecture.md](01-architecture.md) wins. This spec
is public and generic. Anything specific to an organization is left as a named private hook (see
[hooks.md](hooks.md)).

## Reading order

Read 01 first. After that, read the file for the module you are building, plus 12 and 13.

| # | File | What it covers |
| --- | --- | --- |
| 01 | [01-architecture.md](01-architecture.md) | Process model, module map and import rules, end-to-end data flow, the full IPC contract, the edition model and capability registry, dependencies, build and packaging. |
| 02 | [02-llm-provider.md](02-llm-provider.md) | The `LLMProvider` interface, Claude and OpenAI implementations, retries and rate limits, long-input chunking, the prompt catalogue, `DocumentDraft` schema, and the Bedrock stub. |
| 03 | [03-source-resolvers.md](03-source-resolvers.md) | Drops, pastes and URLs become `ResolvedSource` / `SkippedSource`: the resolver chain, format sniffing, lane routing, and the MCP and ticket stubs. |
| 04 | [04-extraction.md](04-extraction.md) | Per-format extractors (Office, PDF, images, spreadsheets, text) that produce `ExtractedContent` / `ContentBlock`, plus limits, isolation, and prompt serialization. |
| 05 | [05-url-fetching.md](05-url-fetching.md) | Public web lane: HTTP fetch, Readability, detection of empty or client-rendered pages, the hidden-window fallback, login walls, politeness. |
| 06 | [06-generation-pipeline.md](06-generation-pipeline.md) | `Job` / `JobStatus` state machine, the queue and concurrency, stages, the one-line status strings, failure handling, crash recovery. |
| 07 | [07-output-document.md](07-output-document.md) | `DocumentModel` / `Tab` / `Section`, `SectionId` rules, the self-contained `index.html`, visual components, glossary, references, themes, print. |
| 08 | [08-interactive-reading.md](08-interactive-reading.md) | Selection action menu, the document-to-app bridge, regenerate in place, and adding and closing Section ELI5 tabs. |
| 09 | [09-library-storage.md](09-library-storage.md) | Library root, `catalog.json` and `meta.json` schemas, slugs, atomic writes and locking, the Library API, merge suggestions. |
| 10 | [10-publishing.md](10-publishing.md) | `Publisher` interface, the v1 local publisher, cloud drive and git publisher stubs, the secret scanner, link surfacing, the Pages help page. |
| 11 | [11-app-shell-ui.md](11-app-shell-ui.md) | Window lifecycle, the menu bar item, main window layout, settings screen, shortcuts, empty states, accessibility, and gating of enterprise-only UI. |
| 12 | [12-configuration-security.md](12-configuration-security.md) | Settings schema and storage, Keychain API keys, dormant keys, the Electron security baseline, document sandboxing, privacy, and logging without content. |
| 13 | [13-testing-quality.md](13-testing-quality.md) | Test pyramid (Vitest, Playwright `_electron`), synthetic fixtures, LLM fakes and cassettes, document validity checks, evals, the edition matrix, CI. |
| — | [hooks.md](hooks.md) | Every private hook, its owning file, its registry slot, and its public default. |

## Build order for v1

The milestones are ordered so that several builders can work at the same time. Each module is built
against the types and IPC constants from M0 and tested with the fakes from 13, not against other
modules' real code.

| Milestone | Modules (spec) | Can run in parallel? | Done when |
| --- | --- | --- | --- |
| **M0 Foundations** | Scaffold and build scripts (01 §7–8); `src/preload/contract.ts` with every channel constant, `IpcResult`, and shared types (01 §5); `src/main/editions/` registry, `NotAvailableInEdition`, `overlay.none.ts` (01 §6); `src/main/config/` schema, store, Keychain (12 §2–6); security baseline and redacting logger (12 §7, §11); test harness, LLM fake, fixture scaffolding, import-boundary lint (13 §2, §6) | Mostly one builder, or two that split config/security from the harness. Everything else depends on it. | `npm run typecheck`, `lint`, and `test` pass on an empty app that boots in the public edition |
| **M1 Core modules** | LLM provider (02); source resolvers and stubs (03); extraction and extract worker (04); URL fetching (05); document model, renderer and `src/doc-runtime/` (07); library storage, without merge (09 §1–9) | **Yes, all six at once.** Each registers its public implementations and stubs in the registry and passes its own contract suite (13 §10). | Each module's acceptance criteria pass with fakes. No module imports another module's internals. |
| **M1b Shell skeleton** | Window lifecycle, Tray, layout, and routes (11 §3–6), wired to the preload API and running against stubbed handlers | Yes, alongside M1 | App opens, hides on close, quits from Tray, shows empty states |
| **M2 Pipeline integration** | Job queue, stages, status lines, persistence (06); IPC handlers in `src/main/ipc/` for jobs, library and settings | Depends on M1. One builder owns 06, and another can own the IPC handlers and the shell status area. | A dropped file or URL becomes a saved `index.html` plus a catalog entry, with the fake LLM and with a real key |
| **M3 Features on top** | Interactive reading (08); merge suggestions (09 §10); local publisher and link surfacing (10 §5.1, §7); settings screen and shortcuts (11 §7, §9); completion notifications and the Settings > Notifications section (11 §14, wired by bootstrap to the 06 queue) | **Yes, five at once** | Each file's acceptance criteria pass |
| **M4 Hardening and release** | E2E suites, document validity checks, evals and baselines, the edition matrix, public-repo hygiene checks, CI workflow, unsigned dmg packaging (13 §7–12, 01 §8.3) | Split by suite | Every required CI job is green on the public build with no overlay present |

Stubs (`bedrock.stub.ts`, `mcp.stub.ts`, `ticket.stub.ts`, `drive.stub.ts`, `git.stub.ts`) and the
public default for each policy slot ship in the same milestone as the module that owns them, never
later.

## Editions and private hooks

- There are two editions, `public` and `enterprise`, and one code base. The edition is fixed at build time by `ELI5_EDITION` (compiled into `__ELI5_EDITION__`). It is never a runtime setting.
- Editions differ only in what gets registered in the capability registry. The public build registers public implementations, stubs, and neutral policy defaults.
- The enterprise build bundles a private overlay (from `ELI5_OVERLAY_DIR`, default `./enterprise/`) that replaces stubs and defaults before `registry.freeze()`. The public tree never branches on organization details.
- Each place a private detail plugs in is a named hook `HOOK-<AREA>-<NN>`. In the spec text it is marked with `<!-- hook:HOOK-ID -->` followed by a "Private hook" callout that states the public behavior and what the private binding supplies.
- A stub throws `NotAvailableInEdition(capability, hookId, edition)`, which maps to `E_NOT_AVAILABLE_IN_EDITION`. The private spec binds each hook ID. See [hooks.md](hooks.md) and 01 §6.

## Conventions

| Topic | Convention | Defined in |
| --- | --- | --- |
| Type names | PascalCase nouns for the data that passes between modules: `SourceInput` → `ResolvedSource` / `SkippedSource` → `ExtractedContent` (`ContentBlock`) → `DocumentDraft` → `DocumentModel` (`Tab`, `Section`) → `CatalogEntry` / `DocumentMeta`. Seams are interfaces: `LLMProvider`, `SourceResolver`, `Extractor`, `Publisher`, `AuthBroker`, `EditionOverlay`. Persisted and IPC shapes have zod schemas, and the TS type is `z.infer` of the schema. | 01 §3, owning file |
| Module entry | Each `src/main/<module>/` exposes only `index.ts`. Types shared with renderers live only in `src/preload/contract.ts`. There is no `src/shared/`. | 01 §3 |
| `SectionId` | `sec-<tabKey>-<8 lowercase hex>`, for example `sec-indepth-3f9a1c2e`. Tab keys are `indepth`, `eli5`, and `sx<6 hex>` for Section ELI5 tabs. IDs are minted by `mintSectionId`, never by the model. They are stable across regenerate, merge and re-render, and never reused. | 07 §4 |
| IPC naming | `eli5:<area>:<action>` constants in `contract.ts`, with no string literals anywhere else. Invokes return `IpcResult<T>` and never throw. Payloads are validated with zod in main. Errors use `E_*` `IpcErrorCode` values. Events are exposed as `on<Event>(cb): Unsubscribe`. | 01 §5 |
| Config keys | Dotted lowercase camelCase paths (`llm.provider`, `pipeline.maxConcurrentJobs`, `publish.local.dir`), all declared in `src/main/config/schema.ts` with a default. Dormant namespaces (`llm.bedrock`, `sources.mcp`, `fetch.network`, `publish.drive`, `publish.github`, `enterprise`) are accepted and preserved but have no effect in the public build. Secrets never go in settings; they live in the Keychain. | 12 §3 |
| Hook IDs | `HOOK-<AREA>-<NN>`, where AREA is one of LLM, AUTH, SRC, FETCH, PIPE, DOC, LIB, PUB, CFG, UI, TEST. A spec that adds a hook also adds a row to the index in 01 §6.1 and to [hooks.md](hooks.md). | 01 §6.1 |
| Section numbering | Files are `NN-topic.md`. Cross-references use the form "07 §4.2". Every file ends with an "Acceptance criteria" checklist. | all |
