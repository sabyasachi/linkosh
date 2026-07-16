import { ProviderError } from "../../core/errors.ts";
import type { Provider } from "../../core/types.ts";
import { fbDiscoverDocId, fbGraphqlPost, fbReadSavedPage } from "../../injected/facebook.ts";
import type { ProviderEnv } from "./env.ts";

const ORIGIN = "https://www.facebook.com";
const SAVED_URL = `${ORIGIN}/saved/`;

const PAGE_SIZE = 10; // what the Comet saved page itself requests
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 700; // Facebook rate-limits aggressively

// Facebook's saved-items page (facebook.com/saved) is a Comet (React) app.
// Two quirks shape this provider (verified against the live site 2026-07):
//
// - The first page of items is server-rendered into the document as embedded
//   Relay JSON (viewer.saver_info.all_saves, nodes of type "Save") — but
//   only for real *navigations*: the same URL requested via fetch() returns
//   a shell without the data. So the provider works in a tab that is
//   actually showing /saved/ (an existing one if open, else a background tab
//   navigated there and closed after the sync) and reads the embedded JSON
//   out of its DOM (injected fbReadSavedPage).
//
// - Later pages use Facebook's *persisted queries*: the query text never
//   leaves Facebook, requests only send a numeric doc_id that rotates with
//   web-app deployments. The current doc_id for
//   CometSaveDashboardAllItemsPaginationQuery is discovered by scanning the
//   page's own loaded JS bundles for its "<name>_facebookRelayOperation"
//   module (injected fbDiscoverDocId), and cached (env.cache, backed by
//   chrome.storage.local) until it stops working.
//
// Facebook exposes neither the save timestamp nor the user's handle here:
// bookmarked_at stays NULL and the account is the numeric c_user id.

const PAGINATION_QUERY = "CometSaveDashboardAllItemsPaginationQuery";
const DOC_ID_CACHE_KEY = "facebook:paginationDocId";

const TAB = { pattern: `${ORIGIN}/saved*`, createUrl: SAVED_URL, label: "facebook.com" };

interface FbPageParams {
  docId: string;
  fbDtsg: string;
  userId: string;
  cursor: string | null;
}

export function createProvider(env: ProviderEnv): Provider {
  function tabLost(e: unknown): ProviderError {
    return new ProviderError(
      `Lost access to the facebook.com tab mid-sync (${e instanceof Error ? e.message : e}). Try refreshing again.`
    );
  }

  /** The logged-in user's numeric id, from the c_user cookie. */
  async function getUserId(): Promise<string> {
    const cUser = await env.getCookie(ORIGIN, "c_user");
    const xs = await env.getCookie(ORIGIN, "xs");
    if (!cUser || !xs) {
      throw new ProviderError("Not logged in to Facebook. Open facebook.com and sign in first.", {
        needsLogin: true,
      });
    }
    return cUser;
  }

  /** Pull the server-rendered first page (and the fb_dtsg request token) out
   *  of the /saved/ tab's DOM. Retries briefly: the embedded payloads stream
   *  in and may land moments after the tab reports complete. */
  async function readSavedPage(tabId: number) {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await env.sleep(800);
      let result;
      try {
        result = await env.execInTab(tabId, fbReadSavedPage, []);
      } catch (e) {
        throw tabLost(e);
      }
      if (result?.connection && result?.fbDtsg) {
        return result as { fbDtsg: string; connection: object };
      }
      if (attempt === 5) {
        if (!result?.fbDtsg) {
          throw new ProviderError(
            "Couldn't find Facebook's request token (fb_dtsg) — are you logged in on facebook.com?",
            { needsLogin: true }
          );
        }
        throw new ProviderError(
          "Couldn't find saved items in facebook.com/saved — Facebook may have changed its page format."
        );
      }
    }
  }

  async function discoverDocId(tabId: number): Promise<string | null> {
    try {
      return (await env.execInTab(tabId, fbDiscoverDocId, [PAGINATION_QUERY])) ?? null;
    } catch (e) {
      throw tabLost(e);
    }
  }

  /** One pagination request. Variables verified live: no container id needed —
   *  the query pages the viewer's own saves. Responses can be a stream of
   *  JSON lines (deferred payloads); the page of items is in the line whose
   *  data holds a connection. Some endpoints also prefix a for(;;); guard. */
  async function fetchNextPage(tabId: number, { docId, fbDtsg, userId, cursor }: FbPageParams): Promise<object> {
    const body = new URLSearchParams({
      av: userId,
      __user: userId,
      fb_dtsg: fbDtsg,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: PAGINATION_QUERY,
      variables: JSON.stringify({ count: PAGE_SIZE, cursor, scale: 1 }),
      server_timestamps: "true",
      doc_id: docId,
    }).toString();

    let result;
    try {
      result = await env.execInTab(tabId, fbGraphqlPost, [body, PAGINATION_QUERY]);
    } catch (e) {
      throw tabLost(e);
    }
    const { status = 0, body: text = "" } = result ?? {};
    if (status === 401 || status === 403) {
      throw new ProviderError("Facebook session expired. Open facebook.com and sign in again.", {
        needsLogin: true,
      });
    }
    if (status === 429) {
      throw new ProviderError("Facebook is rate limiting. Wait a few minutes and refresh again.");
    }
    if (status !== 200) throw new Error(`Facebook returned HTTP ${status || `error: ${text}`}`);

    interface FbGraphQlError {
      message?: string;
      description?: string;
    }
    let errors: FbGraphQlError[] | null = null;
    for (const line of text.replace(/^for\s*\(;;\);/, "").split("\n")) {
      let json: { data?: unknown; errors?: FbGraphQlError[] };
      try {
        json = JSON.parse(line) as { data?: unknown; errors?: FbGraphQlError[] };
      } catch {
        continue;
      }
      errors ||= json.errors ?? null;
      const conn = (function find(obj: unknown, depth: number): object | null {
        if (!obj || typeof obj !== "object" || depth > 22) return null;
        const o = obj as { edges?: unknown; page_info?: unknown };
        if (Array.isArray(o.edges) && o.page_info) return o;
        for (const v of Object.values(obj)) {
          if (v && typeof v === "object") {
            const found = find(v, depth + 1);
            if (found) return found;
          }
        }
        return null;
      })(json.data, 0);
      if (conn) return conn;
    }
    if (errors?.length) {
      throw new Error(
        `Facebook saved-items API: ${errors.map((e) => e.message || e.description).join("; ")}`
      );
    }
    throw new Error("Facebook returned a page without saved items (API change?).");
  }

  return {
    id: "facebook",
    label: "Facebook",
    // Same cookie pair getUserId requires.
    checkLogin: async () =>
      Boolean((await env.getCookie(ORIGIN, "c_user")) && (await env.getCookie(ORIGIN, "xs"))),
    async fetchItems({ onPage }) {
      const userId = await getUserId();
      return env.withTab(TAB, async (tabId) => {
        const { fbDtsg, connection: first } = await readSavedPage(tabId);
        const account = userId; // numeric id; the handle isn't exposed here

        // Saved items are listed newest-saved-first, so the usual incremental
        // rule applies: a page with nothing unseen means the rest is stored.
        // The page body handed over is the extracted Relay *connection*
        // (edges + page_info) as JSON — for the first page it was dug out of
        // the server-rendered DOM, for later pages out of the JSON-lines
        // response.
        let res = await onPage(account, {
          kind: "connection",
          url: SAVED_URL,
          page: 0,
          body: JSON.stringify(first),
        });
        let stop = res.unseen === 0;
        let { cursor, hasNext } = res;
        if (stop || !hasNext) return { account };

        // Items fetched so far are already saved (via onPage), so a doc_id
        // discovery failure surfaces as a partial sync, not a lost one.
        const cached = await env.cache.get(DOC_ID_CACHE_KEY);
        const docId = cached || (await discoverDocId(tabId));
        if (!docId) {
          throw new ProviderError(
            "Synced the first page, but couldn't discover Facebook's pagination query id " +
              `(doc_id). Facebook may have renamed the ${PAGINATION_QUERY} query.`
          );
        }

        const params: FbPageParams = { docId, fbDtsg, userId, cursor };
        for (let page = 1; !stop && hasNext && page < MAX_PAGES; page++) {
          await env.sleep(PAGE_DELAY_MS);
          let connection: object;
          try {
            connection = await fetchNextPage(tabId, params);
          } catch (e) {
            // A cached doc_id can go stale between syncs: rediscover once.
            if (e instanceof ProviderError || params.docId !== cached) throw e;
            await env.cache.remove(DOC_ID_CACHE_KEY);
            const rediscovered = await discoverDocId(tabId);
            if (!rediscovered) throw e;
            params.docId = rediscovered;
            connection = await fetchNextPage(tabId, params);
          }
          res = await onPage(account, {
            kind: "connection",
            url: `${ORIGIN}/api/graphql/#${PAGINATION_QUERY}`,
            page,
            body: JSON.stringify(connection),
          });
          stop = res.unseen === 0;
          params.cursor = res.cursor;
          hasNext = res.hasNext;
        }
        await env.cache.set(DOC_ID_CACHE_KEY, params.docId);
        return { account };
      });
    },
  };
}
