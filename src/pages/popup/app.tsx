// The shared saved-items UI — one Preact tree mounted by the popup, the
// full-page view and the dev harness (see runtime.ts). Everything the old
// imperative popup.js did lives here: provider tabs, infinite scroll, search
// with mode fallbacks explained, "more like this", sync with live progress,
// export, and the capture-mode dev row.
import { h, Fragment } from "../../vendor/preact/preact.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "../../vendor/preact/hooks.js";
import { formatPoster, formatSynced, hackerNewsCounts, metaParts } from "../../core/format.ts";
import { FTS_OPERATORS } from "../../core/fts.ts";
import type { ProviderId, ProviderMeta, SavedItem, SearchMode, SyncReport } from "../../core/types.ts";
import type { Runtime } from "./runtime.ts";

const ALL = "all"; // pseudo provider id: search/list across every service
const PAGE_SIZE = 200; // items fetched per list request (infinite scroll)

type ProviderChoice = ProviderId | typeof ALL;

interface Status {
  text: string;
  error?: boolean;
  /** Shows the ✕ back-to-list control after "more like this". */
  similar?: boolean;
  /** Shows an Undo control after a delete — the id to restore. Transient:
   *  replaced by the next status write; the Deleted view is the durable path. */
  undo?: number;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Thumbnail({ item }: { item: SavedItem }) {
  const [failed, setFailed] = useState(false);

  // Item rows can be reused as list/search results change. Give a new image
  // URL its own load attempt instead of retaining the previous URL's failure.
  useEffect(() => setFailed(false), [item.image]);

  if (!item.image || failed) {
    return (
      <div class="thumb placeholder">
        {(item.title || item.posterName || "?").slice(0, 1).toUpperCase()}
      </div>
    );
  }

  return <img class="thumb" src={item.image} alt="" onError={() => setFailed(true)} />;
}

function ItemRow({
  item,
  providerLabel,
  onSimilar,
  onDelete,
  onRestore,
}: {
  item: SavedItem;
  providerLabel: string;
  /** Absent in the Deleted view — "more like this" on a hidden item is confusing. */
  onSimilar?: ((item: SavedItem) => void) | undefined;
  onDelete?: ((item: SavedItem) => void) | undefined;
  onRestore?: ((item: SavedItem) => void) | undefined;
}) {
  const poster = formatPoster(item);
  const summary = hackerNewsCounts(item) ? "" : item.summary;
  const publication = item.publication || "";
  const posterTitle = Boolean(poster && item.title);
  // Title-less rows are posts: their author bio/headline or secondary
  // context is noise in the list, so it moves to a tooltip on the poster
  // line. Rows with a real title (stories, videos, newsletters) keep the
  // publication visible.
  const postLike = Boolean(poster && !item.title);
  const posterTooltip = item.posterBio || publication;
  const fields: [cls: string, value: string | null | false, tooltip?: string | undefined][] = posterTitle
    ? [
        ["poster", poster],
        ["title", item.title],
        ["publication", publication],
        ["summary", summary],
      ]
    : [
        ["title", item.title],
        ["poster", poster, postLike && posterTooltip ? posterTooltip : undefined],
        ["publication", !postLike && publication],
        ["summary", summary],
      ];
  const meta = metaParts(item, { providerLabel }).join(" · ");

  return (
    <li class={`item${posterTitle ? " poster-title-item" : ""}`}>
      <a href={item.url || "#"} target="_blank" rel="noreferrer">
        <Thumbnail item={item} />
        <div class="text">
          {fields.map(
            ([cls, value, tooltip]) =>
              value && (
                <div class={cls} title={tooltip}>
                  {value}
                </div>
              )
          )}
          {meta && <div class="meta">{meta}</div>}
        </div>
      </a>
      {/* Siblings of the <a>, not children, so clicking them doesn't navigate. */}
      {onSimilar && (
        <button class="similar" title="More like this" onClick={() => onSimilar(item)}>
          ≈
        </button>
      )}
      {onDelete && (
        <button class="delete" title="Delete" onClick={() => onDelete(item)}>
          ✕
        </button>
      )}
      {onRestore && (
        <button class="restore" title="Restore" onClick={() => onRestore(item)}>
          ↩
        </button>
      )}
    </li>
  );
}

export function App({ runtime }: { runtime: Runtime }) {
  const { api, prefs } = runtime;

  const [providers, setProviders] = useState<{ id: ProviderId; label: string }[]>([]);
  const [provider, setProvider] = useState<ProviderChoice>(ALL);
  const [items, setItems] = useState<SavedItem[]>([]);
  const [meta, setMeta] = useState<ProviderMeta | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>({ text: "" });
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("fts");
  const [syncing, setSyncing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showSearchRow, setShowSearchRow] = useState(false);
  const [trash, setTrash] = useState(false);

  const providerLabels = useMemo(() => new Map(providers.map((p) => [p.id, p.label])), [providers]);

  // Pagination state lives in refs: loadNextPage runs from an observer
  // callback and must always see current values. `generation` is bumped
  // whenever the view resets (provider change, search, similar) so in-flight
  // responses from the previous view are discarded.
  const offsetRef = useRef(0);
  const totalRef = useRef(0);
  const loadingPageRef = useRef(false);
  const generationRef = useRef(0);
  const providerRef = useRef<ProviderChoice>(ALL);
  providerRef.current = provider;
  // Which feature owns the item list right now. Background view-writers (the
  // sync progress poll, the post-sync refresh) may only touch a "list" view —
  // a search or "more like this" started mid-sync must not be clobbered.
  const viewRef = useRef<"list" | "search" | "similar" | "deleted">("list");
  // Mirrors the `trash` state for callbacks with stale closures (loadItems is
  // captured by init/refresh paths created before the toggle flipped).
  const trashRef = useRef(false);
  trashRef.current = trash;
  // Current query/mode for callbacks created before the latest keystroke
  // (the post-sync search restore).
  const queryRef = useRef("");
  queryRef.current = query;
  const searchModeRef = useRef<SearchMode>("fts");
  searchModeRef.current = searchMode;
  const stoppingRef = useRef(false);
  stoppingRef.current = stopping;
  // refreshView is defined below in the sync section; the delete callbacks
  // above it reach the latest version through this ref.
  const refreshViewRef = useRef<() => Promise<void>>(async () => {});

  const listStatus = useCallback((total: number, lastMeta: ProviderMeta | null, deleted: boolean) => {
    // meta is null in the All view (each provider has its own sync time).
    setStatus({
      text: deleted
        ? total
          ? `${total} deleted items`
          : "No deleted items."
        : total
          ? `${total} saved items${lastMeta ? ` · ${formatSynced(lastMeta.syncedAt)}` : ""}`
          : "No items yet — press Sync to fetch your saved items.",
    });
  }, []);

  const loadItems = useCallback(
    async (providerChoice: ProviderChoice = providerRef.current) => {
      const deleted = trashRef.current;
      viewRef.current = deleted ? "deleted" : "list";
      const gen = ++generationRef.current;
      try {
        const res = await api.listItems({
          provider: providerChoice === ALL ? null : providerChoice,
          deleted,
          limit: PAGE_SIZE,
          offset: 0,
        });
        if (gen !== generationRef.current) return; // view changed while we were waiting
        offsetRef.current = res.items.length;
        totalRef.current = res.total;
        setItems(res.items);
        setMeta(res.meta);
        setHasMore(res.items.length < res.total);
        // Search covers live items only — the Deleted view hides the bar.
        setShowSearchRow(!deleted && res.total > 0);
        listStatus(res.total, res.meta, deleted);
      } catch (e) {
        if (gen !== generationRef.current) return;
        setStatus({ text: errorText(e), error: true });
      }
    },
    [api, listStatus]
  );

  const loadNextPage = useCallback(async () => {
    if (loadingPageRef.current || offsetRef.current >= totalRef.current) return;
    loadingPageRef.current = true;
    const gen = generationRef.current;
    try {
      const res = await api.listItems({
        provider: providerRef.current === ALL ? null : providerRef.current,
        deleted: viewRef.current === "deleted",
        limit: PAGE_SIZE,
        offset: offsetRef.current,
      });
      if (gen !== generationRef.current) return; // view changed while we were waiting
      offsetRef.current += res.items.length;
      totalRef.current = res.total;
      setItems((prev) => [...prev, ...res.items]);
      setHasMore(res.items.length > 0 && offsetRef.current < res.total);
    } catch (e) {
      if (gen === generationRef.current) setStatus({ text: errorText(e), error: true });
    } finally {
      loadingPageRef.current = false;
    }
  }, [api]);

  // ---------- init ----------

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.listProviders({});
        setProviders(list);
        const [lastProvider, storedMode] = await Promise.all([
          prefs.get("lastProvider"),
          prefs.get("searchMode"),
        ]);
        let choice: ProviderChoice = ALL;
        if (lastProvider && (lastProvider === ALL || list.some((p) => p.id === lastProvider))) {
          choice = lastProvider;
        }
        setProvider(choice);
        providerRef.current = choice;
        if (storedMode && ["hybrid", "fts", "semantic"].includes(storedMode)) {
          setSearchMode(storedMode);
        }
        await loadItems(choice);
        // A sync may already be running (started by another surface, or by a
        // popup instance that has since closed) — reattach instead of showing
        // an idle Sync button over a live sync.
        const st = await api.syncStatus({}).catch(() => null);
        if (st?.running) void watchSync();
      } catch (e) {
        setStatus({ text: errorText(e), error: true });
      }
    })();
    // eslint-style note: intentionally run once — deps are stable clients.
  }, []);

  // ---------- infinite scroll ----------

  const listRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  const loadNextPageRef = useRef(loadNextPage);
  loadNextPageRef.current = loadNextPage;

  useEffect(() => {
    const list = listRef.current;
    const sentinel = sentinelRef.current;
    if (!list || !sentinel || !hasMore) return;
    // The scroll container differs per context — the <ul> itself in the popup
    // (overflow-y: auto), the document on page.html (page.css sets overflow-y:
    // visible) — so pick the observer root accordingly, else rootMargin
    // prefetching wouldn't work in the popup (a clipped sentinel never
    // intersects a viewport root until it's actually visible).
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && void loadNextPageRef.current(),
      { root: getComputedStyle(list).overflowY === "auto" ? list : null, rootMargin: "600px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, items]);

  // ---------- search ----------

  const runSearch = useCallback(
    async (text: string, mode: SearchMode) => {
      const trimmed = text.trim();
      if (!trimmed) return loadItems();
      viewRef.current = "search";
      const gen = ++generationRef.current; // stop in-flight list pages from appending
      const usesVectorIntent = mode !== "fts" && !FTS_OPERATORS.test(trimmed);
      setStatus({
        text: usesVectorIntent ? "Searching… checking semantic-search availability" : "Searching…",
      });
      try {
        const res = await api.search({
          provider: providerRef.current === ALL ? null : providerRef.current,
          query: trimmed,
          mode,
        });
        if (gen !== generationRef.current) return;
        setItems(res.items);
        setHasMore(false); // search stays single-shot
        // Explain when what ran differs from what the selector asked for, so
        // the user is never confused about which engine ranked the results.
        let note = "";
        if (res.requested !== "fts" && res.mode === "fts") {
          note = FTS_OPERATORS.test(trimmed)
            ? " · text search (query uses operators)"
            : " · text-only (model warming up)";
        }
        setStatus({ text: `${res.items.length} matches${note}` });

        // Results are already visible. Enrich their status asynchronously so
        // a slow/busy AI-status RPC can never hold the search UX hostage.
        if (usesVectorIntent) {
          void api
            .aiStatus({})
            .then((embeddingStatus) => {
              if (gen !== generationRef.current || !embeddingStatus.backlog) return;
              const backlogNote = embeddingStatus.embedding.running
                ? `embedding in progress (${embeddingStatus.backlog} remaining)`
                : `${embeddingStatus.backlog} items not embedded yet`;
              const embeddingNote =
                res.mode === "fts"
                  ? ` · text-only · ${backlogNote}`
                  : ` · results may be incomplete — ${backlogNote}`;
              setStatus({ text: `${res.items.length} matches${embeddingNote}` });
            })
            .catch(() => {});
        }
      } catch (e) {
        if (gen === generationRef.current) setStatus({ text: errorText(e), error: true });
      }
    },
    [api, loadItems]
  );

  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const onSearchInput = useCallback(
    (text: string, mode: SearchMode) => {
      clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => void runSearch(text, mode), 150);
    },
    [runSearch]
  );

  // ---------- more like this ----------

  const showSimilar = useCallback(
    async (item: SavedItem) => {
      viewRef.current = "similar";
      const gen = ++generationRef.current; // stop in-flight list pages from appending
      try {
        const similar = await api.similar({
          id: item.id,
          provider: providerRef.current === ALL ? null : providerRef.current,
        });
        if (gen !== generationRef.current) return;
        setQuery("");
        setItems(similar);
        setHasMore(false); // similar results are a single shot
        setStatus({
          text: `${similar.length} similar to “${(item.title || item.url || "").slice(0, 60)}” `,
          similar: true,
        });
      } catch (e) {
        if (gen !== generationRef.current) return;
        // "Item not embedded yet": tell the user where the embedding backlog is.
        let detail = "";
        if (/not embedded/i.test(errorText(e))) {
          const st = await api.aiStatus({}).catch(() => null);
          if (st?.backlog) detail = ` — ${st.backlog} items still embedding`;
        }
        setStatus({ text: `${errorText(e)}${detail}`, error: true });
      }
    },
    [api]
  );

  // ---------- delete / restore ----------

  // Optimistic removal from whatever view is showing. In paged views the
  // offset/total refs shift down with the row so infinite scroll stays
  // aligned; the generation is NOT bumped — this is a mutation, not a view
  // change, and an in-flight page appending afterwards is harmless.
  const dropRow = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (viewRef.current === "list" || viewRef.current === "deleted") {
      offsetRef.current = Math.max(0, offsetRef.current - 1);
      totalRef.current = Math.max(0, totalRef.current - 1);
    }
  }, []);

  const deleteItem = useCallback(
    async (item: SavedItem) => {
      try {
        await api.setItemDeleted({ id: item.id, deleted: true });
      } catch (e) {
        setStatus({ text: errorText(e), error: true });
        return;
      }
      dropRow(item.id);
      setStatus({
        text: `Deleted “${(item.title || formatPoster(item) || item.url || "").slice(0, 60)}”`,
        undo: item.id,
        similar: viewRef.current === "similar",
      });
    },
    [api, dropRow]
  );

  const undoDelete = useCallback(
    async (id: number) => {
      try {
        await api.setItemDeleted({ id, deleted: false });
      } catch (e) {
        setStatus({ text: errorText(e), error: true });
        return;
      }
      // list/search views refresh (the row reappears in place); a similar
      // view keeps its results — the restored item just stays hidden there.
      if (viewRef.current === "similar") setStatus({ text: "Item restored", similar: true });
      else await refreshViewRef.current();
    },
    [api]
  );

  const restoreItem = useCallback(
    async (item: SavedItem) => {
      try {
        await api.setItemDeleted({ id: item.id, deleted: false });
      } catch (e) {
        setStatus({ text: errorText(e), error: true });
        return;
      }
      dropRow(item.id);
      listStatus(totalRef.current, null, true);
    },
    [api, dropRow, listStatus]
  );

  const toggleTrash = useCallback(() => {
    const next = !trashRef.current;
    trashRef.current = next;
    setTrash(next);
    setQuery(""); // search is live-only; entering/leaving the trash resets it
    void loadItems();
  }, [loadItems]);

  // ---------- sync ----------

  // Pages are saved to the DB as a sync fetches them, so re-render the list
  // periodically to show progress while the sync runs. Only a "list" view in
  // the current generation is updated — a search or "more like this" started
  // mid-sync must not be clobbered every 800 ms.
  const startSyncPoll = useCallback(() => {
    const poll = setInterval(() => {
      void (async () => {
        if (viewRef.current !== "list") return;
        const gen = generationRef.current;
        const res = await api
          .listItems({
            provider: providerRef.current === ALL ? null : providerRef.current,
            limit: Math.max(PAGE_SIZE, offsetRef.current),
            offset: 0,
          })
          .catch(() => null);
        if (!res || gen !== generationRef.current || viewRef.current !== "list") return;
        offsetRef.current = res.items.length;
        totalRef.current = res.total;
        setItems(res.items);
        setHasMore(res.items.length < res.total);
        setStatus({
          text: stoppingRef.current ? "Stopping…" : `Syncing… ${res.total} items in database so far`,
        });
      })();
    }, 800);
    return () => clearInterval(poll);
  }, [api]);

  // Post-sync: refresh whatever the user is looking at instead of
  // unconditionally replacing it with the list (a query typed mid-sync used
  // to keep its text but lose its results). "similar" is left untouched —
  // its results don't change with new items and the user navigated there
  // deliberately.
  const refreshView = useCallback(async () => {
    if (viewRef.current === "search" && queryRef.current.trim()) {
      await runSearch(queryRef.current, searchModeRef.current);
    } else if (viewRef.current === "list" || viewRef.current === "deleted") {
      await loadItems();
    }
  }, [loadItems, runSearch]);
  refreshViewRef.current = refreshView;

  const doSync = useCallback(
    async () => {
      setSyncing(true);
      setStatus({ text: "Checking for new saved items…" });
      const stopPoll = startSyncPoll();

      try {
        // Scope is pinned here, at click time — a dropdown change mid-sync
        // affects neither the running sync nor the completion message.
        const choice = providerRef.current;
        const scopeLabel = choice === ALL ? "All services" : providerLabels.get(choice) || choice;
        const report =
          choice === ALL
            ? await api.syncAll({ full: false })
            : await api.sync({ provider: choice, full: false });
        stopPoll();
        await refreshView();

        const reports = "reports" in report ? report.reports : [report];
        // A user-requested stop is a neutral outcome, not an error — keep it
        // out of the failure join and out of the error styling.
        const wasStopped = reports.some((r) => r.status !== "ok" && r.stopped);
        const error = reports
          .filter((r): r is SyncReport & { status: "partial" | "failed" } => r.status !== "ok" && !r.stopped)
          .map((r) => `${providerLabels.get(r.providerId) || r.providerId}: ${r.error}`)
          .join(" · ");
        const captured = report.captured > 0 ? report.captured : undefined;
        // In capture mode nothing lands in the list — the raw archive grew instead.
        const outcome =
          captured !== undefined
            ? `Captured ${captured} raw pages (items unchanged — use “Ingest raw” to apply)`
            : `${scopeLabel}: ${report.inserted} new · ${report.total} total · ${
                wasStopped ? "stopped" : "synced just now"
              }`;
        setStatus(
          error
            ? { text: `${outcome}, then stopped: ${error}`, error: true }
            : { text: outcome, similar: viewRef.current === "similar" }
        );
      } catch (e) {
        // Includes the single-flight rejection when another surface (page.html,
        // an earlier popup instance) already has a sync running.
        setStatus({ text: errorText(e), error: true });
      } finally {
        stopPoll();
        setSyncing(false);
        setStopping(false);
      }
    },
    [api, refreshView, startSyncPoll, providerLabels]
  );

  // Cooperative stop: the running walk finishes its current page, keeps
  // everything landed, and skips the watermark so the next sync re-covers the
  // gap. The pending sync/syncAll call resolves with the stopped report.
  const doStop = useCallback(async () => {
    setStopping(true);
    try {
      await api.syncStop({});
    } catch (e) {
      setStopping(false);
      setStatus({ text: errorText(e), error: true });
    }
  }, [api]);

  // Reattach to a sync this surface didn't start (popup reopened mid-sync, or
  // page.html open next to the popup): reflect the running state, show
  // progress, and refresh when the background reports it finished.
  const watchSync = useCallback(async () => {
    setSyncing(true);
    setStatus({ text: "Syncing…" });
    const stopPoll = startSyncPoll();
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const st = await api.syncStatus({}).catch(() => null);
        if (!st?.running) break;
        if (st.stopping) setStopping(true);
      }
    } finally {
      stopPoll();
      setSyncing(false);
      setStopping(false);
    }
    await refreshView();
  }, [api, refreshView, startSyncPoll]);

  // ---------- render ----------

  return (
    <>
      <header>
        <h1>Linkosh</h1>
        <div class="controls">
          <select
            id="provider"
            value={provider}
            onChange={(e) => {
              const value = (e.currentTarget as HTMLSelectElement).value as ProviderChoice;
              setProvider(value);
              providerRef.current = value;
              void prefs.set("lastProvider", value);
              void loadItems(value);
            }}
          >
            <option value={ALL}>All services</option>
            {providers.map((p) => (
              <option value={p.id}>{p.label}</option>
            ))}
          </select>
          <button
            id="refresh"
            title={
              syncing
                ? "Stop the sync — items already fetched are kept"
                : "Fetch items saved since the last sync"
            }
            disabled={stopping}
            onClick={() => void (syncing ? doStop() : doSync())}
          >
            {stopping ? "Stopping…" : syncing ? "Stop" : "Sync"}
          </button>
          <button
            id="trash"
            class="icon-button"
            title={trash ? "Back to saved items" : "Deleted items"}
            aria-pressed={trash}
            onClick={toggleTrash}
          >
            🗑
          </button>
          {runtime.openPage && (
            <button id="expand" title="Open as a full page" onClick={runtime.openPage}>
              ⛶
            </button>
          )}
          {runtime.openOptions && (
            <button
              id="settings"
              class="icon-button"
              title="Settings"
              aria-label="Open settings"
              onClick={runtime.openOptions}
            >
              ⚙
            </button>
          )}
        </div>
      </header>

      {/* Persistent while the trash is open — the header toggle alone is too
          subtle a cue for which view is showing (and how to leave it). */}
      {trash && (
        <div id="trash-banner">
          <span>Viewing deleted items</span>
          <button onClick={toggleTrash}>✕ Back to saved items</button>
        </div>
      )}

      <div id="search-row" hidden={!showSearchRow}>
        <input
          id="search"
          type="search"
          placeholder="Filter saved items…"
          title='Full-text search. Supports FTS5 filters, e.g. kind:short, collection:"watch later", poster_name:"jane doe", poster_handle:jane, cats AND dogs, NOT reel'
          value={query}
          onInput={(e) => {
            const text = (e.currentTarget as HTMLInputElement).value;
            setQuery(text);
            onSearchInput(text, searchMode);
          }}
        />
        <select
          id="search-mode"
          title="Search mode: Hybrid mixes text and semantic ranking, Text is exact FTS5 matching, Semantic ranks purely by meaning"
          value={searchMode}
          onChange={(e) => {
            const mode = (e.currentTarget as HTMLSelectElement).value as SearchMode;
            setSearchMode(mode);
            void prefs.set("searchMode", mode);
            if (query.trim()) onSearchInput(query, mode);
          }}
        >
          <option value="fts">Text</option>
          <option value="hybrid">Hybrid</option>
          <option value="semantic">Semantic</option>
        </select>
      </div>

      <div id="status" class={status.error ? "error" : ""}>
        {status.text}
        {status.undo !== undefined && (
          <button class="undo" title="Restore the deleted item" onClick={() => void undoDelete(status.undo!)}>
            Undo
          </button>
        )}
        {status.similar && (
          <button class="reset-similar" title="Back to the list" onClick={() => void loadItems()}>
            ✕
          </button>
        )}
      </div>

      <ul id="list" ref={listRef}>
        {items.map((item) => (
          <ItemRow
            key={`${item.provider}:${item.id}`}
            item={item}
            providerLabel={provider === ALL ? providerLabels.get(item.provider) || item.provider : ""}
            onSimilar={trash ? undefined : (it) => void showSimilar(it)}
            onDelete={trash ? undefined : (it) => void deleteItem(it)}
            onRestore={trash ? (it) => void restoreItem(it) : undefined}
          />
        ))}
        {hasMore && <li class="sentinel" ref={sentinelRef} />}
      </ul>
    </>
  );
}
