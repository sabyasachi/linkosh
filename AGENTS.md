# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension (strict TypeScript, zero runtime npm dependencies) that syncs a user's saved items from LinkedIn, Instagram, YouTube, Hacker News, X, Facebook and Substack into a local SQLite database and lists them in a popup and a full page. Everything after the network fetch — parsing, ingestion, DB, search ranking, embeddings orchestration — lives in a pure core that also runs under Node, where the test suite lives.

## Toolchain

- **tsc is the only build tool** — no bundler. Each tsconfig project emits 1:1 into `dist/` at its repo-relative position, so **`dist/src` is the unpacked-extension root** and relative imports, worker string-URLs and `import.meta.url` vendor resolution work unchanged at runtime. `scripts/build.ts` = clean → `tsc -b` → copy static assets → post-emit guards.
- **Source imports are written with `.ts` extensions** and rewritten to `.js` at emit (`rewriteRelativeImportExtensions`). That is what lets Node ≥ 23.6 run the same sources directly via native type stripping: tests and `src/node/` tools need **no build at all**.
- `erasableSyntaxOnly` keeps Node's stripping identical to tsc's emit — no enums, namespaces or parameter properties anywhere.
- Projects pin the minimal `lib`/`types` for their runtime context, so the compiler enforces container boundaries (chrome APIs physically can't leak into `core/`, DOM can't leak into workers, etc.). devDependencies are types-only (`typescript`, `@types/chrome`, `@types/node`).

## Develop / debug / test

- `npm test` — the primary gate: `tsc -b` (every project) + `node --test` running `tests/**/*.test.ts` from source against the *vendored SQLite WASM build itself* (loaded under Node via `wasmBinary`, see src/node/node-db.ts), so schema, FTS, vector math, parsers, ingest, sync, RPC and provider self-repair are exercised exactly as shipped.
- `npm run build` → load via `chrome://extensions` → Developer mode → Load unpacked → **`dist/src`**. After editing, rebuild and reload the extension there (service-worker and provider changes need it; popup-only changes just need rebuilding and reopening the popup).
- `npm run typecheck` (`tsc -b`, incremental) for a fast compile check.
- `npm run ux` — Node dev harness for the UI: serves the built assets plus the extension's own `createBackgroundService` over HTTP RPC from a fixture-seeded (or `--db <export.sqlite>`) database, with a deterministic fake embedder. `http://127.0.0.1:5173/` mounts the same Preact tree as the popup. Build first; rebuild after UI edits.
- Debug consoles: the service worker (ext/background.js) from `chrome://extensions`; the DB worker by selecting it in a DevTools console context — it exposes `__sql("SELECT ...")` and `__db` (see src/workers/db.worker.ts). `debug.html` is a blank extension-origin page for exercising chrome.runtime flows from a normal tab.
- The DB file lives in the extension origin's OPFS (`linkosh-v1.sqlite`) and survives reloads; "⟳ Full" re-walks a provider, Export downloads the .sqlite.

### The no-refetch pipeline workflow

Iterating on parsing/ingestion must not require re-fetching from services (slow, risks account flags):

1. Options → Developer → **Capture mode**: syncs then archive each raw response page verbatim into the `raw_data` table and leave `saved_items` untouched (a pristine baseline for diffing pipeline changes).
2. **Export** the DB, then iterate offline: `node src/node/tools/ingest.ts <copy.sqlite> [--reingest] [--provider id] [--dry-run]` re-runs the parse+upsert pipeline over the archive. `--reingest` re-processes even already-ingested rows (upsert is idempotent; changed row text auto-requeues embeddings).
3. In the extension, the popup's dev row (visible only in capture mode) has **Ingest raw** / **Clear raw**; the `rawIngest` op runs the same ingest module inside the DB worker.
4. `node src/node/tools/capture-fixtures.ts <copy.sqlite> [--status failed]` dumps captured pages (+ .meta.json with kind/context) as parser fixtures — bodies are verbatim, **review and scrub before committing**. A page that fails to parse is marked `failed` with its body intact: a ready-made regression fixture.

## Architecture

Runtime containers (each hop exists because of an MV3 restriction), all speaking **one typed RPC protocol** (core/rpc: `Client<Api>`/`Handlers<Api>`, uniform `{ok,result|error}` envelope, errors revived with `ProviderError.needsLogin` intact):

```
pages/popup (popup.html + page.html + dev.html mount one Preact <App/>)
  → runtimeTransport("background")                    [chrome.runtime, JSON]
ext/background.ts (MV3 service worker; composition root — behavior lives in
  ext/background-service.ts, shared verbatim with the ux-server harness)
  → runtimeTransport("db" | "ai")                     [chrome.runtime, JSON]
pages/offscreen.ts (offscreen document; SWs can't spawn workers)
  → workerTransport                                   [postMessage, structured clone]
workers/db.worker.ts (SQLite WASM on the OPFS SAH-pool VFS; only dedicated
                      workers get sync OPFS handles)
workers/ai.worker.ts (transformers.js embeddings; separate so an ORT crash
                      can't take SQLite down)
```

Vectors (`Float32Array`) ride only the postMessage hop — never chrome.runtime, whose JSON serialization would mangle typed arrays. The offscreen document hosts the AI orchestrator (core/ai/orchestrator.ts): search-mode fallbacks, single-flight embedding backlog drain, RRF plumbing.

tsconfig projects = compiler-enforced layers:

| Project | Context (lib/types) | Contents |
|---|---|---|
| src/core | bare ES2022 — no DOM/chrome/node | types.ts (domain model), errors, fts (single FTS-operator source), rpc/, db/ (port + schema + items/raw/embeddings repos + vector search + DbApi), parse/ (7 pure parsers), sync.ts, ingest.ts, ai/ (orchestrator + API types), prefs, format |
| src/workers | WebWorker | db.worker.ts, ai.worker.ts, embedders.ts |
| src/injected | DOM, **no imports at all** | functions toString-serialized into third-party pages (see src/injected/README.md — the strictest contract in the repo) |
| src/ext | WebWorker + chrome | background(-service), chrome-prefs, providers/ (env port + 7 fetchers) |
| src/pages | DOM + chrome (+ JSX) | offscreen, popup/ (app.tsx + runtime seam + 3 entries), options/ |
| tsconfig.node.json | node | scripts/build.ts, src/node/ (node-db adapters, tools/) |
| tests | node | node:test suite + fixtures + fakes |

Key contracts:

- **DB** — everything goes through the `SqlDatabase` port (core/db/port.ts); two engines implement it: the vendored WASM oo1 build (worker + tests) and node:sqlite (file-backed tools). Rows leave the repos as camelCase `SavedItem` via SQL column aliases, with `collection`/`stats` JSON-decoded — snake_case exists only inside SQL. The embedding BLOB is never selected into rows that may ride chrome.runtime (`ITEM_COLUMNS`).
- **Schema** (core/db/schema.ts) — clean v1, no migration chain (the pre-TS DB was abandoned with a new OPFS filename). `saved_items` + FTS5 external-content index maintained by triggers + `raw_data` capture archive. `kind`, `collection`, `poster_name`/`poster_handle` are FTS-indexed facets (`kind:short`, `collection:"watch later"`, `poster_name:"jane doe"`); `poster_bio` deliberately isn't.
- **Sync** (core/sync.ts) — providers fetch raw pages and hand each to `onPage(account, rawPage)`; the sync layer parses once (core/parse) and either upserts or archives (capture mode), returning the parse result + `unseen` count to the provider. Incremental stop rule: services list newest-first, so paging stops at the first page with nothing unseen; only items from before the last *successful* sync count as known (capture mode unions in `rawKnownIds`). `syncProvider` **never throws for provider failures** — it returns the `SyncReport` discriminated union (`ok | partial | failed`, with `needsLogin`); landed pages always survive. The DB is an archive, not a mirror: unsaving on the service never deletes rows.
- **UI** — one Preact tree (pages/popup/app.tsx, vendored Preact compiled by tsc's classic JSX transform — see src/vendor/preact/README.md) mounted by three entries that differ only in their `Runtime` impl (runtime.ts): main.ts (chrome; popup.html *and* page.html — no duplicated markup), dev.ts (HTTP, ux-server). Anything popup-visible must work in popup, page and the dev harness.

## Providers

Contract in core/types.ts: `Provider = { id, label, fetchItems(ctx) }`; fetchers live in `src/ext/providers/<service>.ts` as `createProvider(env: ProviderEnv)`. The env port (env.ts: cookies, withTab, execInTab, self-repair cache, sleep) is everything a provider needs from chrome — which makes pagination and self-repair loops unit-testable against a scripted fake (tests/providers.test.ts). Providers do **no parsing** — they fetch raw bodies, call `await onPage(account, { kind, url, page, context, body })`, and use the returned `{ items, unseen, cursor, hasNext }` for the stop rule and pagination. `context` must make the page independently re-parseable later (IG collection map, YT `{playlistId, collection}`). Aux pages (IG collections, YT playlists feed, FB's DOM-scraped first connection) also flow through onPage, kind-tagged. Throw `ProviderError` (with `needsLogin` when re-auth would fix it) for user-readable failures.

To add a service: pure parser in `src/core/parse/<service>.ts` + registry entry in parse/index.ts (+ `ProviderId` in core/types.ts), fetcher in `src/ext/providers/<service>.ts`, entry in background.ts's PROVIDERS wiring, origin in src/manifest.json `host_permissions`, fixture + test in tests/, README entry. The UI picks it up automatically.

All provider APIs are unofficial; each provider file documents its endpoint quirks with capture dates. Two fetch styles, chosen per service:

- **Direct from the service worker** (linkedin, hackernews, substack): works when session cookies alone authenticate the API.
- **Injected into a site tab** via env.execInTab (instagram, twitter, youtube — MAIN world for ytcfg/SAPISIDHASH — and facebook): required when the API needs page-context material or rejects requests whose browser-set headers (Sec-Fetch-Site, Referer) don't look same-origin. The injected functions live in `src/injected/` under a hard contract: **Chrome serializes them via toString() and re-parses them inside the page**, so they must be fully self-contained — no imports (not even `import type`), no module-scope references, args-only inputs. Guarded by tests/injected-guard.test.ts and a build-script grep of the emitted JS.

Known drift mechanisms, with existing self-repair patterns to copy rather than reinvent (all now covered by tests/providers.test.ts):

- **LinkedIn/X queryId rotation**: candidate lists tried newest-first (`QUERY_IDS`), stale ones fall through; README's Caveats section says where in DevTools to capture fresh ids.
- **X feature flags**: server error messages ("features cannot be null" / "unknown features") are parsed (`featureFixes`) to repair the `features` map and retry.
- **Facebook persisted queries**: the `doc_id` is discovered at runtime by scanning the page's JS bundles for the `<QueryName>_facebookRelayOperation` module and cached via env.cache until it fails. Facebook only server-renders the first page for real navigations (not `fetch()`), so the provider reads it from the DOM of a tab showing /saved/.

When a provider breaks or a new one is added, verify against the live site (DevTools network capture, or driving a browser tab) before coding against remembered API shapes — remembered doc_ids/queryIds/payload paths are frequently stale. Once captured, turn the pages into fixtures (capture mode + capture-fixtures.ts) so the parser never needs the live site again.

## What only a live extension can verify

Fetch paths (cookies, bot detection, rate-limit/login shapes, queryId/feature/doc_id self-repair against real errors), tab injection lifecycles — **especially that the emitted injected functions still run inside real pages** (the highest-severity risk of the tsc emit path, though target ES2022 + the guards make drift near-impossible) — popup↔background↔offscreen↔worker plumbing and SW suspension, OPFS persistence + export, model download/ORT under the extension CSP, and manifest/permissions. Live smoke checklist after changes touching those: `npm run build` → reload unpacked (dist/src) → incremental sync of one direct provider (hackernews) + one injected one (youtube) → search in all three modes → a "≈ more like this" → Export → options save; for capture-mode changes: capture sync → `__sql("SELECT provider, kind, status FROM raw_data LIMIT 5")` → Ingest raw → Clear raw → normal sync.

## Conventions

- `bookmarked_at` holds save time when the service exposes it, `published_at` the content time (often estimated; 0/NULL when nothing is exposed) — each parser comments which. The list sorts by `COALESCE(bookmarked_at, published_at, 0)`.
- `poster*` is the content's author, *not* the saving user. Never duplicate it into `title`: same-author items would share a "title", polluting FTS ranking and clustering embeddings (the embedded row text is title+publication+summary — poster is deliberately excluded, see rowText in core/ai/orchestrator.ts).
- Parsers emit the tightened `ParsedItem`: `collection` is always `string[]`, `stats` always `Record<string, string>` — normalization lives in parsers, not the DB layer.
- Comments explain API contracts, workarounds and non-obvious constraints (with dates for captured values); match that density in provider/parser code.
- Tests are zero-dependency `node:test`; fixtures are minimal hand-built pages or scrubbed captures in tests/fixtures/. Fakes live in tests/helpers/ (fake embedder, scripted ProviderEnv, promise-shaped DbApi). Prefer extending an existing test file over adding frameworks.
- vendor/ (under src/) contains the sqlite3 WASM, transformers.js and Preact builds — never edit the builds themselves; the sibling `.d.ts`/`.d.mts` files are ours (hand-written declarations typed to the surface we use).
