// Pure parsers for Hacker News's /upvoted HTML. Regex-based because the
// extension's service worker has no DOMParser; HN's markup has been stable
// for many years, and the selectors used here (athing rows, titleline,
// subtext, commtext) are the same ones its own CSS relies on. No chrome
// APIs, no fetching — runs identically in the extension and under Node.
import type { ParsedItem, ParseResult, ParsePageInput } from "../types.ts";

const ORIGIN = "https://news.ycombinator.com";

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, "")).trim();

/** Epoch ms from a row's age span, e.g. title="2026-07-06T13:28:57 1783344537".
 *  Newer markup appends epoch seconds; older markup is just the ISO string
 *  (UTC, no timezone suffix). HN never exposes *upvote* time, so this is the
 *  submission/comment publish time. */
export function parseAge(chunk: string): number {
  const t = chunk.match(/<span class="age" title="([^"]+)"/)?.[1] || "";
  const epoch = t.match(/ (\d{9,})$/)?.[1];
  if (epoch) return +epoch * 1000;
  const ms = Date.parse(t && !t.endsWith("Z") ? `${t}Z` : t);
  return Number.isNaN(ms) ? 0 : ms;
}

const intIn = (chunk: string, re: RegExp): number =>
  parseInt(chunk.match(re)?.[1]?.replace(/,/g, "") || "0", 10);
const hnUser = (chunk: string): string =>
  stripTags(chunk.match(/class="hnuser"[^>]*>([\s\S]*?)<\/a>/)?.[1] || "");

/** Upvoted submissions: pairs of an "athing" title row and a subtext row. */
export function parseStories(html: string): ParsedItem[] {
  const results: ParsedItem[] = [];
  // Split at each story row; a chunk runs to the next story, so it also
  // contains the subtext row (score / author / comment count).
  const chunks = html.split(/<tr class=['"]athing(?: submission)?['"] id=['"]/).slice(1);
  for (const chunk of chunks) {
    const id = chunk.match(/^(\d+)/)?.[1];
    const link = chunk.match(/<span class="titleline"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!id || !link) continue;
    const site = chunk.match(/<span class="sitestr">([^<]*)<\/span>/)?.[1] || "";
    const author = hnUser(chunk);
    const points = intIn(chunk, /<span class="score"[^>]*>([\d,]+)\s*point/);
    const comments = intIn(chunk, />([\d,]+)(?:&nbsp;|\s)comments?</);
    results.push({
      externalId: id,
      title: stripTags(link[2]!),
      posterHandle: author,
      publication: site,
      summary: `${points} points · ${comments} comments`,
      // Open the HN discussion item, not the outbound article. Saved HN
      // users usually want comments/context, and comments already use this
      // same canonical item URL.
      url: `${ORIGIN}/item?id=${id}`,
      image: "",
      publishedAt: parseAge(chunk), // submission time; upvote time isn't exposed
      kind: "story",
      collection: ["upvoted"],
    });
  }
  return results;
}

/** Upvoted comments (/upvoted?id=…&comments=t). Comment-listing pages use
 *  plain <tr class="athing"> rows (the comtr class only appears on item
 *  pages); a commtext div is what tells a comment chunk apart. */
export function parseComments(html: string): ParsedItem[] {
  const results: ParsedItem[] = [];
  const chunks = html.split(/<tr class=['"]athing(?: comtr)?['"] id=['"]/).slice(1);
  for (const chunk of chunks) {
    const id = chunk.match(/^(\d+)/)?.[1];
    if (!id || !chunk.includes('<div class="commtext')) continue;
    const author = hnUser(chunk);
    // The "on: <a …>" link truncates its text but carries the full story
    // title in its title attribute.
    const on = chunk.match(/on:\s*<a href="item\?id=\d+[^"]*"(?:\s+title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/);
    const storyTitle = on ? (on[1] ? decodeEntities(on[1]) : stripTags(on[2]!)) : "";
    // Comment bodies hold only inline markup (<p>, <i>, <a>, <pre>), never
    // nested divs, so the first </div> closes the commtext block.
    const body = chunk.match(/<div class="commtext[^"]*">([\s\S]*?)<\/div>/)?.[1] || "";
    const text = decodeEntities(
      body.replace(/<p>/g, "\n").replace(/<br[^>]*>/g, "\n").replace(/<[^>]+>/g, "")
    ).trim();
    results.push({
      externalId: id,
      // Comments have no title; the body lives in summary only (a first-line
      // "title" would just repeat it) and the author goes in the poster
      // handle facet. The story context rides publication → poster-line
      // tooltip.
      title: "",
      posterHandle: author,
      publication: storyTitle ? `on: ${storyTitle}` : "",
      summary: text,
      url: `${ORIGIN}/item?id=${id}`,
      image: "",
      publishedAt: parseAge(chunk), // comment time; upvote time isn't exposed
      kind: "comment",
      collection: ["upvoted"],
    });
  }
  return results;
}

/** The page's own "More" link, resolved against the page's URL. HN's
 *  pagination style varies by list (?p=N on story lists, a next=<id> cursor
 *  on /upvoted), so following the served link is the only reliable way. */
export function nextPageUrl(html: string, baseUrl: string = ORIGIN): string | null {
  const more = html.match(/<a href=['"]([^'"]+)['"][^>]*class=['"]morelink['"]/)?.[1];
  return more ? new URL(decodeEntities(more), baseUrl).href : null;
}

/** Uniform page parser: body is the raw HTML of one /upvoted page.
 *  kind selects the list flavor: "stories" (default) or "comments".
 *  context.url (the page's own URL) resolves the relative More link. */
export function parsePage({ kind, body, context }: ParsePageInput): ParseResult<"hackernews"> {
  const items = kind === "comments" ? parseComments(body) : parseStories(body);
  const { url } = (context ?? {}) as { url?: string };
  const cursor = nextPageUrl(body, url || ORIGIN);
  return { items, cursor, hasNext: Boolean(cursor) };
}
