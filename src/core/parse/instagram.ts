// Pure parsers for Instagram's saved-feed payloads (/api/v1/feed/saved/posts/
// and /api/v1/collections/list/). No chrome APIs, no fetching — runs
// identically in the extension and under Node. Endpoint quirks and capture
// dates live in the instagram provider.
import type { ParsedItem, ParseResult, ParsePageInput } from "../types.ts";

const ORIGIN = "https://www.instagram.com";

interface ImageCandidate {
  width?: number;
  url?: string;
}

interface Media {
  pk?: string | number;
  code?: string;
  product_type?: string;
  media_type?: number;
  video_duration?: number;
  taken_at?: number;
  user?: { username?: string; full_name?: string };
  caption?: { text?: string } | null;
  saved_collection_ids?: unknown;
  image_versions2?: { candidates?: ImageCandidate[] };
  carousel_media?: { image_versions2?: { candidates?: ImageCandidate[] } }[];
}

interface SavedFeedPayload {
  items?: ({ media?: Media } | Media)[];
  more_available?: boolean;
  next_max_id?: string;
}

interface CollectionsPayload {
  items?: { collection_id?: string | number; collection_name?: string }[];
  more_available?: boolean;
  next_max_id?: string;
}

/** Pick the thumbnail candidate closest to ~100px wide, like the LinkedIn
 *  provider does. Carousels use their first slide's image. */
export function pickImage(media: Media | undefined): string {
  const source = media?.image_versions2 || media?.carousel_media?.[0]?.image_versions2;
  const candidates = Array.isArray(source?.candidates) ? source.candidates : [];
  if (!candidates.length) return "";
  const best = [...candidates].sort(
    (a, b) => Math.abs((a.width || 0) - 100) - Math.abs((b.width || 0) - 100)
  )[0];
  return best?.url || "";
}

export function mediaUrl(media: Media): string {
  if (!media?.code) return "";
  const kind = media.product_type === "clips" ? "reel" : "p";
  return `${ORIGIN}/${kind}/${media.code}/`;
}

export function mediaKindLabel(media: Media): string {
  if (media.product_type === "clips") return "Reel";
  if (media.media_type === 8) return "Carousel";
  if (media.media_type === 2) return "Video";
  return "Post";
}

export function parseItems(json: SavedFeedPayload, collections: Map<string, string> = new Map()): ParsedItem[] {
  const entries = Array.isArray(json?.items) ? json.items : [];
  const results: ParsedItem[] = [];
  for (const entry of entries) {
    const media = ((entry as { media?: Media })?.media || entry) as Media; // saved feed wraps each post in {media}
    if (!media?.pk) continue;
    const username = media.user?.username || "";
    const caption = media.caption?.text?.trim() || "";
    const collectionIds = Array.isArray(media.saved_collection_ids)
      ? (media.saved_collection_ids as (string | number)[])
      : [];
    results.push({
      externalId: String(media.pk),
      // Posts have no title; the caption lives in summary only (a first-line
      // "title" would just repeat it) and the author goes in the poster
      // facets. Handle punctuation is a display concern; the DB stores the
      // raw username so poster_handle:janedoe works predictably.
      title: "",
      posterName: media.user?.full_name || "",
      posterHandle: username,
      publication: "",
      summary: caption,
      url: mediaUrl(media),
      image: pickImage(media),
      publishedAt: media.taken_at ? media.taken_at * 1000 : 0, // post time; save time isn't exposed
      kind: mediaKindLabel(media).toLowerCase(), // reel | carousel | video | post
      duration: Math.round(media.video_duration || 0),
      // A post can be in several collections; the items repo merges arrays
      // across pages while FTS tokenizes the names for collection filters.
      collection: collectionIds
        .map((id) => collections.get(String(id)))
        .filter((name): name is string => Boolean(name)),
    });
  }
  return results;
}

/** One /api/v1/collections/list/ page → { collections: {id: name}, cursor }.
 *  Only user-created collections (type MEDIA) are requested by the provider —
 *  "All posts" is the automatic collection that holds everything. */
export function parseCollections(json: CollectionsPayload): {
  collections: Record<string, string>;
  cursor: string | null;
  hasNext: boolean;
} {
  const collections: Record<string, string> = {};
  for (const c of json?.items || []) {
    if (c?.collection_id && c.collection_name) {
      collections[String(c.collection_id)] = c.collection_name;
    }
  }
  const cursor = json?.more_available && json?.next_max_id ? json.next_max_id : null;
  return { collections, cursor, hasNext: Boolean(cursor) };
}

/** Uniform page parser. kind "items" (default): a saved-feed page; the
 *  collection-id → name map rides context.collections (plain object, JSON-
 *  safe). kind "collections": a collections/list page — no saveable items,
 *  parsed for its name map. */
export function parsePage({ kind, body, context }: ParsePageInput): ParseResult<"instagram"> {
  const json = JSON.parse(body) as SavedFeedPayload & CollectionsPayload;
  if (kind === "collections") return { items: [], ...parseCollections(json) };
  const ctx = (context ?? {}) as { collections?: Record<string, string> };
  const collections = new Map(Object.entries(ctx.collections || {}));
  const items = parseItems(json, collections);
  const cursor = json?.more_available && json?.next_max_id ? json.next_max_id : null;
  return { items, cursor, hasNext: Boolean(cursor) };
}
