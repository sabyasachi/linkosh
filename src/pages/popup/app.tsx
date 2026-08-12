// The shared saved-items UI — one Preact tree mounted by the popup, the
// full-page view and the dev harness (see runtime.ts). Everything the old
// imperative popup.js did lives here: provider tabs, infinite scroll, search
// with mode fallbacks explained, "more like this", sync with live progress,
// export, and the capture-mode dev row.
import { h, Fragment } from "../../vendor/preact/preact.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "../../vendor/preact/hooks.js";
import {
  formatPoster,
  formatSynced,
  hackerNewsBadge,
  hackerNewsCounts,
  metaParts,
} from "../../core/format.ts";
import { FTS_OPERATORS } from "../../core/fts.ts";
import type { PageKind, ProviderId, ProviderMeta, SavedItem, SearchMode, SyncReport } from "../../core/types.ts";
import type { SyncRunStatus } from "../../ext/background-service.ts";
import type { Runtime } from "./runtime.ts";

const ALL = "all"; // pseudo provider id: search/list across every service
const PAGE_SIZE = 200; // items fetched per list request (infinite scroll)

type ProviderChoice = ProviderId | typeof ALL;
type RunningSyncStatus = Extract<SyncRunStatus, { running: true }>;

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
  if (e instanceof Error && ["DatabaseVersionError", "DatabaseMigrationError"].includes(e.name)) {
    return `Database initialization failed. Normal operations are unavailable. Export a recovery copy from Options → Developer → Export database. ${e.message}`;
  }
  if (e instanceof Error && e.name === "DatabaseOpenError") {
    return `The database could not be opened. Normal operations and database export are unavailable. ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const PAGE_KIND_LABELS: Record<PageKind, string> = {
  items: "saved items",
  learning: "learning",
  stories: "stories",
  comments: "comments",
  collections: "collections",
  playlists: "playlists",
  connection: "saved items",
};

function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function SyncProgressBanner({
  syncing,
  stopping,
  progress,
  providerLabels,
  now,
}: {
  syncing: boolean;
  stopping: boolean;
  progress: RunningSyncStatus | null;
  providerLabels: ReadonlyMap<ProviderId, string>;
  now: number;
}) {
  if (!syncing) return null;
  const active = progress?.active ?? null;
  const label = active ? providerLabels.get(active.providerId) || active.providerId : "";
  const ageMs = active ? Math.max(0, now - active.lastActivityAt) : 0;
  const waiting = ageMs >= 15_000;
  const longWait = ageMs >= 60_000;
  const heading = stopping
    ? "Stopping after the current page…"
    : !progress
      ? "Starting sync…"
      : !active
        ? "Finishing sync…"
        : `${active.phase === "preparing" ? "Preparing" : active.phase === "connecting" ? "Connecting to" : "Syncing"} ${label}`;
  const ordinal = active && active.count > 1 ? `${active.index} of ${active.count}` : "";
  let detail = "Waiting for the background service";
  let accessibleDetail = detail;
  if (progress && !active) detail = "All scheduled services processed";
  if (progress && !active) accessibleDetail = detail;
  else if (active?.phase === "preparing") {
    detail = `Started ${shortDuration(now - progress!.startedAt)} ago`;
    accessibleDetail = "Provider setup started";
  } else if (active?.phase === "connecting") {
    const activity = waiting
      ? `waiting ${shortDuration(ageMs)}`
      : ageMs < 1_000
        ? "active now"
        : `active ${shortDuration(ageMs)} ago`;
    detail = `Waiting for the first page · ${activity}`;
    accessibleDetail = "Waiting for the first page";
  } else if (active) {
    const latest = active.kind === undefined ? "" : ` · latest: ${PAGE_KIND_LABELS[active.kind]} page ${(active.sourcePage ?? 0) + 1}`;
    const activity = waiting ? `waiting ${shortDuration(ageMs)}` : ageMs < 1_000 ? "active now" : `active ${shortDuration(ageMs)} ago`;
    detail = active.captured > 0
      ? `Captured ${active.captured} ${active.captured === 1 ? "page" : "pages"}${latest} · ${activity}`
      : `Processed ${active.pagesCompleted} ${active.pagesCompleted === 1 ? "page" : "pages"}${latest} · ${active.inserted} new · ${activity}`;
    accessibleDetail = active.captured > 0
      ? `Captured ${active.captured} ${active.captured === 1 ? "page" : "pages"}${latest}`
      : `Processed ${active.pagesCompleted} ${active.pagesCompleted === 1 ? "page" : "pages"}${latest} · ${active.inserted} new`;
  }

  const completed = progress?.completed ?? [];
  const issues = completed
    .filter((item) => item.status !== "ok")
    .map((item) => {
      const name = providerLabels.get(item.providerId) || item.providerId;
      return item.needsLogin ? `${name} needs login` : `${name}: ${item.error || item.status}`;
    });
  const successes = completed
    .filter((item) => item.status === "ok")
    .map((item) => providerLabels.get(item.providerId) || item.providerId);
  const completedLine = issues.length
    ? `${issues.join(" · ")}${active ? " · continuing with remaining services" : ""}`
    : successes.length && active
      ? `${joinNames(successes)} complete`
      : "";
  const count = active?.count ?? (progress ? Math.max(1, completed.length) : 1);
  const finished = completed.length;
  const finishedWidth = progress ? `${Math.min(100, (finished / count) * 100)}%` : "0%";
  const activeLeft = `${Math.min(100, (finished / count) * 100)}%`;
  const activeWidth = progress && active ? `${100 / count}%` : "0%";
  const assistive = [heading, ordinal, accessibleDetail, completedLine, longWait ? "Still waiting — Stop keeps fetched items." : ""]
    .filter(Boolean)
    .join(". ");

  return (
    <div class={`sync-progress${waiting ? " waiting" : ""}${longWait ? " long-wait" : ""}`} role="status">
      <span class="sr-only">{assistive}</span>
      <div aria-hidden="true">
        <div class="sync-progress-heading">
          <span><span class="sync-spinner">◌</span> {heading}</span>
          {ordinal && <span class="sync-ordinal">{ordinal}</span>}
        </div>
        <div class="sync-progress-detail">{detail}</div>
        {completedLine && <div class="sync-progress-completed">{completedLine}</div>}
        {longWait && <div class="sync-progress-warning">Still waiting — Stop keeps fetched items.</div>}
        <div class="sync-track">
          <span class="sync-track-finished" style={{ width: finishedWidth }} />
          <span class="sync-track-active" style={{ left: activeLeft, width: activeWidth }} />
        </div>
      </div>
    </div>
  );
}

function Thumbnail({ item }: { item: SavedItem }) {
  const [failed, setFailed] = useState(false);

  // Item rows can be reused as list/search results change. Give a new image
  // URL its own load attempt instead of retaining the previous URL's failure.
  useEffect(() => setFailed(false), [item.image]);

  if (!item.image || failed) {
    const hnBadge = hackerNewsBadge(item);
    return (
      <div class={`thumb placeholder${hnBadge ? " hackernews-badge" : ""}`} aria-hidden="true">
        {hnBadge ? (
          hnBadge === "HN" ? (
            <span class="hn-badge-only">HN</span>
          ) : hnBadge === "COMMENT" ? (
            <>
              <svg class="hn-comment-icon" viewBox="0 0 20 20">
                <path d="M3 3.5h14v10H9l-4.5 3v-3H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
              </svg>
              <span class="hn-badge-source">HN</span>
            </>
          ) : (
            <>
              <span class={`hn-badge-category${hnBadge.length > 5 ? " long" : ""}`}>{hnBadge}</span>
              <span class="hn-badge-source">HN</span>
            </>
          )
        ) : (
          (item.title || item.posterName || item.posterHandle || "?").slice(0, 1).toUpperCase()
        )}
      </div>
    );
  }

  return <img class="thumb" src={item.image} alt="" onError={() => setFailed(true)} />;
}

function ItemRow({
  item,
  providerLabel,
  onSimilar,
  onToggleStar,
  onDelete,
  onRestore,
}: {
  item: SavedItem;
  providerLabel: string;
  /** Absent in the Deleted view — "more like this" on a hidden item is confusing. */
  onSimilar?: ((item: SavedItem) => void) | undefined;
  /** Absent in the Deleted view — restore first, then star. */
  onToggleStar?: ((item: SavedItem) => void) | undefined;
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
      {onToggleStar && (
        <button
          class={`star${item.starredAt ? " on" : ""}`}
          title={item.starredAt ? "Unstar" : "Star"}
          onClick={() => onToggleStar(item)}
        >
          {item.starredAt ? "★" : "☆"}
        </button>
      )}
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
  const [syncProgress, setSyncProgress] = useState<RunningSyncStatus | null>(null);
  const [progressClock, setProgressClock] = useState(Date.now());
  const [showSearchRow, setShowSearchRow] = useState(false);
  const [trash, setTrash] = useState(false);
  const [starView, setStarView] = useState(false);

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
  const viewRef = useRef<"list" | "search" | "similar" | "deleted" | "starred">("list");
  // Mirror the view-toggle states for callbacks with stale closures (loadItems
  // is captured by init/refresh paths created before a toggle flipped).
  const trashRef = useRef(false);
  trashRef.current = trash;
  const starViewRef = useRef(false);
  starViewRef.current = starView;
  // Current query/mode for callbacks created before the latest keystroke
  // (the post-sync search restore).
  const queryRef = useRef("");
  queryRef.current = query;
  const searchModeRef = useRef<SearchMode>("fts");
  searchModeRef.current = searchMode;
  const stoppingRef = useRef(false);
  stoppingRef.current = stopping;
  const coordinatorStopRef = useRef<() => void>(() => {});
  // refreshView is defined below in the sync section; the delete callbacks
  // above it reach the latest version through this ref.
  const refreshViewRef = useRef<() => Promise<void>>(async () => {});

  const listStatus = useCallback(
    (total: number, lastMeta: ProviderMeta | null, view: "list" | "deleted" | "starred") => {
      // meta is null in the All view (each provider has its own sync time).
      setStatus({
        text:
          view === "deleted"
            ? total
              ? `${total} deleted items`
              : "No deleted items."
            : view === "starred"
              ? total
                ? `${total} starred items`
                : "No starred items yet — press ☆ on an item to keep it here."
              : total
                ? `${total} saved items${lastMeta ? ` · ${formatSynced(lastMeta.syncedAt)}` : ""}`
                : "No items yet — press Sync to fetch your saved items.",
      });
    },
    []
  );

  const loadItems = useCallback(
    async (providerChoice: ProviderChoice = providerRef.current) => {
      const view = trashRef.current ? "deleted" : starViewRef.current ? "starred" : "list";
      viewRef.current = view;
      const gen = ++generationRef.current;
      try {
        const res = await api.listItems({
          provider: providerChoice === ALL ? null : providerChoice,
          deleted: view === "deleted",
          starred: view === "starred",
          limit: PAGE_SIZE,
          offset: 0,
        });
        if (gen !== generationRef.current) return; // view changed while we were waiting
        offsetRef.current = res.items.length;
        totalRef.current = res.total;
        setItems(res.items);
        setMeta(res.meta);
        setHasMore(res.items.length < res.total);
        // Search covers the plain live list only — filtered views hide the bar.
        setShowSearchRow(view === "list" && res.total > 0);
        listStatus(res.total, res.meta, view);
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
        starred: viewRef.current === "starred",
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
        if (st?.running) void watchSync(st);
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
    if (viewRef.current === "list" || viewRef.current === "deleted" || viewRef.current === "starred") {
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
      listStatus(totalRef.current, null, "deleted");
    },
    [api, dropRow, listStatus]
  );

  // Star/unstar toggles in place; in the Starred view an unstar removes the
  // row (it no longer belongs there). No Undo needed — the button is its own.
  const toggleStar = useCallback(
    async (item: SavedItem) => {
      const starred = !item.starredAt;
      try {
        await api.setItemStarred({ id: item.id, starred });
      } catch (e) {
        setStatus({ text: errorText(e), error: true });
        return;
      }
      if (!starred && viewRef.current === "starred") {
        dropRow(item.id);
        listStatus(totalRef.current, null, "starred");
      } else {
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, starredAt: starred ? Date.now() : null } : i))
        );
      }
    },
    [api, dropRow, listStatus]
  );

  // The two filtered views are mutually exclusive — turning one on turns the
  // other off; search is live-list-only, so entering/leaving either resets it.
  const toggleTrash = useCallback(() => {
    const next = !trashRef.current;
    trashRef.current = next;
    setTrash(next);
    starViewRef.current = false;
    setStarView(false);
    setQuery("");
    void loadItems();
  }, [loadItems]);

  const toggleStarView = useCallback(() => {
    const next = !starViewRef.current;
    starViewRef.current = next;
    setStarView(next);
    trashRef.current = false;
    setTrash(false);
    setQuery("");
    void loadItems();
  }, [loadItems]);

  // ---------- sync ----------

  // Post-sync: refresh whatever the user is looking at instead of
  // unconditionally replacing it with the list (a query typed mid-sync used
  // to keep its text but lose its results). "similar" is left untouched —
  // its results don't change with new items and the user navigated there
  // deliberately.
  const refreshView = useCallback(async () => {
    if (viewRef.current === "search" && queryRef.current.trim()) {
      await runSearch(queryRef.current, searchModeRef.current);
    } else if (
      viewRef.current === "list" ||
      viewRef.current === "deleted" ||
      viewRef.current === "starred"
    ) {
      await loadItems();
    }
  }, [loadItems, runSearch]);
  refreshViewRef.current = refreshView;

  // One non-overlapping coordinator serves both locally-started and
  // reattached runs. Progress polling is view-independent; live list writes
  // remain guarded so searches and similar/filtered views are never replaced.
  const startSyncCoordinator = useCallback(
    (mode: "local" | "reattached", initial?: RunningSyncStatus) => {
      coordinatorStopRef.current();
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (initial) {
        setSyncProgress(initial);
        setSyncing(true);
      }
      const stop = () => {
        active = false;
        clearTimeout(timer);
      };
      coordinatorStopRef.current = stop;

      const poll = async () => {
        const snapshot = await api.syncStatus({}).catch(() => null);
        if (!active) return;
        if (snapshot === null) {
          // A transient status-RPC failure says nothing about run ownership;
          // keep the current banner and try again without overlapping calls.
        } else if (snapshot.running) {
          setSyncProgress(snapshot);
          setSyncing(true);
          if (viewRef.current === "list") {
            const gen = generationRef.current;
            const res = await api
              .listItems({
                provider: providerRef.current === ALL ? null : providerRef.current,
                limit: Math.max(PAGE_SIZE, offsetRef.current),
                offset: 0,
              })
              .catch(() => null);
            if (active && res && gen === generationRef.current && viewRef.current === "list") {
              offsetRef.current = res.items.length;
              totalRef.current = res.total;
              setItems(res.items);
              setMeta(res.meta);
              setHasMore(res.items.length < res.total);
              listStatus(res.total, res.meta, "list");
            }
          }
        } else if (mode === "reattached") {
          stop();
          setSyncProgress(null);
          setSyncing(false);
          const stoppedHere = stoppingRef.current;
          setStopping(false);
          await refreshView();
          if (stoppedHere) setStatus({ text: "Stop requested · fetched items were kept" });
          return;
        }
        if (active) timer = setTimeout(() => void poll(), 800);
      };
      void poll();
      return stop;
    },
    [api, listStatus, refreshView]
  );

  useEffect(() => {
    if (!syncing) return;
    setProgressClock(Date.now());
    const clock = setInterval(() => setProgressClock(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [syncing]);

  useEffect(() => () => coordinatorStopRef.current(), []);

  const doSync = useCallback(
    async () => {
      const startedAt = Date.now();
      setSyncing(true);
      setStopping(false);
      setSyncProgress(null);
      const stopPoll = startSyncCoordinator("local");

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
        const elapsed = shortDuration(Date.now() - startedAt);
        // In capture mode nothing lands in the list — the raw archive grew instead.
        const outcome =
          captured !== undefined
            ? wasStopped
              ? `Captured ${captured} raw pages · stopped after ${elapsed} · fetched pages were kept`
              : `Captured ${captured} raw pages in ${elapsed} (items unchanged — use “Ingest raw” to apply)`
            : wasStopped
              ? `${scopeLabel}: ${report.inserted} new · ${report.total} total · stopped after ${elapsed} · fetched items were kept`
              : `${scopeLabel}: ${report.inserted} new · ${report.total} total · synced in ${elapsed}`;
        setStatus(
          error
            ? { text: `${outcome} · ${error}`, error: true }
            : { text: outcome, similar: viewRef.current === "similar" }
        );
      } catch (e) {
        // Includes the single-flight rejection when another surface (page.html,
        // an earlier popup instance) already has a sync running.
        setStatus({ text: errorText(e), error: true });
      } finally {
        stopPoll();
        setSyncProgress(null);
        setSyncing(false);
        setStopping(false);
      }
    },
    [api, refreshView, startSyncCoordinator, providerLabels]
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
  const watchSync = useCallback(
    async (initial: RunningSyncStatus) => {
      setStopping(false);
      startSyncCoordinator("reattached", initial);
    },
    [startSyncCoordinator]
  );

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
            id="starred"
            class="icon-button"
            title={starView ? "Back to saved items" : "Starred items"}
            aria-pressed={starView}
            onClick={toggleStarView}
          >
            ★
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

      <SyncProgressBanner
        syncing={syncing}
        stopping={stopping}
        progress={syncProgress}
        providerLabels={providerLabels}
        now={progressClock}
      />

      {/* Persistent while a filtered view is open — the header toggle alone is
          too subtle a cue for which view is showing (and how to leave it). */}
      {trash && (
        <div class="view-banner">
          <span>Viewing deleted items</span>
          <button onClick={toggleTrash}>✕ Back to saved items</button>
        </div>
      )}
      {starView && (
        <div class="view-banner">
          <span>Viewing starred items</span>
          <button onClick={toggleStarView}>✕ Back to saved items</button>
        </div>
      )}

      <div id="search-row" hidden={!showSearchRow}>
        <input
          id="search"
          type="search"
          placeholder="Filter saved items…"
          title='Full-text search. Supports FTS5 filters, e.g. kind:short, collection:"watch later", poster_name:"jane doe", poster_handle:jane, cats AND dogs, NOT reel — plus is:starred to search favorites only'
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
            onToggleStar={trash ? undefined : (it) => void toggleStar(it)}
            onDelete={trash ? undefined : (it) => void deleteItem(it)}
            onRestore={trash ? (it) => void restoreItem(it) : undefined}
          />
        ))}
        {hasMore && <li class="sentinel" ref={sentinelRef} />}
      </ul>
    </>
  );
}
