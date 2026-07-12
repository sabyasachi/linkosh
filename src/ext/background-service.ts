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

/** What syncStatus reports — enough for any UI surface (popup, page.html,
 *  dev harness) to reattach to a sync it didn't start. */
export type SyncRunStatus =
  | { running: false }
  | { running: true; scope: ProviderId | "all"; startedAt: number; stopping: boolean };

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
  /** Sync-run visibility for surfaces that didn't start the sync. */
  syncStatus(args: Record<string, never>): SyncRunStatus;
  /** Request a cooperative stop of the running sync (page-boundary latency).
   *  stopping: false means nothing was running. */
  syncStop(args: Record<string, never>): { stopping: boolean };
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
  /** Replay every archived page, including rows already marked ingested. */
  rawReingest(args: Record<string, never>): IngestReport;
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

  // Single-flight sync lock, global (not per-provider) — it matches the one
  // Sync button and covers syncAll-vs-provider overlap. Overlapping syncs are
  // DB-safe but service-hostile: doubled walks defeat request pacing and
  // double injected-tab traffic. The button's disabled state is per-popup
  // only; this is the hard guarantee across popup + page.html + reopened
  // popups.
  let running: { controller: AbortController; scope: ProviderId | "all"; startedAt: number } | null = null;

  const beginSync = (scope: ProviderId | "all") => {
    if (running) throw new Error("A sync is already running");
    const run = { controller: new AbortController(), scope, startedAt: Date.now() };
    running = run; // set synchronously — no await between the guard and here
    return run;
  };

  const runSync = async <T>(scope: ProviderId | "all", go: (stop: AbortSignal) => Promise<T>): Promise<T> => {
    const run = beginSync(scope);
    try {
      return await go(run.controller.signal);
    } finally {
      // syncStop may have freed the lock (and a new sync claimed it) while
      // this walk was still unwinding — only clear our own registration.
      if (running === run) running = null;
    }
  };

  /** Maintenance ops racing a sync corrupt sync state (e.g. a clear mid-sync
   *  leaves a fresh watermark over a gutted table, hiding the cleared items
   *  from incremental sync). Reject instead. */
  const rejectDuringSync = () => {
    if (running) throw new Error("A sync is running — stop it first");
  };

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

    sync: ({ provider, full }) =>
      runSync(provider, async (stop) => sync.syncProvider(provider, { ...(await syncOptions(full)), stop })),

    syncAll: ({ full }) =>
      runSync("all", async (stop) => sync.syncAllProviders({ ...(await syncOptions(full)), stop })),

    syncStatus: () =>
      running
        ? {
            running: true,
            scope: running.scope,
            startedAt: running.startedAt,
            stopping: running.controller.signal.aborted,
          }
        : { running: false },

    syncStop: () => {
      if (!running) return { stopping: false };
      running.controller.abort();
      // Free the lock immediately rather than in the run's finally: a walk
      // wedged in a hung fetch would otherwise hold it forever. The aborted
      // token plus the skipped watermark keep the zombie inert, and its
      // upserts are idempotent, so a brief overlap with a new sync is
      // harmless.
      running = null;
      return { stopping: true };
    },

    aiStatus: () => ai.status({}),

    getAiSettings: async () => (await prefs.get("ai:settings")) ?? null,

    embed: () => ai.embedBacklog({}),

    exportDb: () => db.export({}),

    clearItems: async () => {
      rejectDuringSync();
      const result = await db.clearItems({});
      await Promise.all(Object.keys(providers).map((id) => prefs.remove(metaKey(id as ProviderId))));
      return result;
    },

    rawIngest: async () => {
      rejectDuringSync();
      const result = await db.rawIngest({});
      embedSoon(); // freshly upserted rows need embeddings
      return result;
    },

    rawReingest: async () => {
      rejectDuringSync();
      const result = await db.rawReingest({});
      embedSoon(); // restored/changed rows need embeddings
      return result;
    },

    rawClear: () => {
      rejectDuringSync();
      return db.rawClear({});
    },

    rawStats: async () => ({ stats: await db.rawStats({}), captureRaw: await getCaptureRaw() }),
  };
}
