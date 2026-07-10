// Registry mapping providerId → parsePage(input) → ParseResult. This is the
// single parsing entry point the ingestion pipeline uses — the same code
// whether a page was just fetched (normal sync) or replayed from the
// raw_data archive (raw:ingest, tests, tools). The mapped type keys each
// provider to its own ParseResult, so kind-specific extras (IG collections,
// YT playlists) stay precisely typed.
import type { ParsePageInput, ParseResult, ProviderId } from "../types.ts";
import * as linkedin from "./linkedin.ts";
import * as instagram from "./instagram.ts";
import * as youtube from "./youtube.ts";
import * as hackernews from "./hackernews.ts";
import * as twitter from "./twitter.ts";
import * as facebook from "./facebook.ts";
import * as substack from "./substack.ts";

export const PARSERS: { [K in ProviderId]: (page: ParsePageInput) => ParseResult<K> } = {
  linkedin: linkedin.parsePage,
  instagram: instagram.parsePage,
  youtube: youtube.parsePage,
  hackernews: hackernews.parsePage,
  twitter: twitter.parsePage,
  facebook: facebook.parsePage,
  substack: substack.parsePage,
};

export function parsePage<K extends ProviderId>(provider: K, page: ParsePageInput): ParseResult<K> {
  const parse = PARSERS[provider];
  if (!parse) throw new Error(`No parser for provider: ${provider}`);
  return parse(page);
}
