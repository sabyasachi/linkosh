// Pure formatting helpers for the popup/page list — no DOM, no chrome APIs,
// unit-tested under Node. Inputs are the canonical camelCase shapes
// (SavedItem rows or ParsedItem parser output) — the JSON-text tolerance the
// old helpers carried is gone because the repo layer now decodes.
import type { ParsedItem, SavedItem } from "./types.ts";

export function formatSynced(ts: number | undefined, now: number = Date.now()): string {
  if (!ts) return "never synced";
  const minutes = Math.round((now - ts) / 60000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  return `synced ${new Date(ts).toLocaleString()}`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
}

export function formatCollection(collection: string[] | undefined): string {
  return (collection ?? []).filter(Boolean).join(", ");
}

/** Stats keys rendered value-only (the value carries its own unit word);
 *  anything else renders as "key: value". */
const KNOWN_STAT_KEYS = ["videos", "views", "age", "info", "points", "comments"];

export function formatStats(
  stats: Record<string, string> | undefined,
  { hideAge = false }: { hideAge?: boolean } = {}
): string {
  if (!stats) return "";
  const parts: string[] = [];
  for (const key of KNOWN_STAT_KEYS) {
    if (key === "age" && hideAge) continue;
    if (stats[key]) parts.push(String(stats[key]));
  }
  for (const [key, value] of Object.entries(stats)) {
    if (KNOWN_STAT_KEYS.includes(key) || value == null || value === "") continue;
    parts.push(`${key}: ${value}`);
  }
  return parts.join(" · ");
}

export function formatPoster(item: Pick<ParsedItem, "posterName" | "posterHandle">): string {
  const name = item.posterName || "";
  const rawHandle = item.posterHandle || "";
  const handle = rawHandle ? rawHandle.replace(/^@/, "") : "";
  if (name && handle) return `${name} (@${handle})`;
  if (name) return name;
  return handle ? `@${handle}` : "";
}

/** Compact, deterministic labels for Hacker News's image-less list rows.
 *  Recognize only HN's established title prefixes and recurring jobs threads;
 *  ordinary stories deliberately stay HN instead of inheriting a random-looking
 *  first letter from their title. */
export function hackerNewsBadge(item: {
  provider?: string;
  kind?: string;
  title?: string | null;
}): string {
  if (item.provider !== "hackernews") return "";
  if (item.kind === "comment") return "COMMENT";

  const title = (item.title || "").trim();
  if (/^ask hn:\s*(?:who is hiring|who wants to be hired|freelancer\?|seeking freelancer\b)/i.test(title)) {
    return "JOBS";
  }
  if (/^ask hn(?:\s*:|\s+-|\s+—|\s*$)/i.test(title)) return "ASK";
  if (/^show hn(?:\s*:|\s+-|\s+—|\s*$)/i.test(title)) return "SHOW";
  if (/^launch hn(?:\s*:|\s+-|\s+—|\s*$)/i.test(title)) return "LAUNCH";
  return "HN";
}

export function formatRelativeDate(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return "";
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.max(0, Math.floor((now - then) / 86400000));
  if (days < 1) return "today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30.4375);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(days / 365.25);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** An item as the meta-line formatter needs it — SavedItem satisfies this;
 *  parser output does too (provider defaults to ""). */
export type MetaItem = Pick<ParsedItem, "kind" | "duration" | "stats" | "collection"> &
  Partial<Pick<SavedItem, "provider" | "bookmarkedAt" | "publishedAt">> & {
    summary?: string | null;
    title?: string | null;
  };

/** Kinds worth naming in the meta line: ones the row's own text doesn't
 *  already make obvious. A video row says video by looking like one; a
 *  playlist row needs the word, and a Short is a video of a specific sort. */
const KIND_LABELS: Record<string, string> = { short: "Short", playlist: "Playlist" };

/** Older HN rows stored story counters in summary, whose list style is larger
 *  than metadata. Keep recognizing those rows so the UI fix needs no resync. */
export function hackerNewsCounts(item: MetaItem): string {
  const summary = item.summary || "";
  return item.provider === "hackernews" && item.kind === "story" &&
      /^\d[\d,]* points? · \d[\d,]* comments?$/.test(summary)
    ? summary
    : "";
}

function formatSavedDate(item: MetaItem, now: number): string {
  const date = item.bookmarkedAt || item.publishedAt;
  if (!date) return "";
  // YouTube's date is an *estimate* reconstructed from "2 years ago" — show
  // it as the approximation it is instead of a fake-precise calendar date.
  if (item.publishedAt && !item.bookmarkedAt && item.provider === "youtube") {
    const relative = formatRelativeDate(item.publishedAt, now);
    return relative ? `about ${relative}` : "";
  }
  return new Date(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The parts of an item's meta line (provider tag in the All view, kind,
 *  duration, stats, collection, saved date), already filtered — join with " · ". */
export function metaParts(
  item: MetaItem,
  { providerLabel = "", now = Date.now() }: { providerLabel?: string; now?: number } = {}
): string[] {
  // YouTube's raw age text freezes at the value returned by the last sync.
  // Once it has been converted to publishedAt, render that timestamp relative
  // to `now` below so "10 days ago" becomes "11 days ago" tomorrow.
  const hasDynamicYouTubeAge =
    item.provider === "youtube" && !item.bookmarkedAt && Boolean(item.publishedAt);
  const legacyHackerNewsCounts = hackerNewsCounts(item);
  const stats = legacyHackerNewsCounts
    ? { ...item.stats, info: legacyHackerNewsCounts }
    : item.stats;
  // A collection label identical to the title is redundant — a playlist row
  // carries its own name as its collection, which is what groups it with the
  // videos inside it.
  const title = (item.title || "").trim().toLowerCase();
  const collection = (item.collection ?? []).filter((c) => c.trim().toLowerCase() !== title);
  return [
    providerLabel,
    KIND_LABELS[item.kind ?? ""] ?? "",
    item.duration ? formatDuration(item.duration) : "",
    formatStats(stats, { hideAge: hasDynamicYouTubeAge }),
    formatCollection(item.provider === "hackernews" ? [] : collection),
    formatSavedDate(item, now),
  ].filter(Boolean);
}
