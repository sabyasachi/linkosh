// Vector search: brute-force cosine ranking (vectors are L2-normalized, so
// dot product == cosine; 10k rows × 384 dims ≈ 4M multiplies — a few ms, no
// index needed), plus the three rankings built on it: semantic, hybrid (RRF
// with FTS) and "more like this".
import type { ProviderId, SavedItem } from "../types.ts";
import type { SqlDatabase } from "./port.ts";
import { fetchByIds, search as ftsSearch } from "./items.ts";
import { toVector } from "./embeddings.ts";

// Similarity floor for semantic ranking. A fixed absolute floor fails at both
// ends with MiniLM-class models (measured on a 6.8k-row corpus, see
// docs/plans/search-quality-analysis.md): unrelated short texts reach ~0.4, so
// 0.25 filters almost no noise, while genuinely relevant lexically-different
// rows can score below it. Instead the floor adapts to the query: half the top
// score, clamped so an outlier top hit can't nuke recall (max) and a weak-top
// query still sheds pure noise (min).
export const SIM_FLOOR_MIN = 0.2;
export const SIM_FLOOR_MAX = 0.35;
export const SIM_FLOOR_FACTOR = 0.5;

/** Query-adaptive similarity floor given the best similarity in the result. */
export function similarityFloor(topScore: number): number {
  return Math.min(SIM_FLOOR_MAX, Math.max(SIM_FLOOR_MIN, SIM_FLOOR_FACTOR * topScore));
}

export interface CosineTopArgs {
  queryVector: Float32Array;
  model: string;
  provider?: ProviderId | null;
  limit?: number;
  excludeId?: number | null;
  minScore?: number;
}

/** Top-N rows by cosine similarity to queryVector, over rows embedded with
 *  `model`. Returns [{id, similarity}] sorted desc. */
export function cosineTop(
  db: SqlDatabase,
  { queryVector, model, provider, limit = 100, excludeId = null, minScore = 0 }: CosineTopArgs
): { id: number; similarity: number }[] {
  const candidates = db.rows<{ id: number; embedding: Uint8Array }>(
    `SELECT id, embedding FROM saved_items
     WHERE embedding IS NOT NULL AND embedding_model = ? ${provider ? "AND provider = ?" : ""}`,
    provider ? [model, provider] : [model]
  );
  const top: { id: number; similarity: number }[] = []; // sorted desc, length <= limit
  for (const row of candidates) {
    if (row.id === excludeId) continue;
    const vec = toVector(row.embedding);
    if (vec.length !== queryVector.length) continue; // stale row from another model dim
    let dot = 0;
    for (let i = 0; i < vec.length; i++) dot += vec[i]! * queryVector[i]!;
    if (dot < minScore) continue;
    if (top.length === limit && dot <= top[top.length - 1]!.similarity) continue;
    let at = top.length;
    while (at > 0 && top[at - 1]!.similarity < dot) at--;
    top.splice(at, 0, { id: row.id, similarity: dot });
    if (top.length > limit) top.pop();
  }
  return top;
}

export interface HybridSearchArgs {
  query: string;
  queryVector: Float32Array;
  model: string;
  provider?: ProviderId | null;
  limit?: number;
}

/** Reciprocal Rank Fusion of the FTS ranking and the cosine ranking, k = 60:
 *  score(id) = Σ over lists containing id of 1 / (60 + rank). Robust to the
 *  incomparable score scales (FTS bm25 vs cosine) because only ranks matter. */
export function hybridSearch(
  db: SqlDatabase,
  { query, queryVector, model, provider, limit = 200 }: HybridSearchArgs
): SavedItem[] {
  const K = 60;
  // The vector arm is hybrid's recall channel: RRF is rank-based, so deep
  // low-similarity candidates dilute harmlessly instead of polluting — hence
  // the loose absolute guard rather than the query-adaptive semantic floor,
  // and a pool deep enough (500, was 100) that a relevant row with no FTS
  // token overlap still enters the fusion. cosineTop scans every row either
  // way; the pool size only bounds what's kept.
  const CANDIDATES = 500;
  const ftsRows = ftsSearch(db, { provider: provider ?? null, query, limit: CANDIDATES });
  const vecTop = cosineTop(db, {
    queryVector,
    model,
    provider: provider ?? null,
    limit: CANDIDATES,
    minScore: SIM_FLOOR_MIN,
  });

  const score = new Map<number, number>();
  const ftsRank = new Map<number, number>(); // tie-break: prefer the FTS order
  ftsRows.forEach((row, i) => {
    ftsRank.set(row.id, i + 1);
    score.set(row.id, 1 / (K + i + 1));
  });
  vecTop.forEach(({ id }, i) => {
    score.set(id, (score.get(id) ?? 0) + 1 / (K + i + 1));
  });

  const ids = [...score.keys()].sort((a, b) => {
    const d = score.get(b)! - score.get(a)!;
    if (d) return d;
    return (ftsRank.get(a) ?? Infinity) - (ftsRank.get(b) ?? Infinity);
  });
  return fetchByIds(db, ids.slice(0, limit));
}

export interface SemanticSearchArgs {
  queryVector: Float32Array;
  model: string;
  provider?: ProviderId | null;
  limit?: number;
}

/** Pure vector ranking; rows carry a `similarity` field. */
export function semanticSearch(
  db: SqlDatabase,
  { queryVector, model, provider, limit = 200 }: SemanticSearchArgs
): SavedItem[] {
  const top = cosineTop(db, {
    queryVector,
    model,
    provider: provider ?? null,
    limit,
    minScore: SIM_FLOOR_MIN,
  });
  return withSimilarity(db, applyFloor(top));
}

/** Nearest neighbors of an existing item ("more like this"). */
export function similar(
  db: SqlDatabase,
  { id, provider, limit = 20 }: { id: number; provider?: ProviderId | null; limit?: number }
): SavedItem[] {
  const row = db.rows<{ embedding: Uint8Array | null; embeddingModel: string | null }>(
    "SELECT embedding, embedding_model AS embeddingModel FROM saved_items WHERE id = ?",
    [id]
  )[0];
  if (!row) throw new Error(`No item with id ${id}`);
  if (!row.embedding || row.embeddingModel === null) throw new Error("Item not embedded yet");
  const top = cosineTop(db, {
    queryVector: toVector(row.embedding),
    model: row.embeddingModel,
    provider: provider ?? null,
    limit,
    excludeId: id,
    minScore: SIM_FLOOR_MIN,
  });
  return withSimilarity(db, applyFloor(top));
}

/** Drop candidates below the query-adaptive floor (cosineTop returns sorted
 *  desc, so the first entry is the top score). */
function applyFloor(top: { id: number; similarity: number }[]): { id: number; similarity: number }[] {
  if (!top.length) return top;
  const floor = similarityFloor(top[0]!.similarity);
  return top.filter((t) => t.similarity >= floor);
}

function withSimilarity(db: SqlDatabase, top: { id: number; similarity: number }[]): SavedItem[] {
  const items = fetchByIds(db, top.map((t) => t.id));
  const sim = new Map(top.map((t) => [t.id, t.similarity]));
  for (const item of items) item.similarity = sim.get(item.id)!;
  return items;
}
