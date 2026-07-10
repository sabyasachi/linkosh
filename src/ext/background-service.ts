// BackgroundApi — the complete surface the UI talks to — and its
// implementation. Deliberately chrome-free: every dependency (providers, DB
// client, AI client, prefs) is injected, so the same service backs the real
// background service worker (ext/background.ts, over chrome.runtime RPC) and
// the Node dev harness (tools/ux-server.ts, over HTTP RPC).
import type {
  AiSettings,
  AllSyncReport,
  IngestReport,
  OrchestratorStatus,
  Provider,
  ProviderId,
  ProviderMeta,
  SavedItem,
  SearchMode,
  SearchResult,
  SyncReport,
} from "../core/types.ts";
import type { AiApi } from "../core/ai/api.ts";
import type { DbWorkerApi } from "../core/db/service.ts";
import type { RawStatsRow } from "../core/db/raw.ts";
import type { Client, Handlers } from "../core/rpc/protocol.ts";
import type { Prefs } from "../core/prefs.ts";
import { createSync } from "../core/sync.ts";

// Test mode (dev setting): stop each sync after ~this many items, so a
// provider can be smoke-tested without a heavy fetch from the service.
const TEST_MODE_LIMIT = 100;

export interface BackgroundApi {
  listProviders(args: Record<string, never>): { id: ProviderId; label: string }[];
  /** provider: null means "across all providers" (the UI's "all" tab). */
  listItems(args: { provider: ProviderId | null; limit?: number; offset?: number }): {
    items: SavedItem[];
    total: number;
    meta: ProviderMeta | null;
  };
  search(args: { provider: ProviderId | null; query: string; mode?: SearchMode }): SearchResult;
  similar(args: { id: number; provider: ProviderId | null }): SavedItem[];
  sync(args: { provider: ProviderId; full?: boolean }): SyncReport;
  syncAll(args: { full?: boolean }): AllSyncReport;
  aiStatus(args: Record<string, never>): OrchestratorStatus;
  /** Asked by the offscreen orchestrator at creation (it can't read
   *  chrome.storage itself). */
  getAiSettings(args: Record<string, never>): AiSettings | null;
  /** Explicit backlog rebuild. Unlike automatic post-sync kicks, this waits
   *  so the options page can report an API/model failure to the user. */
  embed(args: Record<string, never>): void;
  exportDb(args: Record<string, never>): { file: string; size: number };
  /** Delete items (all providers) and reset sync state; raw_data untouched. */
  clearItems(args: Record<string, never>): { deleted: number };
  rawIngest(args: Record<string, never>): IngestReport;
  rawClear(args: Record<string, never>): { cleared: true };
  rawStats(args: Record<string, never>): { stats: RawStatsRow[]; captureRaw: boolean };
}

export interface BackgroundDeps {
  providers: Partial<Record<ProviderId, Provider>>;
  db: Client<DbWorkerApi>;
  ai: Client<AiApi>;
  prefs: Prefs;
}

export function createBackgroundService({ providers, db, ai, prefs }: BackgroundDeps): Handlers<BackgroundApi> {
  // Drain the embedding backlog without blocking (or failing) the caller.
  const embedSoon = () => void ai.embedBacklog({}).catch(() => {});

  // Embedding settings written by the options page. The offscreen document
  // has no chrome.storage access, so the orchestrator pulls them via
  // getAiSettings at creation and we push a reconfigure whenever they change.
  prefs.watch("ai:settings", (settings) => {
    ai.configure({ settings: settings ?? null })
      .then(embedSoon) // a provider switch usually means a re-embed backlog
      .catch(() => {});
  });

  const metaKey = (providerId: ProviderId) => `meta:${providerId}` as const;
  const getMeta = async (providerId: ProviderId) => (await prefs.get(metaKey(providerId))) ?? null;

  const sync = createSync({
    providers,
    db,
    getMeta,
    setMeta: (providerId, meta) => prefs.set(metaKey(providerId), meta),
    onSynced: () => embedSoon(), // pick up embeddings for whatever landed (even on partial sync)
  });

  // Capture mode (a dev setting, options page): syncs archive raw response
  // pages into raw_data instead of writing saved_items; the "Ingest raw"
  // action replays them through the same pipeline later. Off = normal sync.
  const getCaptureRaw = async () => Boolean(await prefs.get("captureRaw"));

  const syncOptions = async (full: boolean | undefined) => ({
    full: full ?? false,
    captureRaw: await getCaptureRaw(),
    maxItems: (await prefs.get("testMode")) ? TEST_MODE_LIMIT : 0,
  });

  return {
    listProviders: () =>
      Object.values(providers)
        .filter((p): p is Provider => Boolean(p))
        .map((p) => ({ id: p.id, label: p.label })),

    listItems: async ({ provider, limit, offset }) => ({
      items: await db.list({ provider, ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) }),
      total: await db.count({ provider }),
      meta: provider ? await getMeta(provider) : null,
    }),

    // mode is the user's selector choice; the result reports what actually
    // ran (may differ when the model isn't ready or the query uses FTS
    // operators).
    search: ({ provider, query, mode }) =>
      ai.search({ provider, query, limit: 200, ...(mode !== undefined ? { mode } : {}) }),

    similar: ({ id, provider }) => db.similar({ id, provider }),

    sync: async ({ provider, full }) => sync.syncProvider(provider, await syncOptions(full)),

    syncAll: async ({ full }) => sync.syncAllProviders(await syncOptions(full)),

    aiStatus: () => ai.status({}),

    getAiSettings: async () => (await prefs.get("ai:settings")) ?? null,

    embed: () => ai.embedBacklog({}),

    exportDb: () => db.export({}),

    clearItems: async () => {
      const result = await db.clearItems({});
      await Promise.all(Object.keys(providers).map((id) => prefs.remove(metaKey(id as ProviderId))));
      return result;
    },

    rawIngest: async () => {
      const result = await db.rawIngest({});
      embedSoon(); // freshly upserted rows need embeddings
      return result;
    },

    rawClear: () => db.rawClear({}),

    rawStats: async () => ({ stats: await db.rawStats({}), captureRaw: await getCaptureRaw() }),
  };
}
