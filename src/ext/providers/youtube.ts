import { ProviderError } from "../../core/errors.ts";
import type { Provider } from "../../core/types.ts";
import { deepFind, text } from "../../core/parse/youtube.ts";
import { ytInnerTubePost } from "../../injected/youtube.ts";
import type { ProviderEnv } from "./env.ts";

const ORIGIN = "https://www.youtube.com";

const MAX_PAGES = 100; // per playlist; InnerTube pages are ~100 videos each
const MAX_PLAYLIST_LIST_PAGES = 10;
const PAGE_DELAY_MS = 400;

const TAB = { pattern: `${ORIGIN}/*`, createUrl: `${ORIGIN}/`, label: "youtube.com" };

// YouTube has no single "saved videos" feed: pressing Save on a video or a
// Short files it into a playlist (Watch Later by default). So a sync
// enumerates the user's playlists, walks each one, and tags every item with
// the playlist it came from (the `collection` field). The same video saved in
// two playlists stays one row; the items repo merges its collection array.
//
// All HTTP goes through YouTube's internal InnerTube API
// (POST /youtubei/v1/browse) — the same calls the website makes. Authenticated
// InnerTube requests need a SAPISIDHASH Authorization header derived from the
// SAPISID cookie plus the exact client context the page was served with
// (window.ytcfg); both are only reachable from a youtube.com page, so requests
// run via the injected ytInnerTubePost in a youtube.com tab's MAIN world — an
// existing tab if one is open, else a background tab closed after the sync.
export function createProvider(env: ProviderEnv): Provider {
  /** Run an InnerTube POST inside the youtube.com tab (MAIN world). */
  async function apiPost(tabId: number, endpoint: string, payload: object): Promise<string> {
    let result;
    try {
      result = await env.execInTab(tabId, ytInnerTubePost, [endpoint, payload], { world: "MAIN" });
    } catch (e) {
      throw new ProviderError(
        `Lost access to the youtube.com tab mid-sync (${e instanceof Error ? e.message : e}). Try refreshing again.`
      );
    }
    const { status = 0, body = "" } = result ?? {};
    if (status === 401 || status === 403) {
      throw new ProviderError("YouTube session expired. Open youtube.com and sign in again.", {
        needsLogin: true,
      });
    }
    if (status === 429) {
      throw new ProviderError("YouTube is rate limiting. Wait a few minutes and refresh again.");
    }
    if (status !== 200) throw new Error(`YouTube API returned HTTP ${status || `error: ${body}`}`);
    try {
      JSON.parse(body); // validation only — the raw text goes to onPage, parsing happens in the sync layer
    } catch {
      throw new Error("YouTube returned a non-JSON response (are you logged in?).");
    }
    return body;
  }

  /** id → title for every playlist, in both renderer dialects YouTube serves
   *  (gridPlaylistRenderer on the old UI, lockupViewModel on the new one).
   *  Pages flow through onPage (kind "playlists") so capture mode archives
   *  them too. */
  async function listPlaylists(
    tabId: number,
    account: string,
    onPage: Parameters<Provider["fetchItems"]>[0]["onPage"]
  ): Promise<Map<string, string>> {
    // Plain "Save" puts videos in Watch Later, which the playlists feed does
    // not always list — seed it explicitly.
    const playlists = new Map<string, string>([["WL", "Watch later"]]);
    let payload: object = { browseId: "FEplaylist_aggregation" };
    for (let page = 0; page < MAX_PLAYLIST_LIST_PAGES; page++) {
      if (page > 0) await env.sleep(PAGE_DELAY_MS);
      const body = await apiPost(tabId, "browse", payload);
      const res = await onPage(account, {
        kind: "playlists",
        url: "youtubei/v1/browse#FEplaylist_aggregation",
        page,
        body,
      });
      for (const [id, title] of Object.entries(res.playlists ?? {})) playlists.set(id, title);
      if (!res.hasNext) break;
      payload = { continuation: res.cursor };
    }
    playlists.delete("LL"); // Liked videos ≠ saved; skip if the feed lists it
    return playlists;
  }

  /** The logged-in user's handle, e.g. "sabyasachiruj". */
  async function getAccount(tabId: number): Promise<string> {
    try {
      const json = JSON.parse(await apiPost(tabId, "account/account_menu", {})) as unknown;
      type YtText = Parameters<typeof text>[0];
      for (const h of deepFind(json, "activeAccountHeaderRenderer")) {
        const header = h as { channelHandle?: YtText; accountName?: YtText };
        const handle = text(header?.channelHandle) || text(header?.accountName);
        if (handle) return handle.replace(/^@/, "");
      }
    } catch (e) {
      if (e instanceof ProviderError && e.needsLogin) throw e;
    }
    return "unknown";
  }

  return {
    id: "youtube",
    label: "YouTube",
    // Same cookie fetchItems' auth guard requires (Google session).
    checkLogin: async () => Boolean(await env.getCookie(ORIGIN, "SAPISID")),
    async fetchItems({ onPage }) {
      if (!(await env.getCookie(ORIGIN, "SAPISID"))) {
        throw new ProviderError("Not logged in to YouTube. Open youtube.com and sign in first.", {
          needsLogin: true,
        });
      }

      return env.withTab(TAB, async (tabId) => {
        const account = await getAccount(tabId);
        const playlists = await listPlaylists(tabId, account, onPage);

        for (const [playlistId, collection] of playlists) {
          // Watch Later lists newest-saved-first, so the usual incremental
          // rule applies. Other playlists can be manually ordered with new
          // videos appended at the bottom, so they are always walked fully —
          // at ~100 videos per page that stays cheap. Continuation pages
          // don't identify their playlist, so its identity rides context.
          const incremental = playlistId === "WL";
          let payload: object = { browseId: `VL${playlistId}` };
          for (let page = 0; page < MAX_PAGES; page++) {
            await env.sleep(PAGE_DELAY_MS);
            const body = await apiPost(tabId, "browse", payload);
            const res = await onPage(account, {
              kind: "items",
              url: `youtubei/v1/browse#VL${playlistId}`,
              page,
              context: { playlistId, collection },
              body,
            });
            if (!res.hasNext || (incremental && res.unseen === 0)) break;
            payload = { continuation: res.cursor };
          }
        }
        return { account };
      });
    },
  };
}
