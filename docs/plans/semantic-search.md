# Plan A — Semantic search + "More like this"

Status: implemented (2026-07-07, transformers.js pinned at 3.8.1). Companion plan:
[auto-tagging.md](auto-tagging.md) builds on the infrastructure introduced here.

## Context

Search today is FTS5 keyword matching over `title`/`subtitle`/`summary`/`collection`/`kind`. That
fails on vocabulary mismatch: "that post about burnout" finds nothing if the saved item says
"exhaustion at work". This plan adds local-first vector search: every row gets an embedding
(quantized `all-MiniLM-L6-v2`, 384-dim, via transformers.js running fully locally), the search box
gains a user-selectable mode — **Text** (FTS5 only, the default) / **Hybrid** (FTS5 rank + cosine,
exactly today's behavior) / **Semantic** (cosine only) — and each item gets a "more like this"
nearest-neighbors affordance. An options page adds an optional cloud API key that upgrades
embedding quality; without a key everything runs on-device and offline.

## Topology and load-bearing constraints

```
popup/page ── chrome.runtime (JSON ONLY — no vectors ever) ── background.js
                                                                │  db()  target:"db"  (unchanged)
                                                                │  ai()  target:"ai"  (new)
                                                              offscreen.js  (document; hosts orchestrator)
                                                               ├─ postMessage ─ db/worker.js  (SQLite, owns BLOBs)
                                                               └─ postMessage ─ ai/worker.js   (new; transformers.js)
```

- **Vectors never cross `chrome.runtime`.** Runtime messages are JSON-serialized; a Float32Array
  would be mangled/inflated. All vector traffic moves between the AI worker, the offscreen document
  (`ai/orchestrator.js`), and the DB worker via `postMessage` (structured clone handles typed
  arrays). Corollary: `db/worker.js`'s `list`/`search` must stop using `SELECT *` (see below) so the
  new `embedding` BLOB column never rides a runtime message.
- **Embedding runs in a second dedicated worker, not inside db/worker.js.** Inference costs tens of
  ms per item and seconds per batch; during a sync the DB worker is servicing `upsert` per page
  while the popup polls `items:list`. A separate worker keeps SQLite responsive, and an
  onnxruntime crash/OOM cannot take the database down. The offscreen document already exists with
  reason `WORKERS` and can host both workers.
- **background.js stays high-level.** It gains an `ai(op, args)` helper (mirror of `db()`) and only
  sends commands like `search` / `status` / `embedBacklog`; the orchestrator in the offscreen
  document does the vector plumbing.

## Vendoring transformers.js (no build step)

Obtain files from the npm tarball without adopting npm in the repo: download
`https://registry.npmjs.org/@huggingface/transformers/-/transformers-<version>.tgz`, extract, copy.
Pin one version and note it in a comment.

- **`vendor/transformers.min.js`** — the bundled ESM dist (`dist/transformers.min.js`), imported by
  `ai/worker.js` as a module. Adding files to `vendor/` is fine; the "never edit vendor/" rule
  protects the existing sqlite build.
- **`vendor/ort/`** — the onnxruntime WASM files shipped in the same dist folder
  (`ort-wasm-simd-threaded.jsep.mjs` + `.wasm`; exact filenames vary by version — verify against the
  pinned tarball). These are **code** and must not be remote-fetched (MV3 remote-code policy).
  Configure `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/")`.
- **Model weights are fetched at runtime and cached, not vendored.** ~23 MB of data (not code, so no
  MV3 policy issue). huggingface.co serves `Access-Control-Allow-Origin: *` on resolve URLs, so no
  host_permission is needed. transformers.js caches via the Cache API (`env.useBrowserCache`,
  default on) → fully offline after first download. Pin `Xenova/all-MiniLM-L6-v2` with
  `{ dtype: "q8" }`. Until the model is ready, search silently stays FTS-only. Escape hatch if HF
  ever becomes unavailable: vendor the weights and point `env.localModelPath` at them.
- **Backend: WASM, single-threaded SIMD** (`device: "wasm"`). Extension pages are not cross-origin
  isolated → no SharedArrayBuffer → no ORT threads; WebGPU in an offscreen-document worker is
  inconsistent across machines. q8 MiniLM on WASM is ~5–20 ms per short row text, fine for
  thousands of rows. WebGPU stays a future opt-in.
- CSP already has `'wasm-unsafe-eval'` (needed by sqlite) — no manifest CSP change.

## Schema migration (db/worker.js)

Append-only, at the END of `saved_items`, not FTS-indexed (so no FTS rebuild):

```sql
ALTER TABLE saved_items ADD COLUMN embedding BLOB;        -- raw little-endian Float32; dim = byteLength/4
ALTER TABLE saved_items ADD COLUMN embedding_model TEXT;  -- e.g. 'local:minilm-l6-v2-q8', 'openai:text-embedding-3-small'
```

`migrate()` gains two `if (!have.has(...))` lines; `SCHEMA` gains the same columns after
`collection`, under the existing "newer columns stay at the end" comment.

**Re-embed invalidation needs no extra bookkeeping.** Extend `upsert`'s `ON CONFLICT DO UPDATE`:

```sql
embedding = CASE WHEN excluded.title = saved_items.title
                  AND excluded.subtitle = saved_items.subtitle
                  AND excluded.summary = saved_items.summary
            THEN saved_items.embedding ELSE NULL END,
embedding_model = CASE WHEN <same condition> THEN saved_items.embedding_model ELSE NULL END
```

A model change needs nothing: the backlog query is
`embedding IS NULL OR embedding_model IS NOT :currentModel` (`IS NOT` so NULL models match).

## File-by-file changes

### New: `ai/providers.js`

The provider seam (shared with Plan B). Interface per provider:

```js
// { id: 'local:minilm-l6-v2-q8', dim: 384,
//   init(onProgress): Promise<void>,                 // download/load; progress {loaded, total}
//   embed(texts: string[]): Promise<Float32Array[]> } // L2-normalized
```

- `createLocalProvider()` — `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2",
  { dtype: "q8", device: "wasm", progress_callback })`; embed with
  `{ pooling: "mean", normalize: true }`.
- `createOpenAIProvider({ apiKey })` — POST `https://api.openai.com/v1/embeddings`, model
  `text-embedding-3-small` (1536-dim; recommended cloud default — cheapest mainstream, strong
  quality). Batch ≤ 100 inputs per request.
- `createGeminiProvider({ apiKey })` — `models/gemini-embedding-001:batchEmbedContents`
  (768-dim via `output_dimensionality`).
- `createVoyageProvider({ apiKey })` — `voyage-3.5-lite`.
- `resolveProvider(settings)` — cloud when a key + provider selection exist, else local. Cloud
  vectors are L2-normalized client-side so cosine == dot everywhere.
- Note in a comment: Anthropic has no embeddings API; the Anthropic key on the options page is used
  only by Plan B's tag labeling.

### New: `ai/worker.js` (dedicated module worker)

Mirror of db/worker.js's envelope: `{ id, op, args }` in, `{ id, ok, result|error }` out. At module
top: `env.allowLocalModels = false`,
`env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/")`. Ops:

- `configure({ settings })` — (re)resolve provider; lazy `init()` on first embed.
- `status()` — `{ ready, model, dim, downloading: {loaded, total} | null, error }`.
- `embed({ texts })` — returns `Float32Array[]` (structured clone; optionally transfer buffers).

### New: `ai/orchestrator.js` (ESM imported by offscreen.js; runs in the offscreen *document*)

Owns both worker clients and all vector plumbing. Exports `handleAiMessage(op, args)`.
*(Correction found during implementation: offscreen documents only get `chrome.runtime` —
`chrome.storage` is undefined there.)* Settings therefore flow through background.js: the
orchestrator pulls them once at creation via an `ai:getSettings` runtime message, and
background.js watches `chrome.storage.onChanged` and pushes a `configure` op on every
options-page save.

- `embedBacklog()` — loop until empty: `db.pendingEmbeddings({ model, limit: 64 })` → build row
  text (`title + "\n" + subtitle + "\n" + summary`, truncated ~1000 chars) → `ai.embed` in batches
  of 16 → `db.storeEmbeddings({ model, rows })`. Single-flight guard (module-level promise) so
  overlapping triggers coalesce. Maintains `{ running, done, total }` for `status()`. Idempotent:
  a crash mid-backlog just leaves `embedding IS NULL` rows for the next trigger.
- `search({ query, provider, limit, mode })` — `mode` is the **user's choice** from the UI:
  `"fts"` (default), `"hybrid"`, or `"semantic"`. Routing rules, in order:
  1. `mode: "fts"` → `db.search`, done. (Zero AI involvement — this is the escape hatch that keeps
     search working exactly as today.)
  2. Query matches the FTS-operator regex (mirror of `ftsQuery`'s
     `/["():*^]|\b(AND|OR|NOT|NEAR)\b|\S:/`) → `db.search` regardless of mode. Facet and operator
     queries (`kind:short`, quoted phrases, AND/OR) are meaningless to an embedding model; they
     always ride the FTS path.
  3. AI worker not ready (model still downloading, or embed backlog for the current model) →
     `db.search` as graceful fallback.
  4. `mode: "semantic"` → embed the query → `db.semanticSearch` (pure cosine ranking, no FTS).
  5. `mode: "hybrid"` → embed the query → `db.hybridSearch` (RRF merge).

  The response always reports what **actually ran**: `{ items, mode: "hybrid"|"semantic"|"fts",
  requested }` — so the UI can say "text-only (model warming up)" when the user asked for
  semantic/hybrid but got FTS.
- `status()` — merges AI-worker status with `db.embeddingStats` →
  `{ modelReady, model, downloading, backlog, embedded, total }`.

### Modified: `offscreen.js`

- Extract the existing pending-map pattern (lines 11–33) into `makeWorkerClient(url)`; instantiate
  `dbClient` (same URL + `?opfs-disable&opfs-wl-disable` flags) and hand it plus a new `aiClient`
  to the orchestrator.
- Message listener: `target:"db"` routes exactly as today; add `target:"ai"` →
  `handleAiMessage(message.op, message.args)` with the same `{ok, result|error}` envelope.
- `offscreen.html` unchanged (already loads offscreen.js as a module).

### Modified: `db/worker.js`

- Schema/migrate/upsert changes as above.
- `const ITEM_COLUMNS = "id, provider, account, external_id, url, title, subtitle, summary, image,
  metadata, saved_at, created_at, kind, duration, collection"` — replaces `SELECT *` in `list`
  (line 195), `SELECT s.*` in the FTS branch of `search` (line 207), and `SELECT *` in the LIKE
  fallback (line 218). **This is what keeps embedding BLOBs out of chrome.runtime messages.**
- New ops:
  - `pendingEmbeddings({ model, limit })` —
    `SELECT id, title, subtitle, summary FROM saved_items
     WHERE embedding IS NULL OR embedding_model IS NOT ? ORDER BY id DESC LIMIT ?`
    (newest first so fresh syncs become searchable first).
  - `storeEmbeddings({ model, rows: [{id, vector}] })` — prepared
    `UPDATE saved_items SET embedding = ?, embedding_model = ? WHERE id = ?` inside BEGIN/COMMIT.
    sqlite3 WASM binds Uint8Array as BLOB: bind `new Uint8Array(vector.buffer)`.
  - `embeddingStats({ model })` — `{ total, embedded }` in one aggregate query.
  - `cosineTop({ queryVector, model, provider, limit, excludeId })` (op + internal helper) —
    `SELECT id, embedding FROM saved_items WHERE embedding IS NOT NULL AND embedding_model = ?
     [AND provider = ?]`; decode each blob with
    `new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)`; dot product (vectors are
    normalized, so dot == cosine); keep top-N via insertion into a fixed-size array. 10k rows ×
    384 dims ≈ 4M multiplies — a few ms.
  - `hybridSearch({ query, queryVector, model, provider, limit = 200 })` — **Reciprocal Rank
    Fusion, k = 60**:
    1. FTS candidates: existing FTS query path, top 100, ranks 1..n (LIKE fallback on parse error,
       as today).
    2. Vector candidates: `cosineTop` top 100, dropping scores < 0.25 (noise floor).
    3. `score(id) = Σ over lists containing id of 1/(60 + rank)`; sort desc; tie-break by FTS rank.
    4. Fetch full rows (`SELECT ITEM_COLUMNS … WHERE id IN (…)`), reorder in JS, return ≤ limit.
  - `semanticSearch({ queryVector, model, provider, limit = 200 })` — pure vector ranking:
    `cosineTop` (same 0.25 noise floor), fetch full rows for the top ids, return ordered by
    similarity with a `similarity` field appended. No FTS involvement.
  - `similar({ id, provider, limit = 20 })` — read the row's `embedding` + `embedding_model`; if
    NULL throw `"Item not embedded yet"`; else `cosineTop` with `excludeId: id`; return full rows
    with a `similarity` field appended.

### Modified: `background.js`

- `ai(op, args)` helper next to `db()` — same `ensureOffscreen()` +
  `chrome.runtime.sendMessage({ target: "ai", op, args })`.
- `items:search` handler → `const r = await ai("search", { query, provider, limit: 200, mode })`
  (`mode` passed through from the popup message); response becomes
  `{ ok: true, items: r.items, mode: r.mode, requested: r.requested }`.
- New cases:
  - `items:similar { id, providerId }` → `db("similar", …)`.
  - `ai:status` → `ai("status")`.
  - `ai:embed` → fires `ai("embedBacklog")` **without awaiting** and responds `{ok:true}`
    immediately. Embedding can run for minutes; never hold a `sendResponse` open for it.
- Post-sync trigger: at the end of `syncProvider` (after the meta write) and `syncAllProviders`,
  fire-and-forget `ai("embedBacklog").catch(() => {})`. Also trigger once from SW top-level on
  startup (guarded by `ensureOffscreen()`) to drain any backlog after a browser restart.

### New: `options/options.html` + `options/options.js` (shared cloud-key infra — Plan B reuses this)

- Fields: embedding-provider `<select>` (Local — default / OpenAI / Gemini / Voyage); API-key
  inputs for OpenAI, Gemini, Voyage, Anthropic (Anthropic labeled "used for tag labeling only —
  Anthropic has no embeddings API"); Save; a live `ai:status` panel (model, download %, backlog);
  a "Rebuild embeddings" button (`ai:embed`).
- Storage: `chrome.storage.local` key `ai:settings` =
  `{ embedProvider, keys: { openai, gemini, voyage, anthropic } }`. storage.local is plaintext on
  disk — acceptable for a personal extension; call it out in README.
- On save with a cloud provider selected: `chrome.permissions.request({ origins: [apiOrigin] })`
  from the click gesture, so extension-context fetches to the API bypass CORS.
- First-run check: if a cloud fetch from the *worker* context still hits CORS in practice, move
  provider fetches into the orchestrator (offscreen-document context) — the provider interface
  doesn't care where `embed()` executes.

### Modified: `manifest.json`

- `"options_ui": { "page": "options/options.html", "open_in_tab": true }`.
- `"optional_host_permissions": ["https://api.openai.com/*",
  "https://generativelanguage.googleapis.com/*", "https://api.voyageai.com/*",
  "https://api.anthropic.com/*"]`.
- No CSP change; no web_accessible_resources change (vendor files are same-origin).

### Modified: `popup/popup.js` + `popup/popup.css` (shared verbatim by page/page.html)

- **Search-mode selector (user choice)**: a compact three-way control next to the search input —
  `<select id="search-mode">` with options `Text` (default) / `Hybrid` / `Semantic` — added to
  **both** popup.html and page.html (popup.js is shared verbatim). Shown/hidden together with
  `#search` (same `total === 0` rule). Persisted in `chrome.storage.local` as `searchMode` and
  restored on init, exactly like the existing `lastProvider` pattern. Changing the mode with a
  non-empty query re-runs `onSearchInput()`.
- `onSearchInput`: sends `mode: searchModeSelect.value` with `items:search`. The response carries
  `mode` (what ran) and `requested` (what was asked); status becomes `` `${items.length} matches` ``
  plus:
  - `" · text-only (model warming up)"` when `requested !== "fts"` but `mode === "fts"` because
    the model isn't ready;
  - `" · text search (query uses operators)"` when a facet/operator query forced FTS in
    semantic/hybrid mode — so the user is never confused about which engine ranked the results.
- **More like this**: in `buildItems`, append `<button class="similar" title="More like this">≈</button>`
  to each `li` as a *sibling* of the `<a>` (so clicks don't navigate). Handler: `++generation`;
  `send({ type: "items:similar", id: item.id, providerId: providerSelect.value })`; on success
  render results without the infinite-scroll sentinel, clear the search box, status:
  `Similar to "<title>"` with a small `✕` reset control that calls `loadItems()`. On error
  ("Item not embedded yet") show it in status with the backlog count from `ai:status`. Provider
  change / typing already reset via existing paths.
- CSS: `.similar` styled like the meta text; visible on row hover in the page view, always visible
  in the popup.

## Message protocol additions

| Hop | Message |
|---|---|
| popup → background | `items:search` gains `mode: "hybrid"\|"fts"\|"semantic"` (user's selector choice); `items:similar {id, providerId}`, `ai:status`, `ai:embed` |
| popup ← background | `items:search` response gains `mode` (what ran) + `requested` (what was asked); similar/semantic rows gain `similarity` |
| background → offscreen | `{target:"ai", op:"search"\|"status"\|"embedBacklog"}` |
| offscreen ↔ ai worker | `configure`, `status`, `embed` (postMessage — binary safe) |
| offscreen ↔ db worker | `pendingEmbeddings`, `storeEmbeddings`, `hybridSearch`, `semanticSearch`, `similar`, `embeddingStats`, `cosineTop` (postMessage — binary safe) |

## Open risks

- **transformers.js dist specifics** — exact ORT wasm filenames and whether `wasmPaths` needs a
  trailing slash vary by version. Pin one version; verify in the AI-worker console on first run.
- **HF availability** — first run needs network; mitigated by Cache API persistence and FTS-only
  fallback; ultimate fallback is vendoring weights (`env.localModelPath`).
- **Cloud dimension switch** — changing embedding provider changes vector dims mid-corpus. Safe
  (cosine only scans rows where `embedding_model` matches the current model) but semantic search
  goes dark until re-embed completes; the options page must show the backlog prominently after a
  switch.
- **Offscreen document lifetime** — Chrome doesn't tear down `WORKERS`-reason offscreen docs on a
  timer; a crash mid-backlog leaves NULL embeddings and the idempotent loop re-drains on the next
  sync/startup.
- **MiniLM is English-centric** — multilingual items (Instagram/X) embed weaker. Future swap:
  `Xenova/multilingual-e5-small`; the `embedding_model` column makes that a re-embed, not a
  migration.

## Verification

1. `node --check` every touched/new JS file (`ai/*.js`, `offscreen.js`, `db/worker.js`,
   `background.js`, `popup/popup.js`, `options/options.js`).
2. `chrome://extensions` → Reload. SW console: no errors; offscreen doc created on first DB call.
3. DevTools console-context dropdown → `ai/worker.js` worker: model download logs on first embed.
   Then → `db/worker.js` worker:
   - `__sql("PRAGMA table_info(saved_items)")` → `embedding`, `embedding_model` at the end.
   - After a Refresh sync:
     `__sql("SELECT COUNT(*) done, (SELECT COUNT(*) FROM saved_items) total FROM saved_items WHERE embedding IS NOT NULL")`
     — `done` climbs to `total`.
   - `__sql("SELECT length(embedding), embedding_model FROM saved_items WHERE embedding IS NOT NULL LIMIT 1")`
     → `1536, 'local:minilm-l6-v2-q8'` (384 floats × 4 bytes).
4. From a tab showing `debug.html`:
   - `chrome.runtime.sendMessage({type:"ai:status"}, console.log)` → `{modelReady:true, backlog:0, …}`.
   - `chrome.runtime.sendMessage({type:"items:search", providerId:"all", query:"machine learning"}, console.log)`
     → `mode:"hybrid"`, results include items that don't literally contain the words.
   - `{type:"items:search", query:"kind:short"}` → `mode:"fts"` (facet passthrough).
5. Popup **and** page/page.html (shared popup.js): search a fuzzy concept ("startups raising
   money") — semantically related rows rank above LIKE-style misses; click `≈` on a row → similar
   items render; `✕` restores the list.
   - Mode selector: switch to **Text** with the same query → results identical to today's FTS
     behavior and response `mode:"fts"`; switch to **Semantic** → ranking is pure similarity
     (response carries `similarity` values, `mode:"semantic"`); switch back to **Hybrid** →
     `mode:"hybrid"`. Reopen the popup → the chosen mode is restored (`searchMode` in
     chrome.storage.local). In Semantic mode, type `kind:short` → status shows the
     operators-forced-text notice and results match FTS.
6. Options: set an OpenAI key, accept the permission prompt, Rebuild → watch `embedding_model`
   flip via `__sql("SELECT embedding_model, COUNT(*) FROM saved_items GROUP BY 1")`.
