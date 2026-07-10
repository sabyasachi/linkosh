import { ProviderError } from "../../core/errors.ts";
import type { Provider } from "../../core/types.ts";
import type { ProviderEnv } from "./env.ts";

const ORIGIN = "https://www.linkedin.com";

// LinkedIn's internal (Voyager) GraphQL endpoint that backs the
// "My items > Saved posts" page. queryId versions drift over time, so we
// try a few known ones until one works (newest first). To find the current
// one: open linkedin.com/my-items/saved-posts/, scroll, and look for the
// voyagerSearchDashClusters request in DevTools > Network.
const QUERY_IDS = [
  "voyagerSearchDashClusters.a7a0567fa66c52d645b5ff2f960b92aa", // captured 2026-07
];

const PAGE_SIZE = 10; // LinkedIn's own page size for this endpoint
const MAX_PAGES = 100; // hard cap: 1000 items
const PAGE_DELAY_MS = 400; // be gentle, avoid rate limiting

const VOYAGER_HEADERS = (csrfToken: string) => ({
  accept: "application/vnd.linkedin.normalized+json+2.1",
  "csrf-token": csrfToken,
  "x-restli-protocol-version": "2.0.0",
});

function buildUrl(queryId: string, start: number, paginationToken: string | null): string {
  // Voyager uses Rest.li 2.0 URL syntax: parens, colons and commas must stay
  // unencoded, so the URL is assembled by hand instead of URLSearchParams.
  // Only the token value itself (base64, may contain "=") gets encoded.
  const token = paginationToken ? `,paginationToken:${encodeURIComponent(paginationToken)}` : "";
  return (
    `${ORIGIN}/voyager/api/graphql` +
    `?variables=(start:${start}${token},query:(flagshipSearchIntent:SEARCH_MY_ITEMS_SAVED_POSTS))` +
    `&queryId=${queryId}`
  );
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Fetch one page; returns { url, body } — the raw response text goes to
 *  onPage untouched, parsing happens in the sync layer. */
async function fetchPage(
  queryId: string,
  start: number,
  paginationToken: string | null,
  csrfToken: string
): Promise<{ url: string; body: string }> {
  const url = buildUrl(queryId, start, paginationToken);
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: VOYAGER_HEADERS(csrfToken),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("LinkedIn session expired. Open linkedin.com and sign in again.", {
      needsLogin: true,
    });
  }
  if (!res.ok) throw new HttpError(`LinkedIn API returned HTTP ${res.status}`, res.status);
  return { url, body: await res.text() };
}

/** The logged-in member's public handle, e.g. "sabyasachiruj". */
async function getAccount(csrfToken: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/voyager/api/me`, {
    credentials: "include",
    headers: VOYAGER_HEADERS(csrfToken),
  });
  if (!res.ok) return "unknown";
  const json = (await res.json()) as { included?: { publicIdentifier?: string }[] };
  const profile = (json.included || []).find((e) => e.publicIdentifier);
  return profile?.publicIdentifier || "unknown";
}

export function createProvider(env: ProviderEnv): Provider {
  async function getCsrfToken(): Promise<string> {
    const cookie = await env.getCookie(ORIGIN, "JSESSIONID");
    if (!cookie) {
      throw new ProviderError("Not logged in to LinkedIn. Open linkedin.com and sign in first.", {
        needsLogin: true,
      });
    }
    // Cookie value looks like "ajax:1234567890" including the quotes.
    return cookie.replace(/^"|"$/g, "");
  }

  return {
    id: "linkedin",
    label: "LinkedIn",
    async fetchItems({ onPage }) {
      const csrfToken = await getCsrfToken();
      const account = await getAccount(csrfToken);

      // Find a queryId that this LinkedIn deployment still accepts.
      let queryId: string | null = null;
      let firstPage: { url: string; body: string } | null = null;
      let lastError: Error | null = null;
      for (const candidate of QUERY_IDS) {
        try {
          firstPage = await fetchPage(candidate, 0, null, csrfToken);
          queryId = candidate;
          break;
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          lastError = e as Error;
        }
      }
      if (!queryId || !firstPage) {
        throw new ProviderError(
          `LinkedIn rejected all known API versions (${lastError?.message}). ` +
            "The extension probably needs an update for a LinkedIn API change."
        );
      }

      // LinkedIn lists newest-first, so the usual incremental rule applies: a
      // page with nothing unseen (res.unseen === 0) means everything past this
      // point is already stored and we can stop paging.
      let res = await onPage(account, { kind: "items", url: firstPage.url, page: 0, body: firstPage.body });
      let stop = res.unseen === 0;
      let paginationToken = res.cursor;
      for (let page = 1; !stop && page < MAX_PAGES; page++) {
        await env.sleep(PAGE_DELAY_MS);
        const { url, body } = await fetchPage(queryId, page * PAGE_SIZE, paginationToken, csrfToken);
        res = await onPage(account, { kind: "items", url, page, body });
        stop = res.unseen === 0;
        paginationToken = res.cursor || paginationToken;
      }
      return { account };
    },
  };
}
