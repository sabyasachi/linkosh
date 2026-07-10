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
  summary?: EntityText;
  navigationUrl?: string;
  image?: unknown;
}

interface VoyagerPayload {
  included?: unknown;
  data?: {
    data?: {
      searchDashClustersByAll?: { metadata?: { paginationToken?: string | null } };
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

export function getPaginationToken(json: VoyagerPayload): string | null {
  return json?.data?.data?.searchDashClustersByAll?.metadata?.paginationToken || null;
}

/** Uniform page parser: body is the raw JSON text of one Voyager page.
 *  LinkedIn pages by start offset, so there is no explicit end-of-list
 *  signal — an empty page is the only stop. */
export function parsePage({ body }: ParsePageInput): ParseResult<"linkedin"> {
  const json = JSON.parse(body) as VoyagerPayload;
  const items = parseEntities(json);
  return { items, cursor: getPaginationToken(json), hasNext: items.length > 0 };
}
