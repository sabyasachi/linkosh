# Adding `collection` to the embedded row text — measured impact

Status: evaluated offline and implemented (2026-07-16) — rowText appends stoplist-filtered
labels, and `ROWTEXT_VERSION` (appended to every embedder id) triggers the corpus re-embed.
Context in [search-quality-analysis.md](search-quality-analysis.md).

## Hypothesis

`rowText` (core/ai/orchestrator.ts) embeds only title+publication+summary. `collection` holds
the user's *own topical labels* — "movie" (36 FB items), "Recipe" (59 IG + 22 FB), "Philosophy"
(94 FB + 41 IG), "Fitness", "books", "travel" — which today are visible to FTS but invisible to
the semantic ranking and to the vector arm of hybrid. Appending them should directly lift
semantic recall for curated items, especially thin-text ones (quote-images whose caption is
"❤️").

## Method

Corpus embedded twice with ollama `all-minilm` (verified ≈ stored vectors, see
[embedding-model-comparison.md](embedding-model-comparison.md)): once with the current
`rowText`, once with topical collection labels appended as a final line. Housekeeping labels
were stoplisted (provider defaults with no topical meaning): `upvoted` (all 2,918 HN rows),
`Watch Later`, `posts`, `saved`, `all bookmarks`. 734 of 6,809 rows carry a topical label.
"Tagged" below = items whose collection matches the query term.

## Results (MiniLM, semantic ranking)

| Query | tagged items | median rank before → after | in top-50 | in top-200 |
|---|---|---|---|---|
| movie | 51 | 205 → **49** | 2 → **27** | 25 → 47 |
| philosophy | 137 | 1151 → **82** | 3 → **41** | 11 → 91 |
| fitness | 46 | 274 → **49** | 3 → **24** | 21 → 41 |
| travel | 30 | 1802 → **421** | 4 → 8 | 7 → 13 |
| recipe | 87 | 88 → 73 | 26 → 32 | 67 → 81 |

The gain is largest exactly where content text is weakest: "philosophy" items are mostly
quote-images with emoji captions — unfindable semantically today, and the user's label is the
only topical text they will ever have. "recipe" barely moves because recipe posts already say
"recipe" in their captions.

## Known side effect

For near-empty items the appended label *dominates* the embedding: "🥵🩸" (filed under
"movie") lands at similarity 0.74 for the query "movie", above genuine movie articles.
Assessed as mostly-correct behavior (the user explicitly filed it; there is no other way to
retrieve it), but it means thin-text items cluster at the top rather than blending in by
content. If it proves annoying, damp it (e.g. append the label only when base text is
non-trivial, or lowercase/single-mention) rather than abandoning the signal.

## Implementation notes (tracked as tasks)

- `rowText` gains `collection` filtered through the stoplist; `PendingEmbeddingRow`
  (core/db/embeddings.ts) must carry the column; keep the 1000-char cap *after* appending.
- Poster fields stay excluded (author-clustering rationale in CLAUDE.md holds; the known cost
  is topical channel names like "MUBI India" on title-only YouTube rows).
- A `rowText` definition change does not regenerate existing embeddings — bump the model tag
  (`local:minilm-l6-v2-q8` → `…-v2`) so every row goes pending and the existing single-flight
  backlog drain re-embeds the corpus.
- This change does not rescue collectionless items (X bookmarks have no folders — the
  canonical missing tweet is unaffected); pair with the ranking fixes in
  [search-quality-analysis.md](search-quality-analysis.md).
