// Pure parsers for Facebook's saved-items Relay payloads. The provider hands
// over a *connection* object ({ edges, page_info }) — either read from the
// server-rendered /saved/ page or dug out of a pagination response — as JSON
// text. No chrome APIs, no fetching — runs identically in the extension and
// under Node. Page-scrape and doc_id quirks live in the facebook provider.
import type { ParsedItem, ParseResult, ParsePageInput } from "../types.ts";

const ORIGIN = "https://www.facebook.com";

interface Actor {
  name?: string;
  url?: string;
  profile_url?: string;
}

interface Story {
  actors?: Actor[];
  owner_group?: { name?: string; full_name?: string };
}

interface Savable {
  __typename?: string;
  savable_title?: unknown;
  savable_description?: unknown;
  savable_permalink?: string;
  url?: string;
  savable_image?: { uri?: string };
  playable_duration?: number;
  savable_actors?: Actor[];
  story?: Story;
}

export interface SaveNode {
  id?: unknown;
  savable?: Savable;
  container_savable?: Savable;
  story_pointer?: { savable_image?: { uri?: string } };
  containing_lists?: { nodes?: ({ name?: string } | null)[] };
}

export interface Connection {
  edges?: ({ node?: SaveNode } | null)[];
  page_info?: { end_cursor?: string | null; has_next_page?: boolean };
}

export const textOf = (v: unknown): string =>
  typeof v === "string" ? v : typeof (v as { text?: unknown })?.text === "string" ? (v as { text: string }).text : "";

export function facebookHandle(url: string): string {
  try {
    const u = new URL(url);
    if (!/^(www\.)?facebook\.com$/i.test(u.hostname)) return "";
    const first = u.pathname.split("/").filter(Boolean)[0] || "";
    if (!first || ["groups", "watch", "profile.php", "permalink.php", "story.php"].includes(first)) return "";
    return decodeURIComponent(first);
  } catch {
    return "";
  }
}

function firstActor(node: SaveNode, savable: Savable): Actor {
  const story = node.container_savable?.story || savable.story || {};
  return (
    node.container_savable?.savable_actors?.[0] || savable.savable_actors?.[0] || story.actors?.[0] || {}
  );
}

function groupPublication(node: SaveNode, savable: Savable): string {
  const group = node.container_savable?.story?.owner_group || savable.story?.owner_group || {};
  return group.name || group.full_name || "";
}

/** Field paths verified against the live payload; see the Save node shape:
 *  { id, savable, container_savable, containing_lists }. As of captures from
 *  2026-07, `savable_attributes` is a mixed display label ("Post", media
 *  count, author/page) and is not stored. The actual author is usually in
 *  `container_savable.savable_actors[0]`; group context, when present, is in
 *  `*.story.owner_group`. */
export function parseNode(node: SaveNode): ParsedItem | null {
  if (typeof node?.id !== "string") return null;
  const savable = node.savable || {};
  const text = textOf(savable.savable_title);
  const actor = firstActor(node, savable);
  const publication = groupPublication(node, savable);
  const url = savable.savable_permalink || savable.url || "";
  const kind = (savable.__typename || "").toLowerCase();
  return {
    externalId: node.id,
    // Posts have no title; the text lives in summary only (a first-line
    // "title" would just repeat it). Poster identity comes from the actor,
    // while publication is reserved for the group name when the saved post was
    // made in a Facebook group.
    title: "",
    publication,
    posterName: actor.name || "",
    posterHandle: facebookHandle(actor.url || actor.profile_url || ""),
    summary: text || textOf(savable.savable_description),
    url: url.startsWith("/") ? ORIGIN + url : url,
    image: savable.savable_image?.uri || node.story_pointer?.savable_image?.uri || "",
    kind: kind === "storypointer" ? "post" : kind, // post | video | photo | …
    duration: Math.round(savable.playable_duration || 0),
    // A save can sit in several of the user's collections; the items repo
    // stores the array as JSON text while FTS still tokenizes the names.
    collection: (node.containing_lists?.nodes || [])
      .map((n) => n?.name)
      .filter((name): name is string => Boolean(name)),
  };
}

/** One Relay connection → { items, cursor, hasNext }. */
export function parseConnection(connection: Connection): ParseResult<"facebook"> {
  const items: ParsedItem[] = [];
  for (const edge of connection?.edges || []) {
    const item = edge?.node && parseNode(edge.node);
    if (item) items.push(item);
  }
  const cursor = connection?.page_info?.end_cursor || null;
  const hasNext = Boolean(connection?.page_info?.has_next_page && cursor);
  return { items, cursor, hasNext };
}

/** Uniform page parser: body is the JSON text of one connection object
 *  (kind "connection" — the only page shape this provider stores). */
export function parsePage({ body }: ParsePageInput): ParseResult<"facebook"> {
  return parseConnection(JSON.parse(body) as Connection);
}
