// The shared saved-items UI — one Preact tree mounted by the popup, the
// full-page view and the dev harness (see runtime.ts). Everything the old
// imperative popup.js did lives here: provider tabs, infinite scroll, search
// with mode fallbacks explained, "more like this", sync with live progress,
// export, and the capture-mode dev row.
import { h, Fragment, type ComponentChildren } from "../../vendor/preact/preact.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "../../vendor/preact/hooks.js";
import { formatPoster, formatSynced, hackerNewsCounts, metaParts } from "../../core/format.ts";
import { FTS_OPERATORS } from "../../core/fts.ts";
import type { ProviderId, ProviderMeta, SavedItem, SearchMode, SyncReport } from "../../core/types.ts";
import type { RawStatsRow } from "../../core/db/raw.ts";
import type { Runtime } from "./runtime.ts";

const ALL = "all"; // pseudo provider id: search/list across every service
const PAGE_SIZE = 200; // items fetched per list request (infinite scroll)

type ProviderChoice = ProviderId | typeof ALL;

interface Status {
  text: string;
  error?: boolean;
  /** Shows the ✕ back-to-list control after "more like this". */
  similar?: boolean;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ItemRow({
  item,
  providerLabel,
  onSimilar,
}: {
  item: SavedItem;
  providerLabel: string;
  onSimilar: (item: SavedItem) => void;
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
        {item.image ? (
          <img class="thumb" src={item.image} alt="" />
        ) : (
          <div class="thumb placeholder">{(item.title || "?").slice(0, 1).toUpperCase()}</div>
        )}
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
      {/* Sibling of the <a>, not a child, so clicking it doesn't navigate. */}
      <button class="similar" title="More like this" onClick={() => onSimilar(item)}>
        ≈
      </button>
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
  const [exporting, setExporting] = useState(false);
  const [devStats, setDevStats] = useState<RawStatsRow[] | null>(null); // null = capture mode off
  const [showSearchRow, setShowSearchRow] = useState(false);

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

  const listStatus = useCallback((total: number, lastMeta: ProviderMeta | null) => {
    // meta is null in the All view (each provider has its own sync time).
    setStatus({
      text: total
        ? `${total} saved items${lastMeta ? ` · ${formatSynced(lastMeta.syncedAt)}` : ""}`
        : "No items yet — press Refresh to fetch your saved items.",
    });
  }, []);

  const loadItems = useCallback(
    async (providerChoice: ProviderChoice = providerRef.current) => {
      const gen = ++generationRef.current;
      try {
        const res = await api.listItems({
          provider: providerChoice === ALL ? null : providerChoice,
          limit: PAGE_SIZE,
          offset: 0,
        });
        if (gen !== generationRef.current) return; // view changed while we were waiting
        offsetRef.current = res.items.length;
        totalRef.current = res.total;
        setItems(res.items);
        setMeta(res.meta);
        setHasMore(res.items.length < res.total);
        setShowSearchRow(res.total > 0);
        listStatus(res.total, res.meta);
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
        await Promise.all([loadItems(choice), refreshDevRow()]);
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
      const gen = ++generationRef.current; // stop in-flight list pages from appending
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

  // ---------- sync ----------

  const doSync = useCallback(
    async (full: boolean) => {
      setSyncing(true);
      setStatus({
        text: full
          ? "Full sync — re-fetching everything, this can take a while…"
          : "Checking for new saved items…",
      });

      // Pages are saved to the DB as the sync fetches them, so re-render the
      // list periodically to show progress while the sync call is pending.
      let running = true;
      const poll = setInterval(() => {
        void (async () => {
          const res = await api
            .listItems({
              provider: providerRef.current === ALL ? null : providerRef.current,
              limit: Math.max(PAGE_SIZE, offsetRef.current),
              offset: 0,
            })
            .catch(() => null);
          if (!running || !res) return;
          offsetRef.current = res.items.length;
          totalRef.current = res.total;
          setItems(res.items);
          setHasMore(res.items.length < res.total);
          setStatus({ text: `Syncing… ${res.total} items in database so far` });
        })();
      }, 800);

      try {
        const choice = providerRef.current;
        const report =
          choice === ALL ? await api.syncAll({ full }) : await api.sync({ provider: choice, full });
        running = false;
        await loadItems();

        const captured = report.captured > 0 ? report.captured : undefined;
        const error =
          "reports" in report
            ? report.reports
                .filter((r): r is SyncReport & { status: "partial" | "failed" } => r.status !== "ok")
                .map((r) => `${providerLabels.get(r.providerId) || r.providerId}: ${r.error}`)
                .join(" · ")
            : report.status !== "ok"
              ? report.error
              : "";
        // In capture mode nothing lands in the list — the raw archive grew instead.
        const outcome =
          captured !== undefined
            ? `Captured ${captured} raw pages (items unchanged — use “Ingest raw” to apply)`
            : `${report.inserted} new · ${report.total} total · synced just now`;
        setStatus(error ? { text: `${outcome}, then stopped: ${error}`, error: true } : { text: outcome });
      } catch (e) {
        setStatus({ text: errorText(e), error: true });
      } finally {
        running = false;
        clearInterval(poll);
        setSyncing(false);
        void refreshDevRow();
      }
    },
    [api, loadItems, providerLabels]
  );

  // ---------- dev tools (capture mode) ----------
  // Visible only while the captureRaw setting (options page) is on: syncs
  // archive raw response pages instead of writing items, and these controls
  // replay ("Ingest raw") or drop ("Clear raw") the archive.

  const refreshDevRow = useCallback(async () => {
    const res = await api.rawStats({}).catch(() => null);
    setDevStats(res?.captureRaw ? res.stats : null);
  }, [api]);

  const ingestRaw = useCallback(async () => {
    setStatus({ text: "Ingesting raw pages…" });
    try {
      const r = await api.rawIngest({});
      await loadItems();
      setStatus({
        text:
          `Ingested ${r.ingested} of ${r.pages} raw pages` +
          (r.failed ? ` (${r.failed} failed — see raw_data.error)` : "") +
          ` · +${r.inserted} new items`,
        error: r.failed > 0,
      });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      void refreshDevRow();
    }
  }, [api, loadItems, refreshDevRow]);

  const clearRaw = useCallback(async () => {
    if (!confirm("Delete every captured raw page? Items already ingested stay.")) return;
    try {
      await api.rawClear({});
      setStatus({ text: "Raw archive cleared." });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    }
    void refreshDevRow();
  }, [api, refreshDevRow]);

  // ---------- export ----------

  const exportDb = useCallback(async () => {
    setExporting(true);
    try {
      await runtime.downloadExport();
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      setExporting(false);
    }
  }, [runtime]);

  // ---------- render ----------

  const devCount = (statsList: RawStatsRow[], statusName: string) =>
    statsList.filter((s) => s.status === statusName).reduce((n, s) => n + s.pages, 0);

  let devRow: ComponentChildren = null;
  if (devStats) {
    const pending = devCount(devStats, "pending");
    const failed = devCount(devStats, "failed");
    const pages = devStats.reduce((n, s) => n + s.pages, 0);
    devRow = (
      <div id="dev-row">
        <span id="raw-stats">
          {`capture mode · ${pages} raw pages` +
            (pending ? ` · ${pending} pending` : "") +
            (failed ? ` · ${failed} failed` : "")}
        </span>
        <button
          id="ingest-raw"
          title="Replay captured raw pages into the item database"
          disabled={pending + failed === 0}
          onClick={() => void ingestRaw()}
        >
          Ingest raw
        </button>
        <button
          id="clear-raw"
          title="Delete every captured raw page"
          disabled={pages === 0}
          onClick={() => void clearRaw()}
        >
          Clear raw
        </button>
      </div>
    );
  }

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
            title="Fetch items saved since the last sync"
            disabled={syncing}
            onClick={() => void doSync(false)}
          >
            Refresh
          </button>
          <button
            id="full-sync"
            title="Re-fetch everything (slow; refreshes stale titles/snippets)"
            disabled={syncing}
            onClick={() => void doSync(true)}
          >
            ⟳ Full
          </button>
          <button
            id="export"
            title="Download the database as a .sqlite file"
            disabled={exporting}
            onClick={() => void exportDb()}
          >
            Export
          </button>
          {runtime.openPage && (
            <button id="expand" title="Open as a full page" onClick={runtime.openPage}>
              ⛶
            </button>
          )}
        </div>
      </header>

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

      {devRow}

      <div id="status" class={status.error ? "error" : ""}>
        {status.text}
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
            onSimilar={(it) => void showSimilar(it)}
          />
        ))}
        {hasMore && <li class="sentinel" ref={sentinelRef} />}
      </ul>
    </>
  );
}
