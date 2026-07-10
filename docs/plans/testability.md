# Restructure Linkosh into separately testable stages

## Context

The extension has grown to the point where changing the pipeline (parsing, embedding, search) requires exercising live 3rd-party services — slow, and risks account flagging. The goal: separate concerns so everything after the network fetch is testable under plain Node, with raw API responses capturable once and re-processed offline at will.

**Verified up front (ran on this machine, Node 24):** the vendored `vendor/sqlite3.mjs` WASM build loads under Node when passed the wasm bytes explicitly (`sqlite3InitModule({ wasmBinary: fs.readFileSync("vendor/sqlite3.wasm") })` — Node's fetch can't do `file://`, the only failure). FTS5 works; the exact oo1 APIs db/worker.js uses (`db.exec({sql,bind,rowMode:"object",returnValue:"resultRows"})`, `prepare().bind().stepReset()/finalize()`) work; an exported `.sqlite` opens via `sqlite3_deserialize` and saves back via `sqlite3_js_db_export` + `writeFileSync`. OPFS VFS install fails gracefully (same as the worker's `?opfs-disable`). **Therefore: no driver-adapter layer, no node:sqlite — one SQLite code path everywhere.** A `package.json` is inert to Chrome's unpacked-extension loader.

**User decisions:**
- **Three flows, one shared pipeline.** *Normal* (default; what users get, behaviorally unchanged from today): fetch → shared parse → upsert into `saved_items`; raw bodies discarded; `raw_data` uninvolved. *Capture* (dev-only toggle): syncs write raw pages into `raw_data` only; `saved_items` untouched (pristine baseline for diffing pipeline changes). *IngestRaw* (dev action): process `raw_data` → `saved_items` via the **same shared module** as Normal — runnable both in-extension (button) and under Node (CLI on an export copy).
- **Stop writing `saved_items.metadata`** — raw_data (captured via capture mode) supersedes it as the schema-analysis archive; remove it from ITEM_COLUMNS too (slims every list/search response). Physical column stays; dropping it is a later migration-flow concern.
- **No retention/pruning machinery, no data-migration work** — single user, capture mode is opt-in; a proper migration flow comes later.
- **A dev way to clear raw_data in Chrome** (button + `raw:clear` op; `__sql("DELETE FROM raw_data")` in the worker console also works).

## Target architecture

```
providers/<name>.js        fetch/auth/tab/pagination/self-repair ONLY (extension-only)
providers/parse/<name>.js  pure parsers: parsePage({kind, body, context}) → {items, cursor, hasNext, account?}
providers/parse/index.js   registry: providerId → parsePage
ingest/ingest.js           shared pipeline: parse+upsert used by Normal sync, in-extension IngestRaw,
                           and the Node CLI. Entry points: processPage, ingestPending, reingest
lib/sync.js                syncProvider/syncAllProviders extracted from background.js (injected deps)
lib/prefs.js               chrome.storage wrapper + createMemoryPrefs() fake
db/ops.js                  schema + migrate + all pure ops (keeps oo1 API verbatim)
db/worker.js               shrinks to: WASM/OPFS init + export op + message dispatch
tools/ingest.js            Node CLI: ingest/reingest raw_data in a .sqlite export copy (deserialize→run→write back)
tools/capture-fixtures.js  dump sanitized raw_data rows → tests/fixtures/
tests/helpers/             open-db.js (wasmBinary init + optional deserialize), fake-embedder.js, fake-prefs.js
tests/fixtures/<provider>/ captured raw bodies (sanitized)
tests/*.test.js            node:test, zero npm dependencies
package.json               {"type":"module", "scripts":{"test":"node --test tests/"}}
```

### Provider contract change (single-parse design)

Providers stop parsing entirely. `fetchItems({ knownIds, onPage })` fetches a raw body and calls
`const res = await onPage(account, rawPage)` with `rawPage = { kind, url, page, context, body }`.
The sync layer parses once via the registry and **returns the parse result** `{ items, cursor, hasNext }`; the provider uses item externalIds for the stop rule and `cursor` for the next request. Then, per mode:
- **Normal:** `ingest.processPage` upserts the parsed items into saved_items (raw body dropped).
- **Capture:** store the raw page into raw_data with the parsed items' `external_ids` (JSON column) — no upsert. Capture-mode knownIds = saved_items ∪ external_ids of pending raw_data rows, so incremental capture never re-fetches (no flagging risk).

Aux pages (Instagram collections map, YouTube playlist list, Facebook's DOM-scraped first connection) are fetched by the provider and parsed via the same pure registry; derived values ride `context` (IG `{"collections":{id:name}}`, YT `{"playlistId","collection"}`) so every raw_data row is independently re-ingestable with no run-scoped state. Parsed items no longer carry a `metadata` field.

### raw_data DDL (append to SCHEMA in db/ops.js; saved_items columns untouched — append-only rule intact)

```sql
CREATE TABLE IF NOT EXISTS raw_data (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  account      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'items',   -- items|comments|collections|playlists|connection…
  url          TEXT NOT NULL DEFAULT '',
  page         INTEGER NOT NULL DEFAULT 0,
  context      TEXT,                            -- JSON: parse inputs not recoverable from body
  body         TEXT NOT NULL,                   -- response text verbatim
  external_ids TEXT,                            -- JSON array from crawl-time parse (stop-rule support)
  fetched_at   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|ingested|failed
  ingested_at  INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS raw_data_status ON raw_data (status, provider, id);
```

A parse failure during IngestRaw marks the row `failed` with the error; the body survives as a ready-made regression fixture (`tools/capture-fixtures.js` exports it).

## Phases (each ends with a working extension + a commit)

### Phase 1 — Extract db ops + Node harness + tests pinning current behavior (no behavior change)
- Move from db/worker.js into db/ops.js **with code unchanged** (oo1 API stays): SCHEMA (7-31), FTS_SCHEMA (36-58), migrate (64-87), ftsQuery (118-125), ITEM_COLUMNS/_S (130-134), toVector (137-139), cosineTop (145-167), fetchByIds (~170-180), the `ops` object (186-427), plus an `initSchema(db)` mirroring worker.js:96-99. `export` (429-437) stays in the worker (capi + OPFS): `{...ops, export: exportOp}`.
- tests/helpers/open-db.js: init module with `wasmBinary`, open `:memory:` (or deserialize a file's bytes), run initSchema. package.json.
- Tests: upsert insert/update counts, savedAt COALESCE, embedding-invalidation `IS` semantics (worker.js:220-227); knownIds `createdBefore` cutoff; list ordering/paging; search quoting, operator passthrough, LIKE fallback; pendingEmbeddings NULL-model semantics; Float32 BLOB round-trip; cosineTop (excludeId, dim-mismatch skip, min-similarity floor, top-N); hybridSearch RRF k=60 math + FTS tie-break; similar; migrate from a hand-built pre-`kind` DB (columns appended, FTS rebuilt, data survives).

### Phase 2 — Extract pure parsers + fixture tests (no behavior change; providers import their own parser for now)
Move to providers/parse/<name>.js behind a uniform `parsePage({kind, body, context})`:
- linkedin: parseEntities (82-104), findImageUrl (66-80), getPaginationToken (124-126)
- hackernews: parseStories/parseComments (84-154), decodeEntities/stripTags (55-66), parseAge (73-79), new `nextPageUrl(html)` (morelink logic from fetchItems ~188)
- instagram: parseItems (160-195), pickImage/mediaUrl/mediaKindLabel (115-135), new `parseCollections(json)` (from fetchCollections ~149-153)
- twitter: parseEntries (228-276), tweetText (212), tweetKind (221)
- youtube: parseVideos (191-218), new `parsePlaylists(json)` (from listPlaylists ~175-182), nextContinuation (147-153) + text/pickImage/deepFind helpers
- substack: parseItems/parsePost/parseNote/parseDate (54-111)
- facebook: parseNode (284-319), textOf (278), new `parseConnection(connection)` (edges walk from addPage ~336-349 → {items, cursor, hasNext})

Fetch/auth/tab/self-repair (queryId rotation, X feature-flag repair, FB doc_id discovery, login/rate-limit detection) stays in providers/<name>.js. Extract the 7-times-copied seen/unseen/onPage loop (e.g. linkedin.js:160-172) into `createPageReducer({knownIds, onPage, account})` in providers/provider.js — the stop rule's pure heart, tested here, shrinking phase 3's diff. Parsers stop emitting `metadata`.

Fixtures: sanitized DevTools captures (or minimal hand-built bodies) per parser entry point in tests/fixtures/<provider>/. Tests assert item shapes (poster-not-in-title convention, IG collection naming, YT `${playlistId}:${videoId}` ids + short detection, HN age parsing), cursor extraction, no-throw on malformed bodies.

### Phase 3 — Three-flow crawl/ingest split (the behavioral phase)
- raw_data DDL + db ops: `rawStore`, `rawPending`, `rawMark`, `rawKnownIds` (external_ids of pending rows), `rawClear`, `rawStats` (count/size for the dev UI).
- Provider contract conversion (above). Per-provider: linkedin `res.json()` → `res.text()`; instagram/twitter/youtube injected fetch helpers return body text without parsing; substack apiGet returns text; facebook stores the stringified first-page connection as `kind:'connection'`.
- ingest/ingest.js: `processPage(db, {provider, account, rawPage})` (parse → upsert, Normal flow), `ingestPending(db, {provider?})` (oldest-first over `status='pending'` → parse → upsert → mark ingested/failed), `reingest(db, {provider?})` (re-run over all rows — the "pipeline changed" path; upsert idempotency + the embedding-invalidation CASE re-queue embeddings when row text changes).
- Stop writing `metadata` in upsert; remove it from ITEM_COLUMNS (popup renders nothing from it — verify, it doesn't).
- lib/sync.js: syncProvider/syncAllProviders (background.js:83-151) with injected `{providers, db, getMeta, setMeta, captureRaw}`; onPage = parse once → capture ? rawStore : processPage; capture-mode knownIds = saved_items ∪ rawKnownIds. background.js becomes wiring and reads the `captureRaw` pref per sync.
- Dev UI (page/ footer next to Export, hidden unless capture pref is on): "Ingest raw" (routes to ingestPending in the worker → embedSoon after), "Clear raw" (rawClear), raw counts. New background message types `raw:ingest`, `raw:clear`, `raw:stats`.
- tools/ingest.js: open a .sqlite export copy under Node (deserialize), run ingestPending/reingest, write back — the no-refetch iteration workflow (embeddings stay pending in the copy; that's fine, it's an experiment artifact). tools/capture-fixtures.js: scrub + dump raw_data rows to tests/fixtures/.
- Code-migration safety: convert providers one commit at a time — lib/sync detects the old `onPage(account, items)` shape and upserts directly until all seven are converted; remove the fallback in the last commit.
- Tests: per-provider fixture → processPage → saved_items rows; capture stores raw + external_ids and leaves saved_items untouched; capture-mode knownIds union; failed parse → row `failed` + body intact → fix parser → ingestPending picks it up; reingest idempotency; lib/sync with a scripted fake provider + real in-memory DB (incremental stop rule, full walk, partial failure keeps landed pages / skips setMeta / next run's createdBefore correct, capture vs normal branching).

### Phase 4 — Prefs wrapper + orchestrator seam + docs
- lib/prefs.js (`get/set/remove/watch`) + `createMemoryPrefs()`. Consumers: background (`meta:<id>`, `ai:settings` watcher, `captureRaw`), popup (`lastProvider`, `searchMode`; init at popup.js:322-332), options (`ai:settings`, plus the "Capture raw responses (dev)" checkbox). Facebook's doc_id cache may stay as-is (extension-only anyway).
- ai/orchestrator.js: `createOrchestrator({db, ai, getSettings})` — inject the single `chrome.runtime.sendMessage` at orchestrator.js:25-26; offscreen.js supplies the real impl. Orchestrator then runs under Node with tests/helpers/fake-embedder.js (deterministic token-hash → normalized 384-dim vectors). Tests: drainBacklog 64-pull/16-batch loop, single-flight, status math, search-mode fallbacks (FTS-operator query, model not ready, zero embedded), rowText truncation, hybrid search through the orchestrator end-to-end.
- popup: extract formatDuration/formatSynced/meta-line assembly (popup.js:36-49, 95-107) into popup/format.js; unit-test. DOM building/IntersectionObserver stay manual (no jsdom — zero-dep rule).
- Update CLAUDE.md (new architecture map, `npm test`, capture/IngestRaw workflow, tools/ingest usage, fixtures policy, live-smoke checklist) + README (capture mode).

## What stays extension-only (untestable under Node) — with mitigations

1. **Live fetch paths**: cookie auth, bot detection (Instagram, X same-origin header checks), login/rate-limit detection on live response shapes, LinkedIn/X queryId rotation and X feature-flag self-repair (they react to live server errors by design).
2. **Tab injection**: `chrome.scripting.executeScript` incl. MAIN world (YouTube ytcfg/SAPISIDHASH), tab reuse/create/close lifecycles, Facebook DOM scrape + runtime doc_id discovery.
3. **Message plumbing & lifecycles**: popup↔background↔offscreen↔worker routing, sendResponse keep-alive, offscreen document creation/survival, service-worker suspension.
4. **Storage substrate**: OPFS SAH-pool VFS, persistence across reloads, `export` via capi + OPFS write.
5. **AI runtime**: transformers.js model download + caching, ONNX under extension CSP, cloud-key optional-permission grants in options.
6. **UI shell**: popup-vs-page IntersectionObserver behavior, blob download, `chrome.tabs.create`, manifest/permission correctness.

Mitigations: providers shrink to thin fetch loops (~50 untestable lines each); any capture-mode body is one `tools/capture-fixtures.js` run from becoming a regression fixture; debug.html + the DB worker's `__sql` console remain for manual driving; a written live-smoke checklist goes into CLAUDE.md (per provider: incremental / full / logged-out; plus 3 search modes, similar, export, options save, popup + page scroll); `node --check` stays the syntax gate for extension-only files.

## Verification

- After every phase: `npm test` green, `node --check` over changed extension files, reload the unpacked extension, live smoke: incremental sync of one direct provider (hackernews) + one injected provider (youtube), search in all three modes, similar-items, export.
- Phase 3 specifically: enable capture → sync → `__sql("SELECT provider, kind, status, length(body) FROM raw_data LIMIT 10")` shows rows and saved_items count is unchanged; "Ingest raw" moves them into saved_items and embeddings drain; export the DB, run `node tools/ingest.js --reingest <copy>` and confirm counts match the in-extension ingest; "Clear raw" empties the table; disable capture → sync → items land directly, raw_data stays empty.
- Phase 1 regression guard: before moving code, seed a small DB and pin list/search/hybridSearch outputs in the first tests, so the extraction is verified against today's behavior.
