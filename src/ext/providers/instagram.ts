import { ProviderError } from "../../core/errors.ts";
import type { Provider } from "../../core/types.ts";
import { igApiGet } from "../../injected/instagram.ts";
import type { ProviderEnv } from "./env.ts";

const ORIGIN = "https://www.instagram.com";

// Instagram's internal web API that backs instagram.com/<you>/saved/all-posts/.
// x-ig-app-id is the public id of the Instagram web app itself (constant for
// years, sent by every request the website makes). If the endpoint drifts,
// open the saved-posts page and look for feed/saved requests in
// DevTools > Network.
const IG_APP_ID = "936619743392459";

const MAX_PAGES = 100;
const PAGE_DELAY_MS = 900; // Instagram rate-limits harder than LinkedIn
const PAGE_JITTER_MS = 500; // desync from IG's fixed-window rate limiter
const REQUEST_TIMEOUT_MS = 15000; // IG stalls the connection when throttling

// A large initial backfill trips IG's volume throttle after ~8 pages: it
// answers 572 (or stalls the request) for up to ~a minute, then clears
// (verified live 2026-07). So 572 / 429 / 5xx / timeouts are treated as
// transient — back off and retry the same page. Sleeps stay < 30s so the MV3
// service worker isn't suspended mid-wait; if all retries are exhausted the
// sync ends partial (landed items kept) and the next Refresh resumes from the
// top, riding through each wall a little further until the backfill completes.
const RETRY_BACKOFFS_MS = [8000, 15000, 25000];

// Backfill resume checkpoint: the max_id of the next un-fetched saved-feed
// page, persisted so a throttle-interrupted backfill continues where it
// stopped instead of re-walking from the top. Cleared when the backfill
// reaches the end. Raw chrome.storage (env.cache), like facebook's doc_id —
// plumbing state, not a user preference.
const RESUME_KEY = "instagram:resumeMaxId";

const TAB = { pattern: `${ORIGIN}/*`, createUrl: `${ORIGIN}/`, label: "instagram.com" };

// Instagram's bot detection rejects API calls whose browser-controlled
// request context doesn't look like instagram.com's own (HTTP 572). Two
// contexts have been flagged over time:
//   1. The extension's service worker — Referer/Sec-Fetch-Site are wrong.
//   2. A content script's ISOLATED world — Chrome now attributes its fetches
//      distinctly from the page's own, and IG started 572-ing those too
//      (verified 2026-07: the identical fetch returns 200 from the MAIN world
//      and 572 from the isolated world).
// So igApiGet runs in the tab's MAIN world (like the youtube provider), where
// the request is indistinguishable from one the page itself makes — and, as a
// bonus, goes through IG's own patched window.fetch, which adds its
// anti-abuse headers (x-ig-www-claim, x-asbd-id) for free. The tab is an
// existing instagram.com one if open, else a background tab closed after the
// sync.
export function createProvider(env: ProviderEnv): Provider {
  async function getCsrfToken(): Promise<string> {
    const session = await env.getCookie(ORIGIN, "sessionid");
    const csrf = await env.getCookie(ORIGIN, "csrftoken");
    if (!session || !csrf) {
      throw new ProviderError("Not logged in to Instagram. Open instagram.com and sign in first.", {
        needsLogin: true,
      });
    }
    return csrf;
  }

  /** Run a same-origin API GET inside the instagram.com tab, retrying the same
   *  page through transient throttling (see RETRY_BACKOFFS_MS). */
  async function apiGet(tabId: number, path: string, csrfToken: string): Promise<string> {
    let lastStatus = 0;
    let lastBody = "";
    for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
      if (attempt > 0) await env.sleep(RETRY_BACKOFFS_MS[attempt - 1]!);

      let result;
      try {
        result = await env.execInTab(tabId, igApiGet, [path, csrfToken, IG_APP_ID, REQUEST_TIMEOUT_MS], {
          world: "MAIN",
        });
      } catch (e) {
        // The tab itself is gone (closed/navigated) — retrying can't help.
        throw new ProviderError(
          `Lost access to the instagram.com tab mid-sync (${e instanceof Error ? e.message : e}). Try refreshing again.`
        );
      }
      const { status = 0, body = "" } = result ?? {};
      lastStatus = status;
      lastBody = body;

      if (status === 200) {
        try {
          JSON.parse(body); // validation only — raw text goes to onPage, parsing happens in the sync layer
        } catch {
          throw new Error("Instagram returned a non-JSON response (are you logged in?).");
        }
        return body;
      }
      if (status === 401 || status === 403) {
        throw new ProviderError("Instagram session expired. Open instagram.com and sign in again.", {
          needsLogin: true,
        });
      }
      // 429 (rate limit), 572 (volume throttle), other 5xx and 0 (timeout /
      // network) are transient — fall through to the backoff and retry. Any
      // other status is a genuine error worth surfacing immediately.
      const retryable = status === 429 || status === 0 || status >= 500;
      if (!retryable) break;
    }

    if (lastStatus === 429 || lastStatus === 572 || lastStatus === 0 || lastStatus >= 500) {
      throw new ProviderError(
        `Instagram is throttling this sync (HTTP ${lastStatus || "timeout"}). ` +
          `Any items fetched so far were saved; wait a few minutes and press Refresh to continue.`
      );
    }
    throw new Error(`Instagram API returned HTTP ${lastStatus || `error: ${lastBody}`}`);
  }

  /** id → name for the user's saved collections. Media objects in the saved
   *  feed carry a saved_collection_ids array; this map turns those into
   *  names. Only user-created collections (type MEDIA) are requested — "All
   *  posts" is the automatic collection that holds everything. Pages flow
   *  through onPage (kind "collections") so capture mode archives them too. */
  async function fetchCollections(
    tabId: number,
    csrfToken: string,
    account: string,
    onPage: Parameters<Provider["fetchItems"]>[0]["onPage"]
  ): Promise<Record<string, string>> {
    const collections: Record<string, string> = {};
    let maxId: string | null = null;
    for (let page = 0; page < 10; page++) {
      if (page > 0) await pageDelay();
      const params = new URLSearchParams({ collection_types: '["MEDIA"]' });
      if (maxId) params.set("max_id", maxId);
      const path = `/api/v1/collections/list/?${params}`;
      const body = await apiGet(tabId, path, csrfToken);
      const res = await onPage(account, { kind: "collections", url: path, page, body });
      Object.assign(collections, res.collections);
      if (!res.hasNext) break;
      maxId = res.cursor;
    }
    return collections;
  }

  /** The logged-in user's handle, e.g. "sabyasachiruj". */
  async function getAccount(tabId: number, csrfToken: string): Promise<string> {
    try {
      const json = JSON.parse(await apiGet(tabId, "/api/v1/accounts/current_user/", csrfToken)) as {
        user?: { username?: string };
      };
      return json?.user?.username || "unknown";
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      return "unknown";
    }
  }

  /** Pace between pages, jittered so a fixed request cadence doesn't line up
   *  with Instagram's rate-limit window. */
  function pageDelay(): Promise<void> {
    return env.sleep(PAGE_DELAY_MS + Math.floor(Math.random() * PAGE_JITTER_MS));
  }

  return {
    id: "instagram",
    label: "Instagram",
    async fetchItems({ onPage }) {
      const csrfToken = await getCsrfToken();
      return env.withTab(TAB, async (tabId) => {
        const account = await getAccount(tabId, csrfToken);

        let collections: Record<string, string> = {};
        try {
          collections = await fetchCollections(tabId, csrfToken, account, onPage);
        } catch (e) {
          if (e instanceof ProviderError && e.needsLogin) throw e;
          // Collection names are decoration — a drifted collections endpoint
          // shouldn't kill the sync; items just land without a collection.
        }

        // The saved feed is ordered newest-saved-first, so the usual
        // incremental rule applies: a page with nothing unseen means the rest
        // is stored. The collections map rides context so each page stays
        // independently re-parseable from the raw_data archive.
        //
        // Backfill checkpoint: a partial sync records no syncedAt, so without
        // this the next Refresh would restart from the top and re-walk the
        // whole already-synced prefix (burning IG's request-volume budget
        // before reaching new items). Instead we cache the cursor of the next
        // un-fetched page and resume from it — see docs/instagram-provider.md.
        // The trade-off: while resuming we skip items newer than the resume
        // point until the backfill completes and the key is cleared.
        let maxId: string | null = (await env.cache.get(RESUME_KEY)) ?? null;
        let reachedEnd = false;
        try {
          for (let page = 0; page < MAX_PAGES; page++) {
            if (page > 0) await pageDelay();
            const path = `/api/v1/feed/saved/posts/${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ""}`;
            const body = await apiGet(tabId, path, csrfToken);
            const res = await onPage(account, {
              kind: "items",
              url: path,
              page,
              context: { collections },
              body,
            });
            if (res.unseen === 0 || !res.hasNext) {
              reachedEnd = true;
              break;
            }
            maxId = res.cursor;
            // Checkpoint the next page so a throttle-stop resumes exactly there.
            if (maxId) await env.cache.set(RESUME_KEY, maxId);
          }
        } catch (e) {
          // A throttle-stop keeps the checkpoint so the next Refresh continues;
          // any other failure (e.g. a stale cursor IG rejects) clears it so the
          // next Refresh restarts cleanly from the top instead of wedging.
          if (!(e instanceof ProviderError && /throttling/.test(e.message))) {
            await env.cache.remove(RESUME_KEY);
          }
          throw e;
        }
        if (reachedEnd) await env.cache.remove(RESUME_KEY); // backfill complete
        return { account };
      });
    },
  };
}
