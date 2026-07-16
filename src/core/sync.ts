// Sync orchestration — pure, runs under Node with fakes (scripted providers,
// an in-memory DB). Everything environment-specific is injected.
//
// Two modes per sync:
//   normal (default)     — each page is parsed (core/parse) and upserted into
//                          saved_items as it arrives; raw bodies dropped.
//   capture (captureRaw) — each page is archived verbatim into raw_data and
//                          saved_items is left untouched; raw:ingest
//                          (core/ingest.ts) replays the archive through the
//                          exact same parse + upsert later.
import type {
  AllSyncReport,
  PageOutcome,
  ParsedItem,
  Provider,
  ProviderId,
  ProviderMeta,
  RawPage,
  SyncOptions,
  SyncReport,
} from "./types.ts";
import { ProviderError } from "./errors.ts";
import { parsePage } from "./parse/index.ts";

/** The slice of the DB surface syncing needs, promise-shaped so both a direct
 *  service wrapper and an RPC client satisfy it. */
export interface SyncDb {
  knownIds(args: { provider: ProviderId; createdBefore?: number }): Promise<string[]>;
  rawKnownIds(args: { provider: ProviderId; fetchedBefore?: number }): Promise<string[]>;
  upsert(args: { provider: ProviderId; account: string; items: ParsedItem[] }): Promise<{
    inserted: number;
    updated: number;
  }>;
  rawStore(args: {
    provider: ProviderId;
    account: string;
    page: RawPage;
    externalIds: string[];
    fetchedAt: number;
  }): Promise<{ stored: number }>;
  count(args: { provider?: ProviderId | null }): Promise<number>;
}

export interface CreateSyncOptions {
  providers: Partial<Record<ProviderId, Provider>>;
  db: SyncDb;
  getMeta(providerId: ProviderId): Promise<ProviderMeta | null>;
  setMeta(providerId: ProviderId, meta: ProviderMeta): Promise<void>;
  /** Fired after each provider finishes with anything landed (ok or partial) —
   *  the background uses it to kick embedding. */
  onSynced?(providerId: ProviderId): void;
}

export interface Sync {
  syncProvider(providerId: ProviderId, opts?: SyncOptions): Promise<SyncReport>;
  syncAllProviders(opts?: SyncOptions): Promise<AllSyncReport>;
}

function collectionKey(collection: string[] | undefined): string {
  return (collection ?? []).map(String).sort().join("\u0000");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Thrown out of onPage when the stop token aborts — unwinds the provider's
 *  walk at its next page boundary with zero provider changes (providers just
 *  propagate it like any fetch failure). */
class SyncStopped extends Error {
  constructor() {
    super("Sync stopped");
  }
}

export function createSync({ providers, db, getMeta, setMeta, onSynced }: CreateSyncOptions): Sync {
  // maxItems (0 = unlimited): "test mode" — stop a run once it has collected
  // roughly this many items, so a provider can be smoke-tested without a full
  // fetch from the service. It's a soft cap: the current page finishes and,
  // for providers that walk several lists (HN stories+comments, YT playlists),
  // each remaining list still fetches one page before stopping — so expect a
  // little more than maxItems across those.
  async function syncProvider(
    providerId: ProviderId,
    { full = false, captureRaw = false, maxItems = 0, stop }: SyncOptions = {}
  ): Promise<SyncReport> {
    const provider = providers[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`); // programmer error, not a sync outcome

    // Incremental sync: tell the provider which items we already have so it
    // can stop paging as soon as it reaches known territory. A full sync
    // re-walks everything (useful to refresh stale metadata; unsaved items
    // still remain in the DB — the DB is an archive, not a mirror). Only
    // items from the last *successful* sync count as known: a failed sync
    // leaves the newest pages saved, and trusting those would make the next
    // incremental run stop at the first page and skip the gap underneath.
    // In capture mode the archive is a second source of "known": raw pages
    // already fetched must not be fetched again even though their items may
    // not have been ingested into saved_items yet.
    const lastGoodSync = (await getMeta(providerId))?.syncedAt;
    let knownIds = new Set<string>();
    if (!full && lastGoodSync) {
      knownIds = new Set([
        ...(await db.knownIds({ provider: providerId, createdBefore: lastGoodSync })),
        ...(captureRaw ? await db.rawKnownIds({ provider: providerId, fetchedBefore: lastGoodSync }) : []),
      ]);
    }

    let inserted = 0;
    let updated = 0;
    let captured = 0;
    let itemCount = 0; // distinct items collected this run (for the maxItems cap)
    let error: unknown = null;
    const seen = new Set<string>(); // de-dup exact item+collection repeats across overlapping pages

    // The provider fetches raw pages and hands each one here; parsing happens
    // exactly once, through the shared registry, and the parse result goes
    // back to the provider (cursor for its next request, unseen for the stop
    // rule). Each page is persisted before the next request, so the popup can
    // show progress and a mid-sync failure keeps everything fetched so far.
    const onPage = async (account: string, rawPage: RawPage): Promise<PageOutcome> => {
      // Stop token, checked at the same choke point as the maxItems cap: every
      // provider passes each page through here, so all of them stop at their
      // next page boundary. The already-fetched page is dropped un-persisted —
      // the untouched watermark re-covers it next sync.
      if (stop?.aborted) throw new SyncStopped();
      const fetchedAt = Date.now();
      const parsed = parsePage(providerId, {
        kind: rawPage.kind,
        body: rawPage.body,
        ...(rawPage.context !== undefined ? { context: rawPage.context } : {}),
        fetchedAt,
      });
      const kept: ParsedItem[] = [];
      let unseen = 0;
      for (const item of parsed.items) {
        const seenKey = `${item.externalId}\u0001${collectionKey(item.collection)}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        kept.push(item); // known items included too: their fields get refreshed
        if (!knownIds.has(item.externalId)) unseen++;
      }
      if (captureRaw) {
        await db.rawStore({
          provider: providerId,
          account,
          page: rawPage,
          externalIds: kept.map((i) => i.externalId),
          fetchedAt,
        });
        captured++;
      } else if (kept.length) {
        const res = await db.upsert({ provider: providerId, account, items: kept });
        inserted += res.inserted;
        updated += res.updated;
      }
      // Test-mode cap: once enough has landed, report the page as fully known
      // so the provider stops paging (the same signal the incremental stop
      // rule uses), no provider changes needed.
      itemCount += kept.length;
      const unseenOut = maxItems && itemCount >= maxItems ? 0 : unseen;
      return { ...parsed, items: kept, unseen: unseenOut };
    };

    let stopped = false;
    try {
      await provider.fetchItems({ knownIds, onPage });
      // A provider can finish its walk without calling onPage again after the
      // abort flipped — an abort during the run still must not count as a
      // clean sync (no watermark), or the next incremental run would trust it.
      if (stop?.aborted) stopped = true;
    } catch (e) {
      if (e instanceof SyncStopped) stopped = true;
      else error = e; // classified below: partial if anything landed, failed otherwise
    }

    const counts = {
      providerId,
      inserted,
      updated,
      captured,
      total: await db.count({ provider: providerId }),
    };

    // Stopped runs share the failure invariant: setMeta is skipped, so the
    // untouched watermark makes the next incremental sync re-cover the gap.
    if (stopped) {
      if (inserted === 0 && updated === 0 && captured === 0) {
        return { ...counts, status: "failed", error: "Sync stopped", needsLogin: false, stopped: true };
      }
      onSynced?.(providerId); // landed pages still need embeddings
      return { ...counts, status: "partial", error: "Sync stopped", needsLogin: false, stopped: true };
    }

    if (error) {
      const needsLogin = error instanceof ProviderError ? error.needsLogin : false;
      if (inserted === 0 && updated === 0 && captured === 0) {
        return { ...counts, status: "failed", error: errorText(error), needsLogin };
      }
      onSynced?.(providerId); // partial sync: some pages landed
      return { ...counts, status: "partial", error: errorText(error), needsLogin };
    }

    const meta: ProviderMeta = { syncedAt: Date.now() };
    await setMeta(providerId, meta);
    onSynced?.(providerId);
    return { ...counts, status: "ok", syncedAt: meta.syncedAt };
  }

  // Sync every provider in turn. One provider failing (e.g. not logged in)
  // must not abort the rest — reports carry each outcome; consumers derive
  // any joined error display themselves.
  async function syncAllProviders(opts: SyncOptions = {}): Promise<AllSyncReport> {
    const reports: SyncReport[] = [];
    for (const provider of Object.values(providers)) {
      if (!provider) continue;
      if (opts.include && !opts.include.includes(provider.id)) continue; // disabled by the user
      if (opts.stop?.aborted) break; // stop between providers; finished reports stand
      reports.push(await syncProvider(provider.id, opts));
    }
    return {
      inserted: reports.reduce((n, r) => n + r.inserted, 0),
      updated: reports.reduce((n, r) => n + r.updated, 0),
      captured: reports.reduce((n, r) => n + r.captured, 0),
      total: await db.count({}),
      reports,
    };
  }

  return { syncProvider, syncAllProviders };
}
