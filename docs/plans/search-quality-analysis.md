# Semantic search quality — root-cause analysis

Status: analysis complete (2026-07-16); recommendations 1–3 implemented same day (LNK-2/3/4/7 —
hybrid pool 500, query-adaptive similarity floor, collections in rowText, `ROWTEXT_VERSION`
re-embed trigger). Query expansion (rec. 4) canceled as superseded by the model swap's query
prefix; model swap (rec. 5, LNK-8) still open. Companion docs:
[embedding-model-comparison.md](embedding-model-comparison.md) (MiniLM vs bge-small A/B),
[embedding-collections-eval.md](embedding-collections-eval.md) (adding `collection` to the
embedded text).

## Symptom

Semantic search feels low-quality: relevant items missing, marginal items present. Canonical
miss: searching "movie" does not surface https://x.com/theliverdoc/status/2076673804680798668
(item #4770 in the 2026-07-16 export, 6,809 rows, all embedded with `local:minilm-l6-v2-q8`).

## What was ruled out

- **Ingestion/embedding health.** Every row has an embedding; #4770's stored vector is *good* —
  its nearest neighbors by stored-vector cosine are exactly right ("Underrated gems everyone
  must watch", "These Secret Netflix Codes Can Reveal Tons of Hidden Categories", "All the Best
  Movies Coming to and Leaving Netflix").
- **Vector corruption / model drift.** Re-embedding sampled rows reproduces the stored vectors
  at cosine ≈ 0.99 (via ollama `all-minilm` F16; the residual is quantization difference).

## Root causes (measured, not guessed)

The tweet's entire embedded text is `"Netflix has silently added a gem. Do not miss it."` —
it never contains a movie word, so it lives or dies on vector similarity. With the current
MiniLM model, the query "movie" gives it similarity **0.229, rank 279** of 6,809. That trips
three independent mechanisms:

1. **The absolute similarity floor cuts it.** `MIN_SIMILARITY = 0.25`
   (core/db/search.ts) excludes it from *semantic* mode entirely — the miss is a hard filter,
   not a depth problem. Meanwhile the floor filters almost no noise: for random unrelated
   pairs, mean cosine is ~0.09 but the max against just 200 random strangers averages ~0.40,
   so 0.25 sits inside the noise band. Both user complaints ("missing relevant" and
   "irrelevant present") are the same phenomenon: MiniLM-L6 on short texts has heavy overlap
   between the "clearly related" and "coincidentally related" similarity bands. Example: the
   tweet's 8th-nearest neighbor is "We fell out of love with Next.js and back in love with
   Ruby on Rails" at 0.44 — the model reads "gem" as a Ruby gem.
2. **Hybrid mode's vector arm is capped at 100 candidates.** `CANDIDATES = 100` in
   `hybridSearch` (core/db/search.ts) — anything past cosine rank 100 never enters RRF fusion,
   and the FTS arm can't rescue an item with zero token overlap. `cosineTop` already scans
   every row; the cap only trims the fusion pool, so raising it is nearly free.
3. **One-word queries are the model's weak spot.** MiniLM-L6 is a symmetric sentence encoder,
   not trained for keyword→document retrieval. The query "movie recommendation" lifts the same
   tweet from excluded to rank 134 / sim 0.299. Query expansion before embedding is a cheap
   partial mitigation.

## Corpus texture that amplifies all of the above

Per-provider embeddable-text profile (title+publication+summary):

| provider | rows | avg chars | rows < 40 chars | fully empty |
|---|---|---|---|---|
| hackernews | 2,918 | 101 | 557 | 0 |
| twitter | 1,186 | 254 | 61 | 3 |
| linkedin | 982 | 990 | 34 | 13 |
| facebook | 851 | 325 | 282 | 0 |
| instagram | 551 | 436 | 64 | 14 |
| youtube | 318 | 58 (title-only) | 76 | 0 |
| substack | 3 | 892 | 1 | 1 |

~980 rows have under 40 chars of text; 31 rows have none at all and embed their URL
(orchestrator `rowText` fallback) — permanent near-noise in every semantic result set.
Thin texts are also where the collection-label experiment shows the largest gains (see
companion doc).

## Recommendations (in leverage order)

1. Raise hybrid `CANDIDATES` 100 → 500.
2. Replace the absolute 0.25 semantic floor with a relative cutoff (~65% of the top score):
   0.25 cuts real matches (the tweet at 0.229) while passing noise; a relative floor adapts
   per-query. Note any absolute floor must be recalibrated per model anyway (bge scores
   *everything* above 0.25 — see companion doc).
3. Add topical `collection` labels to the embedded row text (large measured win; companion doc).
4. Expand one-word queries before embedding.
5. Model swap to a retrieval-trained small model (bge-small-en-v1.5) — worthwhile but a bigger,
   separate step, and it does not rescue thin-text items (measured: this tweet only moves
   279 → 176). Their ceiling is the data, not the model; the durable fix there is enriching
   the embedded text (e.g. image alt-text/OCR for photo tweets), which is a feature.

## Method notes

Query-side vectors could not use huggingface.co on the analysis day (CloudFront outage);
rankings were computed against the exported DB with ollama (`all-minilm`, verified 0.99
against stored vectors before trusting anything). The harness embeds queries/corpus via
ollama's `/api/embed` (L2-normalizing client-side, as the extension does) and reproduces
`cosineTop` over the `saved_items.embedding` BLOBs with node:sqlite. See
[embedding-model-comparison.md](embedding-model-comparison.md) appendix for the script.
