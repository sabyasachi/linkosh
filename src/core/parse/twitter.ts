// Pure parsers for X's Bookmarks GraphQL payloads. No chrome APIs, no
// fetching — runs identically in the extension and under Node. Endpoint
// quirks (queryId rotation, feature-flag self-repair) live in the twitter
// provider.
import type { ParsedItem, ParseResult, ParsePageInput } from "../types.ts";

const ORIGIN = "https://x.com";

interface UrlEntity {
  url?: string;
  expanded_url?: string;
}

interface MediaEntity {
  type?: string;
  media_url_https?: string;
  video_info?: { duration_millis?: number };
}

interface Tweet {
  rest_id?: string;
  legacy?: {
    full_text?: string;
    created_at?: string;
    entities?: { urls?: UrlEntity[]; media?: MediaEntity[] };
    extended_entities?: { media?: MediaEntity[] };
  };
  note_tweet?: { note_tweet_results?: { result?: { text?: string } } };
  core?: { user_results?: { result?: TweetUser } };
}

interface TweetUser {
  core?: { screen_name?: string; name?: string };
  legacy?: { screen_name?: string; name?: string; profile_image_url_https?: string };
  avatar?: { image_url?: string };
}

interface TimelineEntry {
  content?: {
    entryType?: string;
    cursorType?: string;
    value?: string;
    itemContent?: { tweet_results?: { result?: Tweet & { tweet?: Tweet } } };
  };
}

interface BookmarksPayload {
  data?: {
    bookmark_timeline_v2?: {
      timeline?: { instructions?: { type?: string; entries?: TimelineEntry[] }[] };
    };
  };
}

/** Replace t.co redirect links with their real targets and drop the trailing
 *  t.co media links (they point back at the tweet itself). */
export function tweetText(tweet: Tweet): string {
  let text = tweet.note_tweet?.note_tweet_results?.result?.text || tweet.legacy?.full_text || "";
  for (const u of tweet.legacy?.entities?.urls || []) {
    if (u.url && u.expanded_url) text = text.replaceAll(u.url, u.expanded_url);
  }
  return text.replace(/(?:\s*https:\/\/t\.co\/\w+)+$/, "").trim();
}

export function tweetKind(media: MediaEntity[]): string {
  if (!media.length) return "tweet";
  if (media.some((m) => m.type === "video")) return "video";
  if (media.some((m) => m.type === "animated_gif")) return "gif";
  return "photo";
}

export function parseEntries(json: BookmarksPayload): { results: ParsedItem[]; cursor: string | null } {
  const instructions = json?.data?.bookmark_timeline_v2?.timeline?.instructions || [];
  const entries = instructions.find((i) => i.type === "TimelineAddEntries")?.entries || [];

  const results: ParsedItem[] = [];
  let cursor: string | null = null;
  for (const entry of entries) {
    const content = entry?.content;
    if (content?.entryType === "TimelineTimelineCursor" && content.cursorType === "Bottom") {
      cursor = content.value || null;
      continue;
    }
    const result = content?.itemContent?.tweet_results?.result;
    const tweet = result?.tweet || result; // TweetWithVisibilityResults wraps the tweet
    if (!tweet?.rest_id || !tweet.legacy) continue;

    // User fields moved from legacy to core in newer payloads; accept both.
    const user = tweet.core?.user_results?.result || {};
    const handle = user.core?.screen_name || user.legacy?.screen_name || "";
    const name = user.core?.name || user.legacy?.name || "";
    const avatar = user.avatar?.image_url || user.legacy?.profile_image_url_https || "";

    const media = tweet.legacy.extended_entities?.media || tweet.legacy.entities?.media || [];
    const text = tweetText(tweet);
    const durationMs = media.find((m) => m.video_info)?.video_info?.duration_millis || 0;

    results.push({
      externalId: tweet.rest_id,
      // Tweets have no title; the text lives in summary only (a first-line
      // "title" would just repeat it) and the author goes in the poster
      // facets. The handle is stored without display punctuation so
      // poster_handle:jane is stable.
      title: "",
      posterName: name,
      posterHandle: handle,
      publication: "",
      summary: text,
      url: `${ORIGIN}/${handle || "i/web"}/status/${tweet.rest_id}`,
      image: media[0]?.media_url_https ? `${media[0].media_url_https}?name=small` : avatar,
      // Post time; X doesn't expose when the bookmark itself was added.
      publishedAt: Date.parse(tweet.legacy.created_at || "") || 0,
      kind: tweetKind(media), // tweet | photo | video | gif
      duration: Math.round(durationMs / 1000),
    });
  }
  return { results, cursor };
}

/** Uniform page parser: body is the raw JSON text of one Bookmarks page. */
export function parsePage({ body }: ParsePageInput): ParseResult<"twitter"> {
  const { results, cursor } = parseEntries(JSON.parse(body) as BookmarksPayload);
  return { items: results, cursor, hasNext: Boolean(cursor) && results.length > 0 };
}
