# TypeScript rewrite — toolchain & architecture

Status: implemented (2026-07-10). Supersedes the vanilla-JS extension. This
records *why* the toolchain and architecture are the way they are; the
day-to-day contract lives in [CLAUDE.md](../CLAUDE.md).

## Context

The extension had grown organically to 7 providers, 3 search modes,
embeddings and a capture/ingest pipeline — ~6,600 lines of vanilla ES modules
with every contract implicit in doc-comments, several of them inconsistent
(three ad-hoc message protocols; a `SyncResult` that differed between
success / partial / thrown; `collection`/`stats` accepting four input shapes
coerced deep in the DB layer; snake_case DB rows vs camelCase parser items;
one FTS-operator regex copy-pasted three times). The goal of the rewrite was
robust, compiler-enforced abstractions — not just types bolted on.

No data was preserved (single dev user), so the legacy migration chain was
dropped for a clean v1 schema, and the OPFS DB filename changed to
`linkosh-v1.sqlite` so a stale old-schema file can't collide.

## Toolchain decision: tsc-only, no bundler

Three options were weighed:

| Option | Verdict |
|---|---|
| **tsc per-file, 1:1 emit** | **Chosen.** Real TypeScript, no bundler. |
| esbuild/Vite bundle | Rejected — see below. |
| JSDoc + `checkJs`, no build | Rejected: the redesign leans on mapped types, keyed unions and template-literal keys that JSDoc expresses poorly. |

**Why not a bundler**, specifically for *this* codebase: two load-bearing
patterns are hostile to bundling, and both fail *silently and only live*.

1. The `chrome.scripting.executeScript` injected functions are serialized via
   `toString()` and re-parsed inside third-party pages. A bundler that renames
   an identifier, hoists a constant into module scope, or injects a helper
   produces a function that still typechecks, still builds, still passes every
   Node test — and breaks only inside the live site.
2. `new URL("../vendor/ort/", import.meta.url)` and the worker string-URLs
   (`chrome.runtime.getURL("workers/db.worker.js")`) resolve relative to the
   emitted file's location; bundlers relocate/hash chunks and quietly change
   what those resolve to.

tsc's costs are visible and constant (relative imports, no easy npm runtime
deps); a bundler's are invisible and episodic (a config drift that breaks
Instagram sync a month later). For a repo whose crown jewels are
toString-serialized functions and path-sensitive WASM loading, we took the
visible costs. The one scenario to revisit: wanting real npm runtime
dependencies.

### Linchpin compiler flags

- **`rewriteRelativeImportExtensions`** (TS 5.7+): source imports are written
  `./foo.ts` and rewritten to `./foo.js` at emit. This is the single trick
  that lets `node --test` run the `.ts` sources directly (Node ≥ 23.6 native
  type stripping) *and* tsc emit browser-ready ESM. Without it, "tests need no
  build" and "dist is native ESM" are mutually exclusive.
- **`erasableSyntaxOnly`** (TS 5.8): keeps Node's stripping representationally
  identical to tsc's emit — bans enums, namespaces, parameter properties.
- `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `allowImportingTsExtensions`,
  `importHelpers: false` (target ES2022 ⇒ tsc injects zero downlevel helpers).

### UI: vendored Preact + classic JSX

Preact is vendored as a single ESM file (+ hooks + hand-written `.d.ts`), same
treatment as sqlite3/transformers — the zero-npm-runtime-dependency property
holds. tsc's classic JSX transform (`jsxFactory: "h"`) is enabled only in the
`pages/` project; components `import { h, Fragment } from` the vendored path
explicitly, so the emit has no implicit runtime import to resolve. See
[src/vendor/preact/README.md](../src/vendor/preact/README.md) for provenance.

devDependencies are types-only: `typescript`, `@types/chrome`, `@types/node`.

## Layout: seven tsconfig projects = compiler-enforced layers

`src/` is organised by runtime context, and each project pins the minimal
`lib`/`types` for that context, so globals physically cannot leak across
container boundaries (chrome APIs can't reach `core/`, DOM can't reach
workers, the injected functions can't import anything). Every project emits
1:1 into `dist/` at its repo-relative position, so **`dist/src` is the
unpacked-extension root**.

| Project | Context | Holds |
|---|---|---|
| `src/core` | bare ES2022 | domain types, errors, fts, rpc, db (port+repos+search), parse, sync, ingest, ai orchestrator, prefs, format |
| `src/workers` | WebWorker | db.worker, ai.worker, embedders |
| `src/injected` | DOM, **no imports** | toString-serialized page functions |
| `src/ext` | WebWorker + chrome | background, providers + env port |
| `src/pages` | DOM + chrome + JSX | offscreen, popup/options Preact |
| `tsconfig.node.json` | node | build script, node-db adapters, CLI tools |
| `tests` | node | node:test suite |

The uniform `dist/` mirror is not cosmetic:
`rewriteRelativeImportExtensions` refuses cross-project imports whose
output-relative path differs from their input-relative path, so every
project's `outDir` must sit at its repo-relative position.

## The redesign in one screen

- **One typed RPC layer** (`core/rpc`) replaced three ad-hoc protocols:
  `Client<Api>` / `Handlers<Api>` over a small `Transport`, with
  implementations for chrome.runtime, worker postMessage, an HTTP dev
  transport and a direct in-process transport. Uniform
  `{ok,result}|{ok,error}` envelope; `ProviderError.needsLogin` is revived
  across every hop. Vectors (`Float32Array`) ride only the worker/postMessage
  transport — never chrome.runtime, whose JSON serialization mangles typed
  arrays — and that invariant is now visible in which client holds which API.
- **Ports** made previously-untestable code Node-testable: `SqlDatabase`
  (WASM oo1 for the worker+tests, node:sqlite for file tools), `ProviderEnv`
  (cookies/tabs/injection/cache/sleep — so provider pagination and self-repair
  run against a scripted fake), and a UI `Runtime` seam (popup/page/dev differ
  only in their Runtime impl).
- **Tightened domain model** (`core/types.ts`): `ParsedItem.collection` is
  always `string[]`, `stats` always `Record<string,string>` (coercion moved
  into parsers); rows leave the repos as one canonical camelCase `SavedItem`
  via SQL column aliases; `SyncReport` is a closed discriminated union
  (`ok | partial | failed`) and `syncProvider` never throws for provider
  failures.

## C4 model

### Level 1 — Context

A personal, local-first archive: syncs one user's saved items from 7 content
services into a local SQLite DB with full-text + semantic search. External
systems: the 7 services (cookie-authed unofficial APIs, read-only), optional
cloud embedding APIs (OpenAI/Gemini/Voyage, user keys), and the Hugging Face
CDN (one-time MiniLM weights; runtime is vendored, CSP forbids remote code).

### Level 2 — Containers

Each container has its own global scope; every arrow is the typed RPC layer
over a specific transport.

| # | Container | Tech | Responsibility |
|---|---|---|---|
| C1 | Background service worker | MV3 module SW, chrome, no DOM | composition root; hosts SyncEngine + BackgroundService; serves `BackgroundApi` |
| C2 | Offscreen document | DOM (SWs can't spawn workers) | spawns C3/C4; relays DB RPC; hosts AI orchestrator |
| C3 | DB worker | dedicated worker (sync OPFS handles) | SQLite WASM on OPFS SAH-pool; serves `DbWorkerApi` |
| C4 | AI worker | dedicated worker | embedding model lifecycle; serves `EmbedderApi` |
| C5 | UI pages | DOM + chrome | popup/page/options Preact; talk only to C1 |
| C6 | Injected scripts | run inside service pages | page-context fetches; no imports, no chrome |
| C7 | Node dev harness | Node ≥ 23.6 | tests, CLI tools, ux-server over HTTP |

Transports: C5→C1 and C1→C2 over chrome.runtime (JSON, no vectors); C2→C3 and
C2→C4 over postMessage (structured clone — the only hop vectors ride);
C7→BackgroundService over HTTP (same service object, different transport).

### Level 3 — Components (selected)

- C1: `background.ts` (≈wiring only) + `background-service.ts` (BackgroundApi,
  shared verbatim with the ux-server) + SyncEngine (`core/sync.ts`) +
  7 providers (`ext/providers/*`, `createProvider(env)`) + ChromePrefs.
- C2: two worker clients + a runtime relay + the AI orchestrator
  (search-mode router, single-flight backlog drainer, `rowText`).
- C3: SqlDatabase WASM adapter + `__sql`/`__db` debug handles + the core repos
  (items/raw/embeddings/search) + ingest.
- Shared `core`: types, errors, fts (single operator source), 7 pure parsers,
  rpc, prefs.

### Dynamic views

- **Sync (incremental):** UI → C1 → SyncEngine computes knownIds → provider
  fetches a page (direct or via C6) → `onPage` parses once and upserts (or
  archives) → returns a typed `PageOutcome` (cursor/hasNext/unseen) → provider
  loops until `unseen === 0` or `!hasNext` → `SyncReport` (never throws). See
  [sync-and-refresh.md](sync-and-refresh.md).
- **Hybrid search:** UI → C1 → C2 router: operator query / model-not-ready /
  zero-embedded ⇒ FTS fallback; else embed the query (C4) → `hybridSearch`
  (C3: FTS top-100 + cosine top-100 → RRF k=60) → items (no vectors) back.

## Migration

Big-bang, on the `semantic-search` branch, in eight gated phases (scaffold →
core DB → parsers → sync/ingest/orchestrator → RPC → extension shells →
Preact UI + dev harness → cleanup/docs), `npm test` green after each. 87 tests
pass against the shipped WASM build; the live-extension smoke checklist
(injected functions in real pages, OPFS boot, model download) is the only part
a browser must confirm.
