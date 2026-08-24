// Pure parsers for YouTube's InnerTube browse payloads (playlist contents
// and the playlists feed). No chrome APIs, no fetching — runs identically in
// the extension and under Node. Endpoint quirks (SAPISIDHASH, MAIN-world
// injection) live in the youtube provider.
import type { ParsedItem, ParseResult, ParsePageInput } from "../types.ts";

const ORIGIN = "https://www.youtube.com";

/** InnerTube text nodes come as {simpleText}, {runs:[{text}]} or {content}. */
interface TextNode {
  simpleText?: string;
  runs?: { text?: string }[];
  content?: string;
}

interface Thumbnail {
  thumbnails?: { width?: number; url?: string }[];
}

interface PlaylistVideoRenderer {
  videoId?: string;
  isPlayable?: boolean;
  title?: TextNode;
  shortBylineText?: TextNode;
  videoInfo?: TextNode;
  lengthSeconds?: string;
  thumbnail?: Thumbnail;
  thumbnailOverlays?: { thumbnailOverlayTimeStatusRenderer?: { style?: string } }[];
  navigationEndpoint?: { commandMetadata?: { webCommandMetadata?: { url?: string } } };
}

interface GridPlaylistRenderer {
  playlistId?: string;
  title?: TextNode;
}

interface LockupViewModel {
  contentType?: string;
  contentId?: string;
  metadata?: { lockupMetadataViewModel?: { title?: TextNode } };
}

/** Shelf view-models that carry recommendations, never the playlist's own
 *  rows. Once a playlist's real videos are exhausted, YouTube appends a
 *  "Recommended videos" section to help you add more — served either as one of
 *  these shelves (captured 2026-07-20) or as a recommendations-flagged
 *  itemSectionRenderer (captured 2026-07-22, see isRecommendationSection).
 *  Nothing inside either may be ingested. */
const SHELF_KEYS = new Set(["horizontalShelfViewModel", "shelfRenderer", "richShelfRenderer"]);

/** True for the "Recommended videos" itemSectionRenderer YouTube appends below
 *  a playlist's own videos. Its rows are ordinary playlistVideoRenderers — the
 *  only thing that marks them as suggestions rather than saved items is the
 *  section header's titleStyle: ITEM_SECTION_HEADER_TITLE_STYLE_PLAYLIST_RECOMMENDATIONS
 *  (real playlist rows live in a playlistVideoListRenderer, which has no such
 *  header). Matched loosely so a style rename to another *RECOMMENDATION* enum
 *  still excludes them. */
function isRecommendationSection(section: unknown): boolean {
  const ts = (section as { header?: { itemSectionHeaderRenderer?: { titleStyle?: string } } })
    ?.header?.itemSectionHeaderRenderer?.titleStyle;
  return typeof ts === "string" && ts.includes("RECOMMENDATION");
}

/** Yield every value stored under `key` at any depth, skipping subtrees whose
 *  key is in `skip`. InnerTube nests renderers unpredictably and the wrapping
 *  changes between UI experiments, so parsing scans for renderer objects
 *  instead of hardcoding paths. */
export function* deepFind(
  node: unknown,
  key: string,
  skip?: ReadonlySet<string>,
  depth = 0
): Generator<unknown> {
  if (!node || typeof node !== "object" || depth > 24) return;
  if (Array.isArray(node)) {
    for (const item of node) yield* deepFind(item, key, skip, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (skip?.has(k)) continue;
    if (k === key) yield v;
    else yield* deepFind(v, key, skip, depth + 1);
  }
}

/** Yield only the playlist's actual video rows: `playlistVideoRenderer`s that
 *  are direct elements of a `contents`/`continuationItems` array (the video
 *  list on initial pages, the appended items on continuation pages).
 *
 *  A bare deepFind over the whole payload ingests phantom items, because
 *  YouTube embeds *copies* of the renderer elsewhere: every row's own menu
 *  carries a ready-made playlistVideoRenderer inside a playlistEditEndpoint →
 *  addRendererToItemSectionAction (the row the UI would re-insert on "Add"),
 *  and the Recommended section builds the same structure for videos that are
 *  NOT in the playlist — which is how suggestions ended up ingested as saved
 *  items (captured 2026-07-22). So: never descend into a matched row, and
 *  never enter a shelf or a recommendation section. */
function* playlistVideoRows(node: unknown, depth = 0): Generator<PlaylistVideoRenderer> {
  if (!node || typeof node !== "object" || depth > 24) return;
  if (Array.isArray(node)) {
    for (const item of node) yield* playlistVideoRows(item, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (SHELF_KEYS.has(k)) continue;
    if (k === "itemSectionRenderer" && isRecommendationSection(v)) continue;
    if ((k === "contents" || k === "continuationItems") && Array.isArray(v)) {
      for (const el of v) {
        const row = (el as { playlistVideoRenderer?: PlaylistVideoRenderer } | null)
          ?.playlistVideoRenderer;
        if (row) yield row;
        else yield* playlistVideoRows(el, depth + 1);
      }
    } else yield* playlistVideoRows(v, depth + 1);
  }
}

export function text(t: TextNode | undefined | null): string {
  if (!t) return "";
  return t.simpleText || (Array.isArray(t.runs) ? t.runs.map((r) => r.text ?? "").join("") : "") || t.content || "";
}

/** The token for the next page OF PLAYLIST VIDEOS, or null at the real end.
 *  Two continuation tokens can coexist and only one is ours: the playlist's own
 *  "more videos" token sits inside its playlistVideoListRenderer (initial page)
 *  or beside the real rows in a continuation batch, while a sibling token at the
 *  sectionList level loads the appended "Recommended videos" section. Following
 *  that sibling walked the sync straight from the playlist into suggestions
 *  (captured 2026-07-22), so scope the search to arrays that actually hold real
 *  rows rather than taking the first token anywhere in the payload. */
export function nextContinuation(json: unknown): string | null {
  // Initial page: the real continuation is the last child of the video list.
  for (const list of deepFind(json, "playlistVideoListRenderer", SHELF_KEYS)) {
    const token = tokenIn((list as { contents?: unknown[] })?.contents);
    if (token) return token;
  }
  // Continuation page: a recommendations batch carries an itemSectionRenderer
  // and no direct rows — only take the token from a batch that appended real
  // playlistVideoRenderers.
  for (const action of deepFind(json, "appendContinuationItemsAction", SHELF_KEYS)) {
    const items = (action as { continuationItems?: unknown[] })?.continuationItems;
    if (!Array.isArray(items)) continue;
    const hasRealRows = items.some(
      (el) => (el as { playlistVideoRenderer?: { videoId?: string } })?.playlistVideoRenderer?.videoId
    );
    if (hasRealRows) {
      const token = tokenIn(items);
      if (token) return token;
    }
  }
  return null;
}

/** Token of a continuationItemRenderer that is a direct element of `arr`. */
function tokenIn(arr: unknown[] | undefined): string | null {
  if (!Array.isArray(arr)) return null;
  for (const el of arr) {
    const token = (
      el as {
        continuationItemRenderer?: {
          continuationEndpoint?: { continuationCommand?: { token?: string } };
        };
      }
    )?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) return token;
  }
  return null;
}

/** Pick the thumbnail closest to ~100px wide, like the other providers. */
export function pickImage(thumbnail: Thumbnail | undefined): string {
  const candidates = Array.isArray(thumbnail?.thumbnails) ? thumbnail.thumbnails : [];
  if (!candidates.length) return "";
  const best = [...candidates].sort(
    (a, b) => Math.abs((a.width || 0) - 100) - Math.abs((b.width || 0) - 100)
  )[0];
  return best?.url || "";
}

function estimatePublishedAt(age: string, fetchedAt: number | undefined): number | null {
  if (!age || !fetchedAt) return null;
  const m = age.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const d = new Date(fetchedAt);
  if (!Number.isFinite(d.getTime())) return null;
  if (unit === "second") d.setUTCSeconds(d.getUTCSeconds() - n);
  else if (unit === "minute") d.setUTCMinutes(d.getUTCMinutes() - n);
  else if (unit === "hour") d.setUTCHours(d.getUTCHours() - n);
  else if (unit === "day") d.setUTCDate(d.getUTCDate() - n);
  else if (unit === "week") d.setUTCDate(d.getUTCDate() - n * 7);
  else if (unit === "month") d.setUTCMonth(d.getUTCMonth() - n);
  else if (unit === "year") d.setUTCFullYear(d.getUTCFullYear() - n);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function parseStats(
  info: TextNode | undefined,
  fetchedAt: number | undefined
): { stats: Record<string, string>; publishedAt: number | null } {
  const parts = text(info)
    .split(/[·•]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const age = parts.slice(1).join(" · ");
    return {
      stats: { views: parts[0]!, age },
      publishedAt: estimatePublishedAt(age, fetchedAt),
    };
  }
  if (parts.length === 1) return { stats: { info: parts[0]! }, publishedAt: 0 };
  return { stats: {}, publishedAt: 0 };
}

export function parseVideos(
  json: unknown,
  playlistId: string | undefined,
  collection: string | undefined,
  fetchedAt: number | undefined
): ParsedItem[] {
  const results: ParsedItem[] = [];
  for (const r of playlistVideoRows(json)) {
    if (!r?.videoId || r.isPlayable === false) continue; // deleted/private stubs
    const overlays = Array.isArray(r.thumbnailOverlays) ? r.thumbnailOverlays : [];
    const isShort =
      overlays.some((o) => o?.thumbnailOverlayTimeStatusRenderer?.style === "SHORTS") ||
      (r.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || "").startsWith("/shorts/");
    const title = text(r.title);
    const channel = text(r.shortBylineText);
    const { stats, publishedAt } = parseStats(r.videoInfo, fetchedAt);
    results.push({
      // Same video in two playlists stays one row; the items repo merges the
      // collection arrays as each playlist page is processed.
      externalId: r.videoId,
      title,
      posterName: channel,
      posterHandle: "",
      publication: "",
      summary: "", // playlist pages do not expose descriptions
      stats, // e.g. {views:"1.2M views", age:"2 years ago"}
      url: isShort ? `${ORIGIN}/shorts/${r.videoId}` : `${ORIGIN}/watch?v=${r.videoId}`,
      image: pickImage(r.thumbnail),
      publishedAt, // approximate publish date; YouTube does not expose save time here
      kind: isShort ? "short" : "video",
      duration: parseInt(r.lengthSeconds ?? "", 10) || 0,
      collection: collection ? [collection] : [],
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The playlist itself, as a saved item
// ---------------------------------------------------------------------------

/** Watch Later and Liked videos are system buckets, not playlists the user
 *  chose to save: plain "Save" files a video into Watch Later, and Liked
 *  videos is dropped from the walk entirely by the provider. Neither gets a
 *  row of its own; every other playlist does, including ones you created.
 *  Keyed off the id in context (never a title, which is localized), so
 *  re-ingesting an archived capture years later reaches the same verdict. */
const SYSTEM_PLAYLIST_IDS = new Set(["WL", "LL"]);

interface OldPlaylistHeader {
  title?: TextNode;
  descriptionText?: TextNode;
  numVideosText?: TextNode;
  viewCountText?: TextNode;
  ownerText?: TextNode;
  playlistHeaderBanner?: unknown;
}

interface NewPlaylistHeader {
  title?: { dynamicTextViewModel?: { text?: TextNode } };
  description?: { descriptionPreviewViewModel?: { description?: TextNode } };
  metadata?: unknown;
  heroImage?: unknown;
}

function first<T>(values: Generator<T>): T | undefined {
  for (const value of values) return value;
  return undefined;
}

/** True for a "load more" batch, which carries no header. Only the initial
 *  page of a playlist walk may emit the playlist row — otherwise every
 *  continuation would re-emit it (harmless in the DB, since upsert is
 *  idempotent, but it would inflate the `unseen` count the incremental stop
 *  rule reads). */
function isContinuationPage(json: unknown): boolean {
  return first(deepFind(json, "appendContinuationItemsAction")) !== undefined;
}

/** Every display string in the new header's metadata rows, in served order —
 *  typically the channel name, then "24 videos", "1,234 views", "Updated …". */
function metadataStrings(metadata: unknown): string[] {
  const out: string[] = [];
  for (const parts of deepFind(metadata, "metadataParts")) {
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const value = text((part as { text?: TextNode })?.text);
      if (value) out.push(value);
    }
  }
  return out;
}

// Classifiers for those strings. They are USER_LOCALE text, so this is
// best-effort by design: an unrecognized string is simply dropped rather than
// filed under a wrong key, and every field it feeds is display-only data.
const VIDEO_COUNT_RE = /^(?:no|\d[\d,. ]*)\s*(?:videos?|episodes?)$/i;
const VIEW_COUNT_RE = /views?$/i;
const UPDATED_RE = /^(?:last\s+)?updated\b|\bago$/i;
const PRIVACY_RE = /^(?:public|private|unlisted)$/i;

/** The owning channel's @handle, read from the header's own channel link.
 *  Structural rather than textual, so it survives localization. */
function ownerHandle(header: unknown): string {
  for (const base of deepFind(header, "canonicalBaseUrl")) {
    const match = typeof base === "string" ? base.match(/^\/@([^/?#]+)/) : null;
    if (match) return match[1] ?? "";
  }
  return "";
}

/** Cover art. Scoped to the banner/hero subtree instead of scanning the whole
 *  header, whose other image arrays are the owner's avatar. */
function headerImage(node: unknown): string {
  for (const key of ["thumbnails", "sources"]) {
    for (const arr of deepFind(node, key)) {
      if (!Array.isArray(arr)) continue;
      const url = pickImage({ thumbnails: arr as NonNullable<Thumbnail["thumbnails"]> });
      if (url) return url;
    }
  }
  return "";
}

/**
 * The playlist as an item in its own right — a playlist saved from someone
 * else is something the user saved, and before this it existed only as a
 * `collection` label on other people's videos.
 *
 * Read from the initial page's header, which the provider already fetches:
 * `playlistHeaderRenderer` on the old dialect, `pageHeaderViewModel` on the
 * new one (shapes captured from the two dialects this parser already handles;
 * the field paths below are the unverified part and are why every one of them
 * degrades instead of throwing). A header that drifts out of recognition still
 * yields a row built from `context` alone — id and title are known for
 * certain — because a thin row is a far better failure than a missing
 * playlist, the bug this fixes.
 *
 * Returns null only for pages that must not produce one: continuations,
 * system buckets, and pages whose context never identified a playlist.
 */
export function parsePlaylistHeader(
  json: unknown,
  ctx: { playlistId?: string; collection?: string }
): ParsedItem | null {
  const playlistId = ctx.playlistId;
  if (!playlistId || SYSTEM_PLAYLIST_IDS.has(playlistId)) return null;
  if (isContinuationPage(json)) return null;

  const header = (first(deepFind(json, "playlistHeaderRenderer")) ??
    first(deepFind(json, "pageHeaderViewModel"))) as
    | (OldPlaylistHeader & NewPlaylistHeader)
    | undefined;

  const title =
    text(header?.title as TextNode) ||
    text(header?.title?.dynamicTextViewModel?.text) ||
    ctx.collection ||
    playlistId;
  const summary =
    text(header?.descriptionText) ||
    text(header?.description?.descriptionPreviewViewModel?.description);

  const stats: Record<string, string> = {};
  const videos = text(header?.numVideosText);
  const views = text(header?.viewCountText);
  if (videos) stats.videos = videos;
  if (views) stats.views = views;
  let posterName = text(header?.ownerText);
  for (const value of metadataStrings(header?.metadata)) {
    if (VIDEO_COUNT_RE.test(value)) stats.videos ??= value;
    else if (VIEW_COUNT_RE.test(value)) stats.views ??= value;
    else if (UPDATED_RE.test(value)) stats.age ??= value;
    else if (!PRIVACY_RE.test(value)) posterName ||= value; // first unclassified row = the channel
  }

  return {
    externalId: `playlist:${playlistId}`, // prefixed: the identity key must never
    // collide with an 11-char video id, and changing it later would duplicate
    // rows rather than update them
    title,
    posterName,
    posterHandle: ownerHandle(header),
    publication: "",
    summary, // long descriptions are line-clamped by the list CSS, so kept whole
    stats, // e.g. {videos:"24 videos", views:"1,234 views", age:"Updated today"}
    url: `${ORIGIN}/playlist?list=${playlistId}`,
    image: headerImage(header?.playlistHeaderBanner) || headerImage(header?.heroImage),
    // Neither save time nor a publish time is exposed; "Updated 2 days ago" is
    // an edit time and is not laundered into publishedAt. The list sorts on
    // sort_key regardless.
    bookmarkedAt: null,
    publishedAt: null,
    kind: "playlist",
    duration: 0, // a playlist total is not exposed on the header
    collection: ctx.collection ? [ctx.collection] : [],
  };
}

/** Token for the next page OF THE PLAYLISTS FEED. Deliberately separate from
 *  nextContinuation: that one is scoped to playlist *video* lists, which is
 *  what keeps the sync out of the appended "Recommended videos" section — and
 *  which also means it never matches a feed page, so the feed silently paged
 *  exactly once and every playlist past the first page (with all of its
 *  videos) stayed invisible. The feed is a plain grid, so its token is a
 *  direct child of the grid's item array (initial page) or of the appended
 *  batch (continuation). */
export function feedContinuation(json: unknown): string | null {
  // Scoped to the grid renderers rather than to every "contents"/"items" array
  // in the payload: deepFind does not descend into a subtree it has already
  // matched, so a generic key scan stops at the outermost wrapper and never
  // reaches the grid.
  for (const key of ["gridRenderer", "richGridRenderer"]) {
    for (const grid of deepFind(json, key)) {
      const { items, contents } = (grid ?? {}) as { items?: unknown[]; contents?: unknown[] };
      const token = tokenIn(items) ?? tokenIn(contents);
      if (token) return token;
    }
  }
  for (const action of deepFind(json, "appendContinuationItemsAction")) {
    const token = tokenIn((action as { continuationItems?: unknown[] })?.continuationItems);
    if (token) return token;
  }
  return null;
}

/** id → title from one playlists-feed page, in both renderer dialects
 *  YouTube serves (gridPlaylistRenderer on the old UI, lockupViewModel on
 *  the new one). Seeding Watch Later and dropping Liked videos is the
 *  provider's job — this parses just what the page says. */
export function parsePlaylists(json: unknown): {
  playlists: Record<string, string>;
  cursor: string | null;
  hasNext: boolean;
} {
  const playlists: Record<string, string> = {};
  for (const found of deepFind(json, "gridPlaylistRenderer")) {
    const r = found as GridPlaylistRenderer;
    if (r?.playlistId) playlists[r.playlistId] = text(r.title) || r.playlistId;
  }
  for (const found of deepFind(json, "lockupViewModel")) {
    const v = found as LockupViewModel;
    if (v?.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST" && v.contentId) {
      playlists[v.contentId] = text(v.metadata?.lockupMetadataViewModel?.title) || v.contentId;
    }
  }
  const cursor = feedContinuation(json);
  return { playlists, cursor, hasNext: Boolean(cursor) };
}

/** Uniform page parser. kind "items" (default): one page of a playlist's
 *  videos, plus — on the initial page only — the playlist itself as an item;
 *  the playlist identity rides context {playlistId, collection} because
 *  continuation pages don't identify their playlist. kind "playlists": a
 *  playlists-feed page — an id → title map, no saveable items. */
export function parsePage({ kind, body, context, fetchedAt }: ParsePageInput): ParseResult<"youtube"> {
  const json = JSON.parse(body) as unknown;
  if (kind === "playlists") return { items: [], ...parsePlaylists(json) };
  const ctx = (context ?? {}) as { playlistId?: string; collection?: string };
  const items = parseVideos(json, ctx.playlistId, ctx.collection, fetchedAt);
  // Prepended, not appended: sort keys are handed out in page order, so the
  // playlist lands just above the videos it contains.
  const playlist = parsePlaylistHeader(json, ctx);
  const cursor = nextContinuation(json);
  return { items: playlist ? [playlist, ...items] : items, cursor, hasNext: Boolean(cursor) };
}
