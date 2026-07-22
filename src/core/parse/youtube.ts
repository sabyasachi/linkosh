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
  const cursor = nextContinuation(json);
  return { playlists, cursor, hasNext: Boolean(cursor) };
}

/** Uniform page parser. kind "items" (default): one page of a playlist's
 *  videos; the playlist identity rides context {playlistId, collection}
 *  because continuation pages don't identify their playlist. kind
 *  "playlists": a playlists-feed page — no saveable items. */
export function parsePage({ kind, body, context, fetchedAt }: ParsePageInput): ParseResult<"youtube"> {
  const json = JSON.parse(body) as unknown;
  if (kind === "playlists") return { items: [], ...parsePlaylists(json) };
  const ctx = (context ?? {}) as { playlistId?: string; collection?: string };
  const items = parseVideos(json, ctx.playlistId, ctx.collection, fetchedAt);
  const cursor = nextContinuation(json);
  return { items, cursor, hasNext: Boolean(cursor) };
}
