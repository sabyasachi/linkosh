import { ProviderError } from "../../core/errors.ts";
import type { Provider } from "../../core/types.ts";
import type { ProviderEnv } from "./env.ts";

const ORIGIN = "https://substack.com";

const MAX_PAGES = 100;
const PAGE_DELAY_MS = 400;

// Substack's reader API behind substack.com/saved. Endpoint and pagination
// were lifted from the site's own bundles (2026-07): GET
// /api/v1/reader/saved?filter=all returns { items, nextCursor }, and the
// client requests the next page with ?cursor=<nextCursor>. Items wrap either
// a post (with its publication) or a comment (a saved Substack note). Plain
// session-cookie auth — no CSRF token or page-context material — so requests
// go straight from the service worker like LinkedIn and Hacker News.

async function apiGet(path: string): Promise<string> {
  const res = await fetch(`${ORIGIN}${path}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("Substack session expired. Open substack.com and sign in again.", {
      needsLogin: true,
    });
  }
  if (res.status === 429) {
    throw new ProviderError("Substack is rate limiting. Wait a few minutes and refresh again.");
  }
  if (!res.ok) throw new Error(`Substack API returned HTTP ${res.status}`);
  // Raw text — it goes to onPage untouched, parsing happens in the sync layer.
  return res.text();
}

/** The logged-in user's handle, e.g. "sabyaruj". */
async function getAccount(): Promise<string> {
  try {
    const json = JSON.parse(await apiGet("/api/v1/user/profile/self")) as {
      profile?: { handle?: string; name?: string };
      handle?: string;
      name?: string;
    };
    const profile = json?.profile || json;
    return profile?.handle || profile?.name || "unknown";
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    return "unknown";
  }
}

export function createProvider(env: ProviderEnv): Provider {
  return {
    id: "substack",
    label: "Substack",
    // Same cookie fetchItems' auth guard requires.
    checkLogin: async () => Boolean(await env.getCookie(ORIGIN, "substack.sid")),
    async fetchItems({ onPage }) {
      if (!(await env.getCookie(ORIGIN, "substack.sid"))) {
        throw new ProviderError("Not logged in to Substack. Open substack.com and sign in first.", {
          needsLogin: true,
        });
      }
      const account = await getAccount();

      // The saved list is ordered newest-saved-first, so the usual incremental
      // rule applies: a page with nothing unseen means the rest is stored.
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        if (page > 0) await env.sleep(PAGE_DELAY_MS);
        const params = new URLSearchParams({ filter: "all" });
        if (cursor) params.set("cursor", cursor);
        const path = `/api/v1/reader/saved?${params}`;
        const body = await apiGet(path);
        const res = await onPage(account, { kind: "items", url: path, page, body });
        if (res.unseen === 0 || !res.hasNext) break;
        cursor = res.cursor;
      }
      return { account };
    },
  };
}
