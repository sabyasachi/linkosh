# Instagram provider — bot detection, throttling & backfill

Everything hard-won about syncing Instagram's saved posts. Code:
[src/ext/providers/instagram.ts](../src/ext/providers/instagram.ts),
[src/injected/instagram.ts](../src/injected/instagram.ts). General sync
mechanics: [sync-and-refresh.md](sync-and-refresh.md).

## The endpoint

`GET /api/v1/feed/saved/posts/` (cursor-paginated via `max_id`) backs
instagram.com/<you>/saved/all-posts/. Auth is the session cookie plus
`x-csrftoken` (from `csrftoken`) and the constant public web-app id
`x-ig-app-id: 936619743392459`. Collection names come from a separate
`/api/v1/collections/list/` walk and are joined in by `saved_collection_ids`.

## HTTP 572 layer 1 — the injection *world* (fixed)

572 is Instagram's bot-detection status: it rejects API calls whose
browser-controlled request context (Referer, Sec-Fetch-Site, request
attribution) doesn't look like instagram.com's own. Two contexts have been
flagged over the project's life:

1. The extension **service worker** — headers are plainly wrong.
2. A content script's **isolated world** — Chrome has tightened how it
   attributes isolated-world (content-script) `fetch` requests, and Instagram
   began 572-ing those too, even though they used to pass.

Verified live (2026-07-10): the *identical* request — same path, same four
headers — returns **200 from the page's MAIN world** and **572 from the
isolated world**. The fix is to inject `igApiGet` with `{ world: "MAIN" }`
(the pattern the YouTube provider already uses), where the request is
indistinguishable from one the page itself makes. Bonus: in the MAIN world the
call goes through Instagram's own patched `window.fetch`, which adds its
anti-abuse headers (`x-ig-www-claim`, `x-asbd-id`) for free.

**Rule of thumb:** any provider doing a same-origin API fetch that a site
bot-detects should inject in the MAIN world, not the isolated world. Twitter
and Facebook still use the isolated world; if either starts 572-ing, this is
the first thing to try.

## HTTP 572 layer 2 — the volume throttle (mitigated)

Distinct from the world issue: a large initial backfill trips Instagram's
request-*volume* throttle after roughly 8 pages. When throttled it answers 572
**or stalls the connection** (a request hung for 20s+ in testing) for up to
about a minute, then clears — verified live: a single request was already 200
again moments after the extension hit 572.

So 572/429/5xx and timeouts are **transient**, and the provider treats them as
"slow down", not "give up":

- **15s request timeout** in the injected fetch (AbortController), so a stalled
  request becomes a retryable error instead of freezing the sync.
- **Retry the same page** with escalating backoff `[8s, 15s, 25s]` — kept
  under 30s so the MV3 service worker isn't suspended mid-wait.
- **Jittered pacing** between pages (`900ms + up to 500ms`) so a fixed cadence
  doesn't line up with Instagram's fixed-window rate limiter.

401/403 remain a hard `needsLogin`; a genuinely unexpected status still errors
out immediately. If all retries are exhausted the sync ends `partial` (landed
items kept) with a readable "throttling… wait a few minutes and Refresh"
message.

## Backfill resume — the checkpoint

A partial sync records no `syncedAt`, so by default the next Refresh restarts
from the top and re-walks the whole already-synced prefix (see
[sync-and-refresh.md](sync-and-refresh.md) → "What a Refresh does after a
partial sync"). For Instagram that prefix re-walk burns throttle budget before
reaching new items, so repeated Refreshes of a very large feed get slower each
time.

The checkpoint fixes that. The saved-feed walk persists its pagination cursor
in `env.cache` under `instagram:resumeMaxId`:

- On start, if a resume cursor is cached, the walk **begins from it** instead
  of the top — continuing the backfill where it stopped.
- After each successful page, the cursor for the *next* page is written to the
  cache, so a throttle-stop resumes exactly at the page that failed.
- When the walk reaches the end of the feed (`!hasNext` / empty page), the
  cache key is **cleared** — the backfill is complete, and subsequent syncs
  are normal top-of-feed incrementals.
- On any non-throttle error (e.g. a stale cursor Instagram rejects), the key
  is cleared so the next Refresh restarts cleanly from the top rather than
  wedging on a bad cursor.

Trade-off: while resuming, the walk starts deep in the feed and skips the
newest items above the resume point — so posts saved *since* the backfill
began stay invisible until the backfill completes and the next incremental
sync picks them up from the top. For the backfill's purpose (completing the
archive efficiently) that's the right call; in steady state there is no resume
cursor and refreshes behave normally.

Caveat: the provider can't tell a ⟳ Full sync from an incremental one
(`FetchContext` carries no `full` flag), so while a checkpoint is set even
Full resumes from it instead of re-walking from the top. This only applies
during an incomplete backfill — once the key clears, Full works normally.

`env.cache` is the same raw-`chrome.storage.local` surface Facebook uses for
its `doc_id` — deliberately not `Prefs`, because it's self-repair/plumbing
state, not a user preference.

## If it breaks again

Verify against the live site before coding against remembered shapes:

- Open instagram.com/<you>/saved/all-posts/, watch DevTools → Network.
- If `feed/saved` requests are gone, the web app moved endpoints (it currently
  also loads some saved content via `POST /api/graphql`) — capture the new
  shape.
- Reproduce the extension's exact request in the page console (MAIN world) to
  separate "endpoint/headers changed" (would fail in-page too) from
  "world/throttle" (passes in-page).
