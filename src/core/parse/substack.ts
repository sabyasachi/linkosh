// Pure parsers for Substack's reader saved-items payloads
// (/api/v1/reader/saved). No chrome APIs, no fetching — runs identically in
// the extension and under Node. Endpoint quirks and capture dates live in
// the substack provider.
import type { ParsedItem, ParseResult, ParsePageInput } from "../types.ts";

const ORIGIN = "https://substack.com";

interface Post {
  id?: string | number;
  title?: string;
  subtitle?: string;
  truncated_body_text?: string;
  canonical_url?: string;
  cover_image?: string;
  post_date?: string;
  type?: string;
  podcast_duration?: number;
  publishedBylines?: { name?: string }[];
}

interface NoteComment {
  id?: string | number;
  body?: string;
  name?: string;
  handle?: string;
  author?: { handle?: string };
  photo_url?: string;
  date?: string;
}

interface SavedEntry {
  post?: Post;
  comment?: NoteComment;
  publication?: { name?: string };
  saved_at?: string | number;
  savedAt?: string | number;
}

interface SavedPayload {
  items?: SavedEntry[];
  nextCursor?: string | null;
  result?: { items?: SavedEntry[]; nextCursor?: string | null };
}

export const parseDate = (v: string | number | undefined): number => {
  const ms = typeof v === "number" ? v : Date.parse(v || "");
  return Number.isNaN(ms) ? 0 : ms;
};

export function parsePost(post: Post, publication: { name?: string } | undefined, item: SavedEntry): ParsedItem {
  const byline = post.publishedBylines?.[0]?.name || "";
  const pubName = publication?.name || "";
  return {
    externalId: `post:${post.id}`,
    title: post.title || "Untitled post",
    posterName: byline,
    posterHandle: "",
    publication: pubName !== byline ? pubName : "",
    summary: post.subtitle || post.truncated_body_text || "",
    url: post.canonical_url || "",
    image: post.cover_image || "",
    bookmarkedAt: parseDate(item.saved_at ?? item.savedAt),
    publishedAt: parseDate(post.post_date),
    kind: post.type || "post", // newsletter | podcast | video | thread | …
    duration: Math.round(post.podcast_duration || 0),
  };
}

/** Saved Substack notes arrive as comment objects. */
export function parseNote(comment: NoteComment, item: SavedEntry): ParsedItem {
  const body = (comment.body || "").trim();
  const handle = comment.handle || comment.author?.handle || "";
  return {
    externalId: `note:${comment.id}`,
    // Notes have no title; the body lives in summary only (a first-line
    // "title" would just repeat it) and the author goes in the poster facet.
    title: "",
    posterName: comment.name || "",
    posterHandle: handle,
    publication: "",
    summary: body,
    url: handle ? `${ORIGIN}/@${handle}/note/c-${comment.id}` : `${ORIGIN}/note/c-${comment.id}`,
    image: comment.photo_url || "",
    bookmarkedAt: parseDate(item.saved_at ?? item.savedAt),
    publishedAt: parseDate(comment.date),
    kind: "note",
  };
}

export function parseItems(json: SavedPayload): { parsed: ParsedItem[]; nextCursor: string | null } {
  // The client stores the parsed body as page.result; be tolerant of either
  // { items, nextCursor } or { result: { items, nextCursor } }.
  const result = json?.result && !json.items ? json.result : json;
  const items = Array.isArray(result?.items) ? result.items : [];
  const parsed: ParsedItem[] = [];
  for (const item of items) {
    if (item?.post) parsed.push(parsePost(item.post, item.publication, item));
    else if (item?.comment) parsed.push(parseNote(item.comment, item));
  }
  return { parsed, nextCursor: result?.nextCursor || null };
}

/** Uniform page parser: body is the raw JSON text of one reader/saved page. */
export function parsePage({ body }: ParsePageInput): ParseResult<"substack"> {
  const { parsed, nextCursor } = parseItems(JSON.parse(body) as SavedPayload);
  return { items: parsed, cursor: nextCursor, hasNext: Boolean(nextCursor) && parsed.length > 0 };
}
