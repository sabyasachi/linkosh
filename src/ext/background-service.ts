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

/** One provider's row on the status page: user enablement, a cookie-based
 *  login probe, and store/sync stats. */
export interface ProviderStatusRow {
  id: ProviderId;
  label: string;
  enabled: boolean;
  /** null = the provider has no login probe or it failed (unknown). */
  loggedIn: boolean | null;
  /** Rows stored for this provider. */
  items: number;
  /** Newest stored item's save date (epoch ms), null when unknown. */
  lastItemAt: number | null;
  /** Last successful sync (the incremental watermark), null = never. */
  syncedAt: number | null;
}

export interface BackgroundApi {
  /** Enabled providers only — this feeds the popup's service dropdown. */
  listProviders(args: Record<string, never>): { id: ProviderId; label: string }[];
  /** Every registered provider (disabled included) — the status page and the
   *  options page's enablement toggles. */
  providerStatus(args: Record<string, never>): ProviderStatusRow[];
  /** provider: null means "across all providers" (the UI's "all" tab);
   *  deleted: true lists the trash (soft-deleted items) instead;
   *  starred: true restricts to starred items. */
  listItems(args: {
    provider: ProviderId | null;
    deleted?: boolean;
    starred?: boolean;
    limit?: number;
    offset?: number;
  }): {
    items: SavedItem[];
    total: number;
    meta: ProviderMeta | null;
  };
  search(args: { provider: ProviderId | null; query: string; mode?: SearchMode }): SearchResult;
  similar(args: { id: number; provider: ProviderId | null }): SavedItem[];
  /** Soft-delete (deleted: true) or restore (false) one item. */
  setItemDeleted(args: { id: number; deleted: boolean }): { changed: number };
  /** Star (starred: true) or unstar (false) one item. */
  setItemStarred(args: { id: number; starred: boolean }): { changed: number };
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

  // User enablement (options page). Stored as the disabled set so providers
  // added in a future version default to enabled.
  const getDisabled = async () => new Set<ProviderId>((await prefs.get("disabledProviders")) ?? []);
  const allProviders = () => Object.values(providers).filter((p): p is Provider => Boolean(p));
  const enabledProviders = async () => {
    const disabled = await getDisabled();
    return allProviders().filter((p) => !disabled.has(p.id));
  };

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
    listProviders: async () => (await enabledProviders()).map((p) => ({ id: p.id, label: p.label })),

    providerStatus: async () => {
      const disabled = await getDisabled();
      const stats = new Map((await db.providerStats({})).map((row) => [row.provider, row]));
      return Promise.all(
        allProviders().map(async (p) => ({
          id: p.id,
          label: p.label,
          enabled: !disabled.has(p.id),
          // A probe failure (e.g. missing cookie permission) reads as unknown,
          // not logged-out — the status page renders it as "—".
          loggedIn: p.checkLogin ? await p.checkLogin().catch(() => null) : null,
          items: stats.get(p.id)?.items ?? 0,
          lastItemAt: stats.get(p.id)?.lastItemAt ?? null,
          syncedAt: (await getMeta(p.id))?.syncedAt ?? null,
        }))
      );
    },

    listItems: async ({ provider, deleted, starred, limit, offset }) => ({
      items: await db.list({
        provider,
        ...(deleted !== undefined ? { deleted } : {}),
        ...(starred !== undefined ? { starred } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      }),
      total: await db.count({
        provider,
        ...(deleted !== undefined ? { deleted } : {}),
        ...(starred !== undefined ? { starred } : {}),
      }),
      meta: provider ? await getMeta(provider) : null,
    }),

    // mode is the user's selector choice; the result reports what actually
    // ran (may differ when the model isn't ready or the query uses FTS
    // operators). Depth matches hybridSearch's fusion pool (CANDIDATES = 500)
    // so a row that entered the fusion is never silently cut by this limit;
    // search results render single-shot in the UI, which handles 500 rows.
    search: ({ provider, query, mode }) =>
      ai.search({ provider, query, limit: 500, ...(mode !== undefined ? { mode } : {}) }),

    similar: ({ id, provider }) => db.similar({ id, provider }),

    setItemDeleted: ({ id, deleted }) => {
      // Consistency with the other maintenance ops; a soft delete is actually
      // race-free against a sync's upserts (deleted_at isn't in its SET list),
      // but "mutations wait for the sync" is one rule instead of two.
      rejectDuringSync();
      return db.setDeleted({ id, deleted });
    },

    setItemStarred: ({ id, starred }) => {
      rejectDuringSync(); // same one-rule consistency as setItemDeleted
      return db.setStarred({ id, starred });
    },

    sync: ({ provider, full }) =>
      runSync(provider, async (stop) => sync.syncProvider(provider, { ...(await syncOptions(full)), stop })),

    syncAll: ({ full }) =>
      runSync("all", async (stop) =>
        sync.syncAllProviders({
          ...(await syncOptions(full)),
          include: (await enabledProviders()).map((p) => p.id),
          stop,
        })
      ),

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
