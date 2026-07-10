# Plan B — Auto-tagging / smart collections

Status: proposed (not implemented). **Depends on Plan A ([semantic-search.md](semantic-search.md));
ship strictly after it.**

Shared infrastructure reused from Plan A:

- `saved_items.embedding` / `embedding_model` columns and the embed-backlog pipeline.
- `ai/worker.js` (gains a `cluster` op) and `ai/orchestrator.js` (gains `generateTags`).
- The options page and `ai:settings` key storage (Anthropic/OpenAI keys for labeling).
- The `ai()` helper in background.js and the `makeWorkerClient` refactor in offscreen.js.
- The `ITEM_COLUMNS` constant in db/worker.js (gains `tag`).

## Context

The archive spans seven services but has no cross-service organization beyond per-provider
`collection` values. This plan clusters the embedded corpus, names each cluster, and writes the
name into a new FTS-indexed `tag` column, so tags behave exactly like the existing `kind:` /
`collection:` facets — searchable from the box, clickable as chips. Labeling prefers a cloud LLM
key (from Plan A's options page), then Chrome's built-in Gemini Nano (Prompt API), then a
deterministic TF-IDF fallback. Re-clustering is a manual, explicit action.

## Pipeline

`db.allEmbeddings` → `ai.cluster` (AI worker) → labeling chain (orchestrator) → `db.applyTags`
(clears previous auto-tags first, so each run fully replaces the taxonomy) → UI chips + FTS facet.

**Manual trigger only.** Clustering rewrites the taxonomy — labels shift, user renames are lost —
so it must never happen silently after a background sync. Post-sync, if more than ~50 new items
landed, the popup status appends a passive hint: "N new items — consider re-tagging (page view)".
Items synced between runs simply stay untagged; that's acceptable.

## Clustering algorithm (`ai/worker.js`, new `cluster` op — pure JS, no deps)

**Spherical mini-batch k-means.** Vectors are already L2-normalized (Plan A guarantees this for
local and cloud providers), so cosine == dot.

- Agglomerative was rejected: O(n²) pairwise cosine at 20k rows ≈ 4×10⁸ 384-dim dots — minutes in
  single-threaded JS. Mini-batch k-means is O(n·k·iters) — seconds.
- k selection: candidates `k ∈ {8, 12, 16, 24, 32}` clamped to `≤ n/20`. For each: mini-batch
  k-means with k-means++ seeding on a 2k-row sample, batch 256, ~80 iterations, centroids
  re-normalized after each update. Score with **simplified silhouette on a 500-point sample**
  (a(i) = distance to own centroid, b(i) = distance to nearest other centroid — O(sample·k), no
  pairwise matrix). Pick the best-scoring k. Total well under 10 s at 20k rows, and it runs in the
  AI worker so nothing blocks.
- Final full assignment pass over all vectors. **Confidence floor:** items whose best-centroid dot
  is < 0.35 get tag `''` (untagged) — prevents junk clusters from claiming weakly-embedded rows.
- Deterministic seed (fixed PRNG) so re-runs on unchanged data produce identical clusters.
- Emits progress messages (`{ id, progress: { phase, pct } }`) interleaved before the final reply;
  the orchestrator forwards them into its status object.

Returns per cluster: `memberIds`, `centroid`, `exemplarIds` (the 12 members nearest the centroid),
plus `untaggedIds`.

## Labeling chain (`ai/orchestrator.js`, offscreen *document* context)

1. **Always** compute the deterministic candidate first: top TF-IDF terms — document frequency over
   the whole corpus's `title+subtitle+summary` tokens (via a new `corpusTexts` db op), term
   frequency within the cluster; top 2 terms, title-cased ("Rust Async", "Home Espresso"). This is
   both the fallback and the sanity anchor.
2. If `ai:settings` holds an Anthropic or OpenAI key: **one batched prompt per run** covering all
   clusters' exemplar titles/subtitles → "give each cluster a 1–3 word topic label; labels must be
   distinct; return a JSON array". Anthropic: `claude-haiku` via the Messages API with the
   `anthropic-dangerous-direct-browser-access: true` header (required for browser-origin calls;
   the origin is already in Plan A's `optional_host_permissions`).
3. Else, if `typeof LanguageModel !== "undefined"` and
   `await LanguageModel.availability() === "available"`: Prompt API (Gemini Nano) session in the
   offscreen **document** (do not assume it works inside a dedicated worker), one JSON-constrained
   prompt per cluster. If availability is `"downloadable"`, do **not** auto-trigger the multi-GB
   download — report "built-in model not downloaded", use the fallback, and offer a
   "Download built-in model" button on the options page (which calls `LanguageModel.create()`
   there).
4. Else: the TF-IDF label from step 1.
5. Post-process: dedupe labels (append a TF-IDF disambiguator on collision), cap at 24 chars,
   strip quotes/newlines.

The run's result reports which leg was used: `labeler: "cloud" | "nano" | "tfidf"`.

## Schema migration (db/worker.js)

Append-only column plus the existing FTS drop/recreate/rebuild pattern:

- `ALTER TABLE saved_items ADD COLUMN tag TEXT NOT NULL DEFAULT ''` — at the very end (after
  Plan A's embedding columns); one more line in `migrate()`.
- **FTS:** add `tag` to the FTS5 column list, to all three triggers, and to the stale check:
  `const stale = fts.size > 0 && !(fts.has("collection") && fts.has("kind") && fts.has("tag"))` —
  the existing drop/recreate/`rebuild` machinery then upgrades old DBs (a one-time few-second
  rebuild on first message after the update; `dbReady` already serializes callers). After this,
  `tag:"rust async"` works from the search box with **zero** `ftsQuery()` changes — its `/\S:/`
  passthrough already forwards column filters.
- New plain table, created alongside SCHEMA (additive, no migration concern):

  ```sql
  CREATE TABLE IF NOT EXISTS tag_meta (name TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0);
  ```

- **Why a column, not a join table:** the FTS index is `content='saved_items'` — facet-searchable
  tags must be a column of the content table. One auto-tag per item (its cluster assignment) is
  the model anyway; multi-tag would forfeit facet search or require restructuring FTS. Trade-off
  accepted; document it in a comment.

## File-by-file changes

### `db/worker.js` — new ops

- `allEmbeddings({ model })` → `[{ id, vector: Float32Array }]`. postMessage-to-offscreen only —
  never chrome.runtime. ~30 MB structured clone at 20k rows; fine as a one-shot, never on a timer.
- `corpusTexts()` → `[{ id, text }]` (title+subtitle+summary) for TF-IDF.
- `applyTags({ assignments: [{ id, tag }] })` — first `UPDATE saved_items SET tag = '' WHERE
  tag != ''` (a run fully replaces the auto taxonomy), then a prepared UPDATE in one transaction.
  The existing AFTER UPDATE trigger keeps FTS in sync.
- `listTags({ provider })` → `SELECT tag AS name, COUNT(*) n FROM saved_items WHERE tag != ''
  [AND provider = ?] GROUP BY tag ORDER BY n DESC`, left-joined with `tag_meta` for `hidden`.
- `renameTag({ from, to })` — `UPDATE saved_items SET tag = ? WHERE tag = ?` (renaming onto an
  existing name = merge; triggers reindex the affected FTS rows); move the `tag_meta` row.
- `setTagHidden({ name, hidden })` — upsert into `tag_meta`.
- `ITEM_COLUMNS` (from Plan A) gains `tag` so list/search rows carry it.

### `ai/worker.js` — new op

- `cluster({ vectors, minK, maxK })` → `{ clusters: [{ memberIds, exemplarIds }], untaggedIds }`
  per the algorithm above, with interleaved progress messages.

### `ai/orchestrator.js` — new op `generateTags()`

`db.embeddingStats` (refuse with a clear error if the embed backlog exceeds 10% — "embeddings
still building") → `db.allEmbeddings` → `ai.cluster` → labeling chain → `db.applyTags` → returns
`{ tags, tagged, untagged, labeler }`. Single-flight like `embedBacklog`. Plan A's `status()`
gains `tagging: { running, phase }`.

### `background.js` — new cases

- `tags:generate` → `ai("generateTags")` — this one **is** awaited (runs ~10–30 s, acceptable for
  a `sendResponse`; the UI shows progress by polling `ai:status`).
- `tags:list { providerId }` → `db("listTags", …)`; `tags:rename { from, to }`;
  `tags:hide { name, hidden }`.

### `popup/popup.js` + `popup/popup.html` + `page/page.html` + `popup/popup.css`

- New `<div id="tags"></div>` between `#search` and `#status` — in **both** html files (popup.js is
  shared verbatim, so the markup must exist in both).
- `loadTags()` (called from init, after provider change, and after tag generation): `tags:list` →
  render the top 20 non-hidden tags as chips `[name (n)]`. Chip click →
  `searchInput.value = 'tag:"' + name.replaceAll('"','""') + '"'; onSearchInput()` — riding the
  existing FTS facet path end to end. Active chip highlighted; clicking it again clears
  (`searchInput.value = ""; loadItems()`).
- Page view only (e.g. detected via a class on `<body>` in page.html): an "Auto-tag" button in the
  header. Click → `confirm("Re-tagging replaces all current auto-tags and loses any renames")` →
  `tags:generate`, with status text driven by polling `ai:status` ("Clustering… / Labeling…"),
  then `loadTags()`. popup.html omits the button (small surface).
- Overrides, pragmatic scope (page view): each chip gets a `…` affordance →
  `prompt("Rename tag", name)` → `tags:rename` (renaming onto an existing tag = merge — say so in
  the prompt text), plus a hide option (`tags:hide`).
- `buildItems`: append `item.tag` to the meta line (it already joins facets with `·`).
- **Explicit non-goals for v1:** manual per-item tagging, multi-tag, drag-and-drop; renames do not
  survive the next `tags:generate` (the confirm() dialog says so).

### `options/options.js` (from Plan A)

Add: a labeling-provider status line (which of cloud / Nano / TF-IDF the next run will use), and a
"Download built-in model" button shown when `LanguageModel.availability() === "downloadable"`.

## Open risks

- **Prompt API availability is the shakiest leg** — requires Chrome ≥ 138, a multi-GB Nano
  download, and its exposure inside offscreen documents isn't guaranteed on all channels. The
  chain (cloud → Nano → TF-IDF) makes it an enhancement, never a dependency. Verify `LanguageModel`
  presence in the offscreen-document console early; if absent there, run Prompt API calls from the
  options/page context instead.
- **Cluster quality on mixed corpora** — thin-text rows (YouTube: title+channel+views; LinkedIn:
  snippet) embed weakly and tend to pool; the 0.35 confidence floor leaves them untagged rather
  than mislabeled. Tune the floor and k-grid after the first real-corpus run.
- **Label instability across runs** is inherent to rebuild-the-world tagging; mitigated by the
  deterministic seed (same data → same clusters) and honest confirm() messaging.
- **FTS rebuild on upgrade** — adding `tag` to FTS triggers the one-time drop/recreate/rebuild on
  existing DBs; a few seconds on large DBs at first message after reload.

## Verification

1. `node --check` all touched files; reload at `chrome://extensions`.
2. DB-worker console: `__sql("PRAGMA table_info(saved_items)")` → `tag` last;
   `__sql("SELECT tag FROM saved_items_fts LIMIT 1")` succeeds → FTS was rebuilt with the `tag`
   column.
3. From a `debug.html` tab: `chrome.runtime.sendMessage({type:"tags:generate"}, console.log)` →
   `{ tags, tagged, untagged, labeler }`; then `{type:"tags:list", providerId:"all"}` → chip data.
   DB worker: `__sql("SELECT tag, COUNT(*) FROM saved_items GROUP BY tag ORDER BY 2 DESC")` →
   plausible topical groupings against the real corpus.
4. Search box: `tag:"<one of the labels>"` returns only that cluster's rows (proves the FTS facet
   path). Clicking the same chip yields identical results.
5. Rename a tag on the page view → `__sql("SELECT COUNT(*) FROM saved_items WHERE tag='<new>'")`
   matches; `tag:"<new>"` works and `tag:"<old>"` is empty. Hide a tag → chip disappears in both
   popup and page.
6. Labeler fallbacks: with no keys and no Nano → labels are TF-IDF terms, identical across two
   runs; add an Anthropic key → labels improve and the response reports `labeler:"cloud"`.
7. Run `tags:generate` twice on unchanged data → identical assignments (deterministic seed).
