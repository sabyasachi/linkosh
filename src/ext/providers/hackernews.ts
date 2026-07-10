import { ProviderError } from "../../core/errors.ts";
import type { Provider } from "../../core/types.ts";
import type { ProviderEnv } from "./env.ts";

const ORIGIN = "https://news.ycombinator.com";

const MAX_PAGES = 100; // 30 items per page
const PAGE_DELAY_MS = 500; // HN blocks clients that page too quickly

// Hacker News's official (Firebase) API does not expose upvoted items — they
// only appear on the private news.ycombinator.com/upvoted page (plus its
// &comments=t twin for upvoted comments), so this provider fetches those
// pages with the existing session cookie and scrapes the HTML (parsing lives
// in core/parse/hackernews.ts; regex-based because MV3 service workers have
// no DOMParser). Both lists are ordered newest-upvote-first, so the usual
// incremental rule (stop at the first page with nothing unseen) applies.
// Plain cookie auth — requests go straight from the service worker.

async function fetchPage(path: string): Promise<string> {
  const res = await fetch(`${ORIGIN}${path}`, { credentials: "include" });
  if (res.status === 429 || res.status === 503) {
    throw new ProviderError("Hacker News is rate limiting. Wait a minute and refresh again.");
  }
  if (!res.ok) throw new Error(`Hacker News returned HTTP ${res.status}`);
  const html = await res.text();
  if (/not able to serve your requests this quickly/i.test(html)) {
    throw new ProviderError("Hacker News is rate limiting. Wait a minute and refresh again.");
  }
  // HN answers some refused requests with a bare "Sorry." page (HTTP 200).
  // Erroring here keeps a mid-sync refusal visible instead of letting it
  // parse as an empty page and silently end the list.
  if (html.length < 100 && /Sorry/.test(html)) {
    throw new ProviderError("Hacker News refused the request. Wait a minute and refresh again.");
  }
  if (/<form[^>]+action=["']?login/.test(html) || /have to be logged in/i.test(html)) {
    throw new ProviderError("Hacker News session expired. Open news.ycombinator.com and sign in again.", {
      needsLogin: true,
    });
  }
  return html;
}

export function createProvider(env: ProviderEnv): Provider {
  /** The logged-in username, from the "user" cookie ("<name>&<hash>"). */
  async function getUsername(): Promise<string> {
    const cookie = await env.getCookie(ORIGIN, "user");
    if (!cookie) {
      throw new ProviderError("Not logged in to Hacker News. Open news.ycombinator.com and sign in first.", {
        needsLogin: true,
      });
    }
    return decodeURIComponent(cookie).split("&")[0]!;
  }

  return {
    id: "hackernews",
    label: "Hacker News",
    async fetchItems({ onPage }) {
      const account = await getUsername();

      // Both lists are ordered newest-upvote-first, so the usual incremental
      // rule applies: a page with nothing unseen means the rest is stored.
      const lists = [
        { query: "", kind: "stories" as const }, // upvoted submissions
        { query: "&comments=t", kind: "comments" as const }, // upvoted comments
      ];
      let firstRequest = true;
      for (const { query, kind } of lists) {
        let url: URL | null = new URL(`/upvoted?id=${encodeURIComponent(account)}${query}`, ORIGIN);
        for (let page = 0; page < MAX_PAGES && url; page++) {
          if (!firstRequest) await env.sleep(PAGE_DELAY_MS);
          firstRequest = false;
          const html = await fetchPage(url.pathname + url.search);
          // context.url lets the parser resolve the page's relative "More"
          // link; HN's pagination style varies by list (?p=N on story lists,
          // a next=<id> cursor on /upvoted), so following the served link is
          // the only reliable way — the resolved URL comes back as res.cursor.
          const res = await onPage(account, {
            kind,
            url: url.href,
            page,
            context: { url: url.href },
            body: html,
          });
          if (res.unseen === 0) break;
          url = res.cursor ? new URL(res.cursor) : null;
        }
      }
      return { account };
    },
  };
}
