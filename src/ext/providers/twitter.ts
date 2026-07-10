import { ProviderError } from "../../core/errors.ts";
import type { Provider } from "../../core/types.ts";
import { xApiGet } from "../../injected/twitter.ts";
import type { ProviderEnv } from "./env.ts";

const ORIGIN = "https://x.com";

// X's internal GraphQL endpoint that backs x.com/i/bookmarks. Like LinkedIn,
// the queryId rotates with web-app deployments, so known ones are tried
// newest-first. To find the current id: open x.com/i/bookmarks, scroll, and
// look for a request to /i/api/graphql/<queryId>/Bookmarks in
// DevTools > Network.
const QUERY_IDS = [
  "QUjXply7fA7fk05FRyajEg", // captured 2024-2025 web app
  "tmd4ifV8RHltzn8ymGg1aw", // older, sometimes still accepted
];

// The public bearer token baked into X's web app — identifies the website
// itself (not the user; that's the auth_token/ct0 cookies) and has been
// constant for many years.
const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// GraphQL requests must send a `features` map of client feature flags and
// reject requests whose map is missing (or has extra) entries. This baseline
// was captured 2026-07; fetchBookmarksPage() self-repairs drift by parsing
// the server's own error messages and retrying.
const BASE_FEATURES: Record<string, boolean> = {
  graphql_timeline_v2_bookmark_timeline: true,
  articles_preview_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  premium_content_api_read_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_grok_analysis_button_from_backend: false,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_grok_image_annotation_enabled: false,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  rweb_tipjar_consultation_enabled: true,
  rweb_video_timestamps_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_awards_web_tipping_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  verified_phone_label_enabled: false,
  view_counts_everywhere_api_enabled: true,
};

const PAGE_SIZE = 20; // what the web app itself requests
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 500;

const TAB: { pattern: string; createUrl: string; label: string } = {
  pattern: `${ORIGIN}/*`,
  createUrl: `${ORIGIN}/`,
  label: "x.com",
};

interface GraphQlErrors {
  errors?: { message?: string }[];
  data?: { bookmark_timeline_v2?: unknown };
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Parse X's own feature-drift errors, e.g. "The following features cannot
 *  be null: foo, bar" (flags the web app now sends that we don't) and
 *  "unknown features: baz" (flags we send that no longer exist). */
export function featureFixes(json: GraphQlErrors | null): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const err of json?.errors || []) {
    const msg = err?.message || "";
    const missing = msg.match(/features cannot be null:\s*([\w,\s]+)/i)?.[1];
    if (missing) add.push(...missing.split(/[,\s]+/).filter(Boolean));
    const unknown = msg.match(/unknown features?:?\s*([\w,\s]+)/i)?.[1];
    if (unknown) remove.push(...unknown.split(/[,\s]+/).filter(Boolean));
  }
  return { add, remove };
}

// X's API is served to its own web pages: the browser-set headers (Referer,
// Sec-Fetch-Site) on a service-worker fetch don't match and can get requests
// rejected. All HTTP therefore runs via the injected xApiGet inside an x.com
// tab — an existing one if open, else a background tab closed after the sync.
export function createProvider(env: ProviderEnv): Provider {
  async function getCsrfToken(): Promise<string> {
    const auth = await env.getCookie(ORIGIN, "auth_token");
    const csrf = await env.getCookie(ORIGIN, "ct0");
    if (!auth || !csrf) {
      throw new ProviderError("Not logged in to X. Open x.com and sign in first.", { needsLogin: true });
    }
    return csrf;
  }

  /** Run a same-origin API GET inside the x.com tab. Returns { status, json,
   *  body } so callers can react to GraphQL error payloads (feature drift,
   *  stale queryId) instead of treating every non-200 as fatal. */
  async function apiGet(
    tabId: number,
    path: string,
    csrfToken: string
  ): Promise<{ status: number; json: GraphQlErrors | null; body: string }> {
    let result;
    try {
      result = await env.execInTab(tabId, xApiGet, [path, csrfToken, BEARER]);
    } catch (e) {
      throw new ProviderError(
        `Lost access to the x.com tab mid-sync (${e instanceof Error ? e.message : e}). Try refreshing again.`
      );
    }
    const { status = 0, body = "" } = result ?? {};
    if (status === 401 || status === 403) {
      throw new ProviderError("X session expired. Open x.com and sign in again.", { needsLogin: true });
    }
    if (status === 429) {
      throw new ProviderError("X is rate limiting. Wait a few minutes and refresh again.");
    }
    let json: GraphQlErrors | null = null;
    try {
      json = JSON.parse(body) as GraphQlErrors;
    } catch {
      if (status === 200) throw new Error("X returned a non-JSON response (are you logged in?).");
    }
    return { status, json, body };
  }

  /** Fetch one bookmarks page, self-repairing the features map when the
   *  server reports drift. `features` is mutated in place so later pages
   *  benefit. Returns { url, body } — the raw text goes to onPage, parsing
   *  happens in the sync layer; the JSON is only inspected here for drift
   *  errors. Throws HttpError(404) for a stale queryId (caller tries the
   *  next one). */
  async function fetchBookmarksPage(
    tabId: number,
    csrfToken: string,
    queryId: string,
    features: Record<string, boolean>,
    cursor: string | null
  ): Promise<{ url: string; body: string }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const variables: Record<string, unknown> = { count: PAGE_SIZE, includePromotedContent: false };
      if (cursor) variables.cursor = cursor;
      const params = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(features),
      });
      const url = `/i/api/graphql/${queryId}/Bookmarks?${params}`;
      const { status, json, body } = await apiGet(tabId, url, csrfToken);
      if (json?.data?.bookmark_timeline_v2) return { url, body };
      const { add, remove } = featureFixes(json);
      if (add.length || remove.length) {
        for (const name of add) features[name] = false;
        for (const name of remove) delete features[name];
        continue;
      }
      const messages = (json?.errors || []).map((e) => e.message).join("; ");
      throw new HttpError(
        `X bookmarks API returned HTTP ${status}${
          messages ? `: ${messages}` : status === 200 ? `: ${body?.slice(0, 200)}` : ""
        }`,
        status
      );
    }
    throw new Error("X bookmarks API kept rejecting the feature flags after several repairs.");
  }

  /** The logged-in user's handle, e.g. "sabyaruj". */
  async function getAccount(tabId: number, csrfToken: string): Promise<string> {
    try {
      const { status, json } = await apiGet(tabId, "/i/api/1.1/account/settings.json", csrfToken);
      const screenName = (json as { screen_name?: string } | null)?.screen_name;
      return (status === 200 && screenName) || "unknown";
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      return "unknown";
    }
  }

  return {
    id: "twitter",
    label: "X (Twitter)",
    async fetchItems({ onPage }) {
      const csrfToken = await getCsrfToken();
      return env.withTab(TAB, async (tabId) => {
        const account = await getAccount(tabId, csrfToken);
        const features = { ...BASE_FEATURES };

        // Find a queryId this X deployment still accepts (stale ones 404).
        let queryId: string | null = null;
        let firstPage: { url: string; body: string } | null = null;
        let lastError: Error | null = null;
        for (const candidate of QUERY_IDS) {
          try {
            firstPage = await fetchBookmarksPage(tabId, csrfToken, candidate, features, null);
            queryId = candidate;
            break;
          } catch (e) {
            if (e instanceof ProviderError) throw e;
            lastError = e as Error;
            if (!(e instanceof HttpError) || e.status !== 404) throw e;
          }
        }
        if (!queryId || !firstPage) {
          throw new ProviderError(
            `X rejected all known API versions (${lastError?.message}). ` +
              "The extension probably needs an update for an X API change."
          );
        }

        // Bookmarks are listed newest-saved-first, so the usual incremental
        // rule applies: a page with nothing unseen means the rest is stored.
        let res = await onPage(account, { kind: "items", url: firstPage.url, page: 0, body: firstPage.body });
        let stop = res.unseen === 0 || !res.items.length;
        let cursor = res.cursor;
        for (let page = 1; !stop && cursor && page < MAX_PAGES; page++) {
          await env.sleep(PAGE_DELAY_MS);
          const { url, body } = await fetchBookmarksPage(tabId, csrfToken, queryId, features, cursor);
          res = await onPage(account, { kind: "items", url, page, body });
          stop = res.unseen === 0 || !res.items.length;
          cursor = res.cursor;
        }
        return { account };
      });
    },
  };
}
