# Embedding model A/B: MiniLM-L6 (current) vs bge-small-en-v1.5

Status: evaluated offline (2026-07-16), no code change yet. Context in
[search-quality-analysis.md](search-quality-analysis.md).

## Question

Would swapping `local:minilm-l6-v2-q8` for a retrieval-trained small model
(bge-small-en-v1.5, same size class, ONNX build available on the Xenova hub for
transformers.js) fix the observed misses?

## Method

- Corpus: 2026-07-16 export (6,809 rows, all embedded).
- Embedders: ollama `all-minilm:latest` (F16) and `qllama/bge-small-en-v1.5:latest` (Q8_0),
  huggingface.co being down that day. Ollama variants are requantizations of the same base
  models — **validated** by re-embedding a 20-row sample with `all-minilm` and comparing to the
  DB's stored ONNX-q8 vectors: cosine mean 0.9908 (min 0.9863). Vectors L2-normalized
  client-side, matching the extension invariant.
- bge queries embedded with the required asymmetric-retrieval prefix
  `"Represent this sentence for searching relevant passages: "`; documents unprefixed.
- Baseline doc vectors = the DB's stored embeddings; bge doc vectors = full corpus re-embed
  (~53 s on CPU via ollama).

## Results

Target = the canonical miss, x.com/theliverdoc/status/2076673804680798668
("Netflix has silently added a gem. Do not miss it.").

| Query | MiniLM rank (sim) | bge rank (sim) |
|---|---|---|
| movie | 279 (0.229 — below the 0.25 floor → excluded) | 176 (0.518) |
| movie recommendation | 134 (0.299) | 313 (0.517) |
| database | topical top-10 clean | topical top-10 cleaner |
| productivity | topical top-10 clean | topical top-10 cleaner |

Qualitative: bge's top-10 for "movie" surfaces keyword-free relevant items MiniLM misses
("This scene is cinema at its absolute peak", "Not all gems shine at the box office…"), and its
topical queries are more precise. Both models rank the target tweet deep — with 300+ items
explicitly about movies in the corpus, no ranker puts a tweet that never mentions films near
the top. **The swap improves general precision; it does not rescue thin-text items.**

## Load-bearing caveats for an actual swap

- **Similarity scale shifts completely.** Under bge, all 6,808 non-target items score ≥ 0.25 —
  the current `MIN_SIMILARITY = 0.25` would filter nothing. bge's useful floor is roughly
  0.5; a relative (top-score–proportional) floor sidesteps per-model calibration entirely.
- **Query prefix is mandatory** for bge-class models (queries only, never documents); skipping
  it forfeits most of the retrieval advantage. The embedder provider (src/workers/embedders.ts)
  would need a query/document distinction it doesn't have today.
- Full corpus re-embed required (the model-tag change makes every row pending; the existing
  backlog drain handles it).

## Verdict

Worthwhile, but sequence it *after* the cheap ranking fixes (hybrid candidate cap, relative
floor, collections in row text) — those recover the actual reported misses; the model swap is
a general-precision upgrade with real migration overhead.

## Appendix — harness

`node:sqlite` over the export + ollama `/api/embed`, reproducing `cosineTop`'s brute-force dot
product. Sketch (full scripts lived in the session scratchpad: `eval.mjs`, `rank.ts`):

```js
// verify ollama ≈ stored ONNX-q8 before trusting rankings
const sample = await embed("all-minilm", sampleRows.map(rowText));
// cosine(stored[i], sample[i]) → mean 0.9908

// ranking: query vector vs every stored/re-embedded doc vector, sort desc
const [qv] = await embed(model, isBge ? [BGE_QUERY_PREFIX + q] : [q]);
rows.map((r, i) => dot(docVecs[i], qv)).sort(desc);
```

`rowText` must mirror core/ai/orchestrator.ts exactly (title+publication+summary → url →
"Saved item", sliced to 1000 chars) or the verification step fails.
