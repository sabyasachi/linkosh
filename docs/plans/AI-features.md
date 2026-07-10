# Create two AI-feature plan docs for Linkosh

## Context

The user asked for AI/embedding feature suggestions for this extension, picked two to pursue — **(A) semantic search + "more like this"** and **(B) auto-tagging / smart collections** — with a **local-first model strategy plus an optional cloud API key**, and asked for **two separate plan documents**. The deliverable of this task is those two docs written into the repo (no feature code yet):

- `docs/plans/semantic-search.md` (Plan A)
- `docs/plans/auto-tagging.md` (Plan B — states its dependency on A)

Designs below were verified against the code: `list`/`search` use `SELECT *` (db/worker.js:195,207,218), the FTS stale-check drop/recreate/rebuild pattern is at db/worker.js:69–79, `ftsQuery()`'s `/\S:/` passthrough (line 114) means a new `tag:` facet needs zero query-builder changes, and offscreen.js's pending-map (lines 11–33) is the pattern to factor into a reusable worker client.

## Plan A content — Semantic search + "More like this"

**Topology.** A second dedicated worker (`ai/worker.js`) in the existing offscreen document runs transformers.js + quantized `Xenova/all-MiniLM-L6-v2` (384-dim, WASM backend, single-thread SIMD — no SharedArrayBuffer in extensions). Key invariant: **vectors never cross `chrome.runtime`** (JSON-only); all vector traffic flows AI worker ↔ offscreen doc ↔ DB worker via postMessage (structured clone handles Float32Array). `offscreen.js` gains an orchestrator (`ai/orchestrator.js`) handling `target:"ai"` messages; background.js only issues high-level commands via a new `ai()` helper next to `db()`.

**Why not inside db/worker.js:** inference (tens of ms/item, seconds/batch) would stall upsert/list during sync while the popup polls; a separate worker keeps SQLite responsive and isolates ORT crashes.

**Vendoring (no build step).** Copy from the `@huggingface/transformers` npm tarball (no package.json added): `vendor/transformers.min.js` (bundled ESM) + `vendor/ort/` (onnxruntime WASM binaries — code must not be remote-fetched under MV3). `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/")`. Model **weights** (~23 MB, data not code) fetched at runtime from huggingface.co (CORS `*`, no host_permission needed), cached via Cache API → offline after first run; search stays FTS-only until ready. CSP already has `wasm-unsafe-eval` — no manifest CSP change.

**Schema (append-only, at end, not FTS-indexed):**
```sql
ALTER TABLE saved_items ADD COLUMN embedding BLOB;        -- little-endian Float32
ALTER TABLE saved_items ADD COLUMN embedding_model TEXT;  -- e.g. 'local:minilm-l6-v2-q8'
```
Re-embed invalidation without extra bookkeeping: extend upsert's `ON CONFLICT DO UPDATE` with `CASE WHEN excluded.title/subtitle/summary unchanged THEN keep embedding ELSE NULL END`. Backlog query: `embedding IS NULL OR embedding_model IS NOT :current`.

**New/changed files:**
- `ai/providers.js` — provider seam: `{ id, dim, init(onProgress), embed(texts) → normalized Float32Array[] }`. `createLocalProvider()` (transformers.js pipeline, `{pooling:"mean", normalize:true, dtype:"q8"}`); cloud: OpenAI `text-embedding-3-small` (recommended cloud default), Gemini `gemini-embedding-001`, Voyage `voyage-3.5-lite`. `resolveProvider(settings)` picks cloud when key present, else local. (Anthropic has no embeddings API — its key is for Plan B labeling only.)
- `ai/worker.js` — ops `configure/status/embed`, same `{id,op,args}`/`{id,ok,result|error}` envelope as db/worker.js.
- `ai/orchestrator.js` — `embedBacklog()` (single-flight loop: `pendingEmbeddings` 64/batch → embed 16/batch → `storeEmbeddings`; text = title\n subtitle\n summary truncated ~1000 chars), `search()` (FTS-only when model not ready or query matches the FTS-operator regex incl. facets; else embed query → `hybridSearch`; returns `mode: "hybrid"|"fts"`), `status()`. Reads `ai:settings` from chrome.storage itself; re-configures on `storage.onChanged`.
- `offscreen.js` — factor pending-map into `makeWorkerClient(url)`; route `target:"ai"` → orchestrator; `target:"db"` unchanged.
- `db/worker.js` — migration above; `ITEM_COLUMNS` constant replaces `SELECT *`/`s.*` in `list` + both `search` branches (**blobs must not enter runtime messages**); new ops `pendingEmbeddings`, `storeEmbeddings` (transaction, bind `new Uint8Array(vector.buffer)`), `embeddingStats`, `cosineTop` (decode blobs to Float32Array, dot product — vectors normalized; ~ms at 10k rows), `hybridSearch` (**RRF, k=60**: top-100 FTS + top-100 cosine with 0.25 floor, `score = Σ 1/(60+rank)`, fetch merged rows by id, reorder in JS), `similar({id})` (throws "Item not embedded yet" when NULL).
- `background.js` — `ai()` helper; `items:search` → `ai("search")` (response gains `mode`); new cases `items:similar`, `ai:status`, `ai:embed` (fire-and-forget — never hold sendResponse for minutes); fire-and-forget `ai("embedBacklog")` after each sync and once on SW startup.
- `options/options.html|js` (new, **shared infra reused by Plan B**) — provider select (Local default / OpenAI / Gemini / Voyage), key fields (+ Anthropic, labeled for tag-labeling), status panel (model, download %, backlog), "Rebuild embeddings". Storage: `ai:settings` in chrome.storage.local (plaintext — README caveat). On save: `chrome.permissions.request({origins:[apiOrigin]})` from the click gesture.
- `manifest.json` — `options_ui` (open_in_tab), `optional_host_permissions` for the four API origins.
- `popup/popup.js` (+css; shared by page/) — search status shows "text-only (model warming up)" when `mode:"fts"` and model not ready; per-row `≈` button (sibling of the `<a>`) → `items:similar` → render results with a status-line reset (✕ → `loadItems()`), reusing the generation counter.

**Risks:** transformers.js dist filenames/`wasmPaths` vary by version (pin + verify in worker console); first-run needs network (fallback: vendor weights via `env.localModelPath`); provider switch changes dims → semantic search dark until re-embed (options page shows backlog); MiniLM is English-centric (model swap = re-embed, not migration, thanks to `embedding_model` column); if cloud fetch from the worker hits CORS, move provider fetches to the orchestrator (document context) — interface doesn't care.

**Verification:** `node --check` all touched files; reload extension; AI-worker console shows model download; DB-worker console: `__sql("PRAGMA table_info(saved_items)")` shows new columns, embedded-count climbs to total after sync, `length(embedding)` = 1536 (384×4 bytes); debug.html: `ai:status` → `{modelReady:true}`, `items:search` fuzzy query → `mode:"hybrid"` with non-literal matches, `kind:short` → `mode:"fts"`; popup **and** page: fuzzy search ranks semantic matches, `≈` renders similar items, ✕ restores; set OpenAI key → Rebuild → `embedding_model` flips per `__sql` GROUP BY.

## Plan B content — Auto-tagging / smart collections (depends on A)

**Pipeline** (manual trigger only — re-clustering rewrites the taxonomy and must never happen silently after a sync): `db.allEmbeddings` → cluster in AI worker → label → `db.applyTags` (clears old auto-tags first) → tags render as chips and as an FTS facet.

**Clustering** (`ai/worker.js` op `cluster`, pure JS): spherical mini-batch k-means (normalized vectors ⇒ cosine = dot). Agglomerative rejected: O(n²) ≈ 4×10⁸ dots at 20k rows. k chosen from {8,12,16,24,32} clamped ≤ n/20 via simplified silhouette on a 500-point sample; k-means++ seeding on 2k sample, batch 256, ~80 iters, re-normalize centroids; deterministic PRNG seed (stable re-runs). Confidence floor: best-centroid dot < 0.35 → untagged `''`. Returns memberIds, centroid, 12 exemplarIds per cluster.

**Labeling chain** (`ai/orchestrator.js` `generateTags()`, refuses while embed backlog > 10%): (1) always compute TF-IDF top-2 terms per cluster as anchor/fallback; (2) cloud key present (Anthropic `claude-haiku` with `anthropic-dangerous-direct-browser-access: true`, or OpenAI) → one batched JSON prompt over exemplar titles; (3) else Chrome built-in Prompt API (Gemini Nano) in the offscreen **document** context if `LanguageModel.availability() === "available"` — never auto-trigger the multi-GB download (options page offers a button); (4) else TF-IDF. Dedupe, cap 24 chars. Response reports `labeler: "cloud"|"nano"|"tfidf"`.

**Schema:** `ALTER TABLE saved_items ADD COLUMN tag TEXT NOT NULL DEFAULT ''` (end, after A's columns). Add `tag` to FTS5 column list + all three triggers + the stale check (`fts.has("tag")`) — existing drop/recreate/rebuild machinery upgrades old DBs (one-time few-second rebuild). `tag:"rust async"` then works in the search box via the existing `/\S:/` passthrough — zero `ftsQuery` changes. New plain table `tag_meta(name PRIMARY KEY, hidden)` for hide state. Column-not-join-table because the FTS index is `content='saved_items'` — facet search requires a content-table column; one auto-tag per item is the model.

**New db ops:** `allEmbeddings` (postMessage-only; ~30 MB clone at 20k rows — one-shot, fine), `corpusTexts` (for TF-IDF), `applyTags` (transactional; AU trigger keeps FTS in sync), `listTags` (grouped counts ⟕ tag_meta), `renameTag` (rename-onto-existing = merge), `setTagHidden`. `ITEM_COLUMNS` gains `tag`.

**background.js:** `tags:generate` (awaited — 10–30 s is fine for sendResponse; progress via `ai:status` polling), `tags:list`, `tags:rename`, `tags:hide`.

**UI** (shared popup.js; markup added to **both** popup.html and page.html): `#tags` chip row between search and status — top 20 non-hidden tags `[name (n)]`; chip click sets `searchInput.value = 'tag:"…"'` and rides the existing FTS path; click again clears. Page view only: "Auto-tag" header button with confirm() warning that re-tagging replaces current tags and loses renames; chip `…` → rename (merge) / hide. `buildItems` appends `item.tag` to the meta line. Non-goals v1: manual per-item tagging, multi-tag, drag-drop.

**Risks:** Prompt API availability in offscreen docs is the shakiest leg (chain degrades to TF-IDF — enhancement, never dependency; if `LanguageModel` absent in offscreen doc, run it from options/page context); thin-text rows (YouTube/LinkedIn) pool weakly — the 0.35 floor leaves them untagged rather than mislabeled; label instability across runs is inherent — mitigated by deterministic seeding and honest confirm() copy.

**Verification:** `node --check`; reload; `__sql("SELECT tag FROM saved_items_fts LIMIT 1")` proves FTS rebuilt; debug.html `tags:generate` → `{tags, tagged, untagged, labeler}`; `__sql` GROUP BY tag shows plausible topical groups; `tag:"…"` in search box ≡ chip click; rename/hide reflected in both popup and page; no keys + no Nano → deterministic TF-IDF labels across two runs; Anthropic key → `labeler:"cloud"`.

## Execution steps (this task)

1. Create `docs/plans/semantic-search.md` with Plan A in full (context, topology + rationale, vendoring, schema, file-by-file changes at function level, message-protocol table, options-page/cloud-key design, risks, verification).
2. Create `docs/plans/auto-tagging.md` with Plan B in full, opening with an explicit "Depends on Plan A" section naming the shared infra it reuses (embeddings columns, AI worker/orchestrator, options page, `ai()` helper, `makeWorkerClient`).
3. No source files change; `node --check` not applicable (markdown only). Verify by re-reading both docs for self-containedness — each must be executable by an engineer without this conversation.

## Verification (this task)

Both files exist under `docs/plans/`, each self-contained (an engineer can implement from the doc alone), Plan B explicitly cross-references Plan A's shared infrastructure, and the feature-level verification sections above are embedded in the respective docs.
