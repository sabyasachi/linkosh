// Pure parsers for LinkedIn's Voyager saved-posts payloads. No chrome APIs,
// no fetching — runs identically in the extension and under Node (tests,
// tools). Endpoint quirks and capture dates live in the linkedin provider.
import type { ParsedItem, ParseResult, ParsePageInput } from "../types.ts";

interface VectorArtifact {
  width?: number;
  fileIdentifyingUrlPathSegment?: string;
}

interface EntityText {
  text?: string;
}

interface EntityResult {
  $type?: string;
  entityUrn?: string;
  trackingUrn?: string;
  title?: EntityText;
  primarySubtitle?: EntityText;
  secondarySubtitle?: EntityText;
  summary?: EntityText;
  navigationUrl?: string;
  image?: unknown;
  insightsResolutionResults?: {
    simpleInsight?: { title?: EntityText };
  }[];
}

interface VoyagerPayload {
  included?: unknown;
  data?: {
    data?: {
      searchDashClustersByAll?: {
        metadata?: { paginationToken?: string | null };
        paging?: { count?: number; start?: number; total?: number };
      };
    };
  };
}

/** Best-effort: find a LinkedIn vectorImage anywhere inside an object and
 *  compose a concrete URL from rootUrl + one of its artifacts. */
export function findImageUrl(obj: unknown, depth = 0): string {
  if (!obj || typeof obj !== "object" || depth > 8) return "";
  const o = obj as { rootUrl?: unknown; artifacts?: unknown };
  if (typeof o.rootUrl === "string" && Array.isArray(o.artifacts) && o.artifacts.length) {
    const artifacts = [...(o.artifacts as VectorArtifact[])].sort(
      (a, b) => Math.abs((a.width || 0) - 100) - Math.abs((b.width || 0) - 100)
    );
    const seg = artifacts[0]?.fileIdentifyingUrlPathSegment;
    if (seg) return o.rootUrl + seg;
  }
  for (const value of Object.values(obj)) {
    const url = findImageUrl(value, depth + 1);
    if (url) return url;
  }
  return "";
}

export function parseEntities(json: VoyagerPayload): ParsedItem[] {
  const included = Array.isArray(json?.included) ? (json.included as EntityResult[]) : [];
  const results: ParsedItem[] = [];
  for (const entity of included) {
    if (entity?.$type !== "com.linkedin.voyager.dash.search.EntityResultViewModel") continue;
    results.push({
      externalId: entity.entityUrn || entity.trackingUrn || crypto.randomUUID(),
      // entity.title is the *poster's* name (posts have no title of their
      // own; captured 2026-07), so it goes in the poster facet — leaving it
      // in title would give every post by the same person identical "titles",
      // polluting FTS ranking and clustering the embeddings by author.
      title: "",
      posterName: entity.title?.text || "",
      posterHandle: "",
      posterBio: entity.primarySubtitle?.text || "",
      summary: entity.summary?.text || "",
      url: entity.navigationUrl || "",
      image: findImageUrl(entity.image),
    });
  }
  return results;
}

/** Turn a LinkedIn Learning URN type into a stable, readable facet. The type
 *  is locale-independent even though the surrounding display strings are not:
 *  lyndaCourse -> course, lyndaVideo -> video, learningPath -> learning path. */
function learningKind(trackingUrn: string | undefined): string {
  const rawType = /^urn:li:([A-Za-z][A-Za-z0-9]*):/.exec(trackingUrn || "")?.[1];
  if (!rawType) return "learning";
  const withoutLynda = rawType.replace(/^lynda/i, "");
  if (!withoutLynda) return "learning";
  return withoutLynda
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/** Best-effort English display-string parse. The endpoint localizes this text,
 *  so an unrecognized locale deliberately yields null instead of guessing. */
function learningDuration(text: string | undefined): number | null {
  let seconds = 0;
  let found = false;
  for (const match of (text || "").matchAll(/(\d+)\s*(h|m|s)\b/gi)) {
    const value = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (!Number.isFinite(value)) continue;
    seconds += value * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
    found = true;
  }
  return found ? seconds : null;
}

/** Best-effort English "By: Name · Released Mon D, YYYY" parse. Appending UTC
 *  keeps the date-only value deterministic across the extension and Node. */
function learningAuthorAndDate(text: string | undefined): {
  posterName: string;
  publishedAt: number | null;
} {
  const match = /^By:\s*(.*?)\s*·\s*Released\s+(.+?)\s*$/i.exec(text || "");
  if (!match) return { posterName: "", publishedAt: null };
  const parsed = Date.parse(`${match[2]} UTC`);
  return {
    posterName: match[1]?.trim() || "",
    publishedAt: Number.isFinite(parsed) ? parsed : null,
  };
}

function canonicalLearningUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("trk");
    return parsed.href;
  } catch {
    return url;
  }
}

export function parseLearningEntities(json: VoyagerPayload): ParsedItem[] {
  const included = Array.isArray(json?.included) ? (json.included as EntityResult[]) : [];
  const results: ParsedItem[] = [];
  for (const entity of included) {
    if (entity?.$type !== "com.linkedin.voyager.dash.search.EntityResultViewModel") continue;
    const byline = learningAuthorAndDate(entity.secondarySubtitle?.text);
    const views = entity.insightsResolutionResults
      ?.map((insight) => insight.simpleInsight?.title?.text || "")
      .find(Boolean);
    results.push({
      externalId: entity.entityUrn || entity.trackingUrn || crypto.randomUUID(),
      title: entity.title?.text || "",
      publication: "",
      summary: entity.summary?.text || "",
      url: canonicalLearningUrl(entity.navigationUrl),
      image: findImageUrl(entity.image),
      bookmarkedAt: null,
      publishedAt: byline.publishedAt,
      kind: learningKind(entity.trackingUrn),
      duration: learningDuration(entity.primarySubtitle?.text),
      collection: ["My Learning"],
      posterName: byline.posterName,
      posterHandle: "",
      posterBio: "",
      stats: views ? { views } : {},
    });
  }
  return results;
}

export function getPaginationToken(json: VoyagerPayload): string | null {
  return json?.data?.data?.searchDashClustersByAll?.metadata?.paginationToken || null;
}

function learningHasNext(json: VoyagerPayload, itemCount: number): boolean {
  const paging = json?.data?.data?.searchDashClustersByAll?.paging;
  const { start, count, total } = paging || {};
  if (
    [start, count, total].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) &&
    count! > 0
  ) {
    return start! + count! < total!;
  }
  return itemCount > 0;
}

/** Uniform page parser: body is the raw JSON text of one Voyager page. Saved
 *  posts use their pagination token plus the historical non-empty-page signal;
 *  learning uses the explicit offset totals handled below. */
export function parsePage({ kind = "items", body }: ParsePageInput): ParseResult<"linkedin"> {
  const json = JSON.parse(body) as VoyagerPayload;
  if (kind === "learning") {
    const items = parseLearningEntities(json);
    // Learning uses pure offset paging and returns no paginationToken. The
    // paging totals are the load-bearing end signal; older/malformed captures
    // without them degrade to the endpoint's historical non-empty-page rule.
    return { items, cursor: null, hasNext: learningHasNext(json, items.length) };
  }
  const items = parseEntities(json);
  return { items, cursor: getPaginationToken(json), hasNext: items.length > 0 };
}
