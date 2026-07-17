// DbApi — the complete DB surface as one typed method map. The DB worker
// serves it over postMessage; everything else (orchestrator, sync, background,
// tools) holds a Client<DbApi> or the direct service. The Float32Array-bearing
// methods (storeEmbeddings, cosineTop, hybridSearch, semanticSearch) exist
// only behind the worker/postMessage transport — typed arrays never ride
// chrome.runtime.
import type { IngestReport, ProviderId, RawDataRow, SavedItem } from "../types.ts";
import type { SqlDatabase } from "./port.ts";
import * as items from "./items.ts";
import * as raw from "./raw.ts";
import * as embeddings from "./embeddings.ts";
import * as search from "./search.ts";

export interface DbApi {
  knownIds(args: { provider: ProviderId; createdBefore?: number }): string[];
  upsert(args: items.UpsertArgs): { inserted: number; updated: number };
  list(args: items.ListArgs): SavedItem[];
  search(args: items.SearchArgs): SavedItem[];
  setDeleted(args: { id: number; deleted: boolean }): { changed: number };
  setStarred(args: { id: number; starred: boolean }): { changed: number };
  count(args: { provider?: ProviderId | null; deleted?: boolean; starred?: boolean }): number;
  providerStats(args: Record<string, never>): items.ProviderStatsRow[];
  clearItems(args: { provider?: ProviderId | null }): { deleted: number };

  rawStore(args: raw.RawStoreArgs): { stored: number };
  rawPending(args: raw.RawSelectArgs): RawDataRow[];
  rawFailed(args: raw.RawSelectArgs): RawDataRow[];
  rawAll(args: raw.RawSelectArgs): RawDataRow[];
  rawMark(args: { id: number; status: "pending" | "ingested" | "failed"; error?: string | null }): {
    id: number;
    status: string;
  };
  rawKnownIds(args: { provider: ProviderId; fetchedBefore?: number }): string[];
  rawClear(args: { provider?: ProviderId | null }): { cleared: true };
  rawStats(args: Record<string, never>): raw.RawStatsRow[];

  pendingEmbeddings(args: { model: string; limit?: number }): embeddings.PendingEmbeddingRow[];
  storeEmbeddings(args: { model: string; rows: { id: number; vector: Float32Array }[] }): {
    stored: number;
  };
  embeddingStats(args: { model: string }): { total: number; embedded: number };

  cosineTop(args: search.CosineTopArgs): { id: number; similarity: number }[];
  hybridSearch(args: search.HybridSearchArgs): SavedItem[];
  semanticSearch(args: search.SemanticSearchArgs): SavedItem[];
  similar(args: { id: number; provider?: ProviderId | null; limit?: number }): SavedItem[];
}

/** The worker's superset of DbApi: extension-specific ops (OPFS export) and
 *  the ingest replays that must run next to the DB (page bodies never make a
 *  second trip over chrome.runtime). */
export interface DbWorkerApi extends DbApi {
  export(args: Record<string, never>): { file: string; size: number };
  rawIngest(args: { provider?: ProviderId | null }): IngestReport;
  rawReingest(args: { provider?: ProviderId | null }): IngestReport;
}

export function createDbService(db: SqlDatabase): DbApi {
  return {
    knownIds: (args) => items.knownIds(db, args),
    upsert: (args) => items.upsert(db, args),
    list: (args) => items.list(db, args),
    search: (args) => items.search(db, args),
    setDeleted: (args) => items.setDeleted(db, args),
    setStarred: (args) => items.setStarred(db, args),
    count: (args) => items.count(db, args),
    providerStats: () => items.providerStats(db),
    clearItems: (args) => items.clearItems(db, args),

    rawStore: (args) => raw.rawStore(db, args),
    rawPending: (args) => raw.rawPending(db, args),
    rawFailed: (args) => raw.rawFailed(db, args),
    rawAll: (args) => raw.rawAll(db, args),
    rawMark: (args) => raw.rawMark(db, args),
    rawKnownIds: (args) => raw.rawKnownIds(db, args),
    rawClear: (args) => raw.rawClear(db, args),
    rawStats: () => raw.rawStats(db),

    pendingEmbeddings: (args) => embeddings.pendingEmbeddings(db, args),
    storeEmbeddings: (args) => embeddings.storeEmbeddings(db, args),
    embeddingStats: (args) => embeddings.embeddingStats(db, args),

    cosineTop: (args) => search.cosineTop(db, args),
    hybridSearch: (args) => search.hybridSearch(db, args),
    semanticSearch: (args) => search.semanticSearch(db, args),
    similar: (args) => search.similar(db, args),
  };
}
