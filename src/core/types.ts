// The domain model — single source of truth for every shape that crosses a
// module or container boundary. Everything here is JSON-safe unless noted;
// vectors (Float32Array) appear only on APIs that ride postMessage, never
// chrome.runtime (JSON serialization mangles typed arrays).

export const PROVIDER_IDS = [
  "linkedin",
  "instagram",
  "youtube",
  "hackernews",
  "twitter",
  "facebook",
  "substack",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------
// Parsed items (parser output → items repo input)
// ---------------------------------------------------------------------------

/**
 * One saved item as extracted by a pure parser (providers own no parsing).
 * Conventions:
 *  - `title` stays "" for post-like items; the author lives in posterName /
 *    posterHandle and is deliberately NEVER duplicated into title — same-author
 *    items sharing a "title" would pollute FTS ranking and cluster embeddings.
 *  - timestamps are epoch ms. `bookmarkedAt` is when the user saved it (rarely
 *    exposed), `publishedAt` when the content appeared (often estimated).
 */
export interface ParsedItem {
  externalId: string;
  url: string;
  title?: string;
  publication?: string;
  summary?: string;
  image?: string;
  bookmarkedAt?: number | null;
  publishedAt?: number | null;
  /** Provider-specific facet: tweet | photo | video | short | story | comment | … */
  kind?: string;
  /** Seconds, for playable media. */
  duration?: number | null;
  /** Collections/playlists/boards the item is saved under. Parsers normalize
   *  to an array — the multi-shape coercion that used to live in db/ops. */
  collection?: string[];
  posterName?: string;
  posterHandle?: string;
  posterBio?: string;
  /** Provider-specific counters/labels, e.g. YouTube {views, age}. */
  stats?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Stored items (items repo output)
// ---------------------------------------------------------------------------

/**
 * A saved_items row as projected by the items repo: camelCase via SQL column
 * aliases, `collection`/`stats` JSON-decoded, and the embedding BLOB excluded
 * (vectors never leave the DB worker except as search math inputs).
 */
export interface SavedItem {
  id: number;
  provider: ProviderId;
  account: string;
  externalId: string;
  url: string;
  title: string | null;
  publication: string | null;
  summary: string | null;
  image: string | null;
  bookmarkedAt: number | null;
  publishedAt: number | null;
  /** Row insert time (epoch ms) — the incremental-sync watermark. */
  createdAt: number;
  /** Soft-delete time (epoch ms); null = live. */
  deletedAt: number | null;
  /** Star/favorite time (epoch ms); null = not starred. */
  starredAt: number | null;
  kind: string;
  duration: number | null;
  collection: string[];
  posterName: string;
  posterHandle: string;
  posterBio: string;
  stats: Record<string, string>;
  /** Cosine similarity, present only on semanticSearch/similar results. */
  similarity?: number;
}

// ---------------------------------------------------------------------------
// Raw pages (provider fetch → sync layer; capture-mode archive rows)
// ---------------------------------------------------------------------------

/** Parse dialect of a fetched page — which parser branch understands it. */
export type PageKind =
  | "items"
  | "stories"
  | "comments"
  | "collections"
  | "playlists"
  | "connection";

/** A raw page exactly as fetched, handed by a provider to onPage. */
export interface RawPage {
  kind: PageKind;
  /** Where it came from (debugging/archive). */
  url: string;
  /** 0-based position within this sync run. */
  page: number;
  /** JSON-safe parse inputs not recoverable from the body (IG collection-id →
   *  name map, YT {playlistId, collection}) — must keep the page independently
   *  re-parseable years later. */
  context?: Json;
  /** The response text, verbatim. */
  body: string;
}

export type RawStatus = "pending" | "ingested" | "failed";

/** A raw_data archive row as projected by the raw repo (capture mode). */
export interface RawDataRow {
  id: number;
  provider: ProviderId;
  account: string;
  kind: PageKind;
  url: string;
  page: number;
  context: Json | null;
  body: string;
  externalIds: string[];
  fetchedAt: number;
  status: RawStatus;
  ingestedAt: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParseResultBase {
  items: ParsedItem[];
  /** Pagination cursor/token/URL for the next page, if any. */
  cursor: string | null;
  hasNext: boolean;
}

/** Kind-specific extras per provider (aux pages feed these). */
export interface ParseResultMap extends Record<ProviderId, ParseResultBase> {
  instagram: ParseResultBase & { collections?: Record<string, string> };
  youtube: ParseResultBase & { playlists?: Record<string, string> };
}

export type ParseResult<K extends ProviderId = ProviderId> = ParseResultMap[K];

/** Input to a pure parser. */
export interface ParsePageInput {
  /** Parse dialect; absent means the provider's default ("items"). */
  kind?: PageKind;
  body: string;
  context?: Json;
  /** When the page was fetched (epoch ms) — anchors relative ages ("2 years ago"). */
  fetchedAt?: number;
}

// ---------------------------------------------------------------------------
// Providers & sync
// ---------------------------------------------------------------------------

/** What the sync layer hands back to the provider for each page: the parse
 *  result (extras optional — a provider reads only its own) plus how many
 *  items weren't already known — `unseen === 0` is the incremental stop
 *  signal (services list newest-first). Non-generic on purpose: providers of
 *  different services must coexist in one registry map. */
export type PageOutcome = ParseResultBase & {
  unseen: number;
  collections?: Record<string, string>;
  playlists?: Record<string, string>;
};

export interface FetchContext {
  /** External ids already stored (empty set ⇒ full sync). */
  knownIds: ReadonlySet<string>;
  /** Providers MUST hand every fetched page here (awaited) before requesting
   *  the next one — the sync layer parses and persists it. */
  onPage(account: string, page: RawPage): Promise<PageOutcome>;
}

export interface Provider {
  id: ProviderId;
  label: string;
  fetchItems(ctx: FetchContext): Promise<{ account: string }>;
  /** Cheap login probe for the status page — mirrors the provider's own sync
   *  precondition (session-cookie presence), so true means fetchItems would
   *  get past its auth guard. No network requests; a stale-but-present
   *  session still reads as logged in until a sync proves otherwise. */
  checkLogin?(): Promise<boolean>;
}

export interface SyncCounts {
  inserted: number;
  updated: number;
  /** Pages archived to raw_data (capture mode only). */
  captured: number;
  /** Rows now stored for this provider. */
  total: number;
}

/**
 * Outcome of syncing one provider — a closed union; syncProvider never throws
 * for provider failures:
 *  - ok:      completed; syncedAt becomes the next incremental watermark
 *  - partial: some pages landed, then a fetch failed (landed pages are kept)
 *  - failed:  nothing landed
 */
export type SyncReport = { providerId: ProviderId } & SyncCounts &
  (
    | { status: "ok"; syncedAt: number }
    | { status: "partial"; error: string; needsLogin: boolean; stopped?: true }
    | { status: "failed"; error: string; needsLogin: boolean; stopped?: true }
  );

export interface AllSyncReport extends SyncCounts {
  reports: SyncReport[];
}

export interface SyncOptions {
  /** Ignore the incremental watermark and re-walk everything. */
  full?: boolean;
  /** Archive raw pages to raw_data instead of upserting (dev pipeline). */
  captureRaw?: boolean;
  /** Test mode: stop signalling after ~this many items (0 = unlimited). */
  maxItems?: number;
  /** syncAllProviders only: restrict the walk to these providers (user
   *  enablement). Absent = all registered providers. syncProvider ignores it —
   *  an explicit single-provider sync is always honored. */
  include?: readonly ProviderId[];
  /** Cooperative stop token, checked at every page boundary. Structural on
   *  purpose: a real AbortSignal satisfies it while core/ stays bare ES2022
   *  (no DOM lib, so no AbortSignal type here). */
  stop?: { readonly aborted: boolean };
}

/** Per-provider sync state persisted in prefs under `meta:<providerId>`. */
export interface ProviderMeta {
  syncedAt: number;
}

// ---------------------------------------------------------------------------
// Ingest (raw_data archive → parse → upsert replay)
// ---------------------------------------------------------------------------

export interface IngestReport {
  pages: number;
  ingested: number;
  failed: number;
  inserted: number;
  updated: number;
  errors: { id: number; provider: ProviderId; error: string }[];
}

// ---------------------------------------------------------------------------
// Search & AI
// ---------------------------------------------------------------------------

export type SearchMode = "hybrid" | "semantic" | "fts";

export interface SearchResult {
  items: SavedItem[];
  /** The mode that actually ran (fallbacks may downgrade to fts). */
  mode: SearchMode;
  /** The mode the caller asked for. */
  requested: SearchMode;
}

export type EmbedProviderId = "local" | "openai" | "gemini" | "voyage";

export interface AiSettings {
  embedProvider: EmbedProviderId;
  keys: Partial<Record<"openai" | "gemini" | "voyage" | "anthropic", string>>;
}

export interface DownloadProgress {
  loaded: number;
  total: number;
}

/** Embedding model state as reported by the AI worker. */
export interface EmbedderStatus {
  ready: boolean;
  model: string;
  dim: number;
  downloading: DownloadProgress | null;
  error: string | null;
}

/** Orchestrator-level status consumed by the UI. */
export interface OrchestratorStatus {
  modelReady: boolean;
  model: string;
  downloading: DownloadProgress | null;
  error: string | null;
  /** Rows still awaiting a vector for the current model. */
  backlog: number;
  embedded: number;
  total: number;
  embedding: { running: boolean; done: number; total: number };
}
