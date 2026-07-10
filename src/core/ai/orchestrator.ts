// Runs in the offscreen *document*. Owns all vector plumbing between the AI
// worker and the DB worker: vectors move only over postMessage (structured
// clone), never over chrome.runtime, whose JSON serialization would mangle
// typed arrays. The background only sends high-level AiApi commands.
import type { PendingEmbeddingRow } from "../db/embeddings.ts";
import type {
  AiSettings,
  EmbedderStatus,
  OrchestratorStatus,
  ProviderId,
  SavedItem,
  SearchMode,
  SearchResult,
} from "../types.ts";
import type { AiApi } from "./api.ts";
import { FTS_OPERATORS } from "../fts.ts";

// Row text fed to the embedding model; truncated so one pathological summary
// can't blow up inference time. Poster is deliberately excluded — it would
// cluster embeddings by author. Exported for tests.
export function rowText({
  title,
  publication,
  summary,
  url,
}: Pick<PendingEmbeddingRow, "title" | "publication" | "summary"> & { url?: string | null }): string {
  const content = [title, publication, summary].filter(Boolean).join("\n").trim();
  // Cloud embedding APIs reject empty strings. A URL still carries useful
  // semantic signal through its host/path; the final label handles malformed
  // or synthetic rows whose URL is empty too, without wedging the whole batch.
  return (content || url?.trim() || "Saved item").slice(0, 1000);
}

/** The DB surface the orchestrator drives (promise-shaped: satisfied by a
 *  worker RPC client in the extension, a direct wrapper in tests). */
export interface OrchestratorDb {
  search(args: { provider?: ProviderId | null; query: string; limit?: number }): Promise<SavedItem[]>;
  pendingEmbeddings(args: { model: string; limit?: number }): Promise<PendingEmbeddingRow[]>;
  storeEmbeddings(args: { model: string; rows: { id: number; vector: Float32Array }[] }): Promise<{
    stored: number;
  }>;
  embeddingStats(args: { model: string }): Promise<{ total: number; embedded: number }>;
  hybridSearch(args: {
    query: string;
    queryVector: Float32Array;
    model: string;
    provider?: ProviderId | null;
    limit?: number;
  }): Promise<SavedItem[]>;
  semanticSearch(args: {
    queryVector: Float32Array;
    model: string;
    provider?: ProviderId | null;
    limit?: number;
  }): Promise<SavedItem[]>;
}

/** The embedder surface (promise-shaped Client<EmbedderApi>). */
export interface OrchestratorEmbedder {
  configure(args: { settings: AiSettings | null }): Promise<{ model: string }>;
  status(args: Record<string, never>): Promise<EmbedderStatus>;
  embed(args: { texts: string[] }): Promise<Float32Array[]>;
}

export interface CreateOrchestratorOptions {
  db: OrchestratorDb;
  ai: OrchestratorEmbedder;
  /** How the initial embedding settings are fetched — injected because this
   *  module also runs under Node in tests. In the extension it relays through
   *  the background (offscreen documents can't read chrome.storage): settings
   *  are *pulled* once at creation, and the background *pushes* configure()
   *  whenever the options page saves. */
  getSettings?: () => Promise<AiSettings | null>;
}

/** Promise-shaped AiApi — what createOrchestrator actually returns. */
export type Orchestrator = {
  [K in keyof AiApi]: (args: Parameters<AiApi[K]>[0]) => Promise<ReturnType<AiApi[K]>>;
};

export function createOrchestrator({ db, ai, getSettings }: CreateOrchestratorOptions): Orchestrator {
  const configure = async (settings?: AiSettings | null): Promise<void> => {
    if (settings === undefined) settings = (await getSettings?.()) ?? null;
    await ai.configure({ settings });
  };
  const configured = configure().catch(() => {});

  // Single-flight backlog drain: overlapping triggers (post-sync + startup +
  // options-page rebuild) coalesce onto the running loop. Idempotent — a
  // crash mid-loop just leaves `embedding IS NULL` rows for the next trigger.
  let backlogRun: Promise<void> | null = null;
  let backlogProgress = { running: false, done: 0, total: 0 };

  async function drainBacklog(): Promise<void> {
    await configured;
    const { model } = await ai.status({});
    const stats = await db.embeddingStats({ model });
    backlogProgress = { running: true, done: 0, total: stats.total - stats.embedded };
    try {
      for (;;) {
        const pending = await db.pendingEmbeddings({ model, limit: 64 });
        if (!pending.length) break;
        for (let i = 0; i < pending.length; i += 16) {
          const batch = pending.slice(i, i + 16);
          const vectors = await ai.embed({ texts: batch.map(rowText) });
          await db.storeEmbeddings({
            model,
            rows: batch.map((row, j) => ({ id: row.id, vector: vectors[j]! })),
          });
          backlogProgress.done += batch.length;
        }
      }
    } finally {
      backlogProgress = { ...backlogProgress, running: false };
    }
  }

  function embedBacklog(): Promise<void> {
    backlogRun ??= drainBacklog().finally(() => (backlogRun = null));
    return backlogRun;
  }

  async function status(): Promise<OrchestratorStatus> {
    await configured;
    const aiStatus = await ai.status({});
    const stats = await db.embeddingStats({ model: aiStatus.model });
    return {
      modelReady: aiStatus.ready,
      model: aiStatus.model,
      downloading: aiStatus.downloading,
      error: aiStatus.error,
      backlog: stats.total - stats.embedded,
      embedded: stats.embedded,
      total: stats.total,
      embedding: backlogProgress,
    };
  }

  // mode is the user's selector choice: "fts" (default) | "hybrid" |
  // "semantic". The response reports what actually ran so the UI can explain
  // fallbacks ("text-only (model warming up)").
  async function search({
    query,
    provider,
    limit = 200,
    mode = "fts",
  }: {
    query: string;
    provider?: ProviderId | null;
    limit?: number;
    mode?: SearchMode;
  }): Promise<SearchResult> {
    const requested = mode;
    const fts = async (): Promise<SearchResult> => ({
      items: await db.search({ provider: provider ?? null, query, limit }),
      mode: "fts",
      requested,
    });

    if (mode === "fts") return fts();
    if (FTS_OPERATORS.test(query.trim())) return fts();

    // Keep interactive search responsive while a potentially long cloud/local
    // backlog batch owns the embedder. Text results return immediately; the UI
    // explains the temporary fallback and the next search can use vectors once
    // the drain finishes.
    if (backlogRun) return fts();

    await configured;
    const aiStatus = await ai.status({});
    if (!aiStatus.ready) {
      // Graceful fallback while the model downloads/loads; kick the backlog
      // so the model warms up (and rows get embedded) for next time.
      embedBacklog().catch(() => {});
      return fts();
    }
    // Model ready but zero rows embedded for it yet (fresh install, or the
    // user just switched embedding providers): vector search would be blind.
    const stats = await db.embeddingStats({ model: aiStatus.model });
    if (!stats.embedded) {
      embedBacklog().catch(() => {});
      return fts();
    }

    const [queryVector] = await ai.embed({ texts: [query] });
    const args = { query, queryVector: queryVector!, model: aiStatus.model, provider: provider ?? null, limit };
    const items = mode === "semantic" ? await db.semanticSearch(args) : await db.hybridSearch(args);
    return { items, mode, requested };
  }

  return {
    search,
    status,
    embedBacklog,
    configure: ({ settings }) => configure(settings ?? null),
  };
}
