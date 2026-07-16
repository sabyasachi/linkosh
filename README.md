# Linkosh

Linkosh is a Chrome extension that fetches your saved items from LinkedIn, Instagram,
YouTube, Hacker News, X (Twitter), Facebook and Substack and lists them in
the extension popup. Built to grow: more services can be added as additional
providers later.

## Install (developer mode)

1. `npm install && npm run build` (TypeScript compiles 1:1 into `dist/` —
   no bundler; see CLAUDE.md for the toolchain).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`dist/src`** folder.
5. Make sure you are logged in to [linkedin.com](https://www.linkedin.com),
   [instagram.com](https://www.instagram.com),
   [youtube.com](https://www.youtube.com),
   [news.ycombinator.com](https://news.ycombinator.com),
   [x.com](https://x.com), [facebook.com](https://www.facebook.com) and/or
   [substack.com](https://substack.com) in the same browser profile.
6. Click the extension icon, pick the service in the dropdown, and press
   **Sync**.

## How it works

- The extension calls each service's internal web API — the same API its own
  website uses — reusing your existing browser session. No credentials are
  stored; only CSRF tokens are read from cookies.
  - **LinkedIn**: the **Voyager API** behind the *My items → Saved posts*
    page (CSRF token from the `JSESSIONID` cookie).
  - **Instagram**: the `feed/saved/posts` API behind the *Saved → All posts*
    page (CSRF token from the `csrftoken` cookie). Instagram rejects these
    calls when they come from the extension itself (HTTP 572 bot detection),
    so they are executed inside an instagram.com tab via `chrome.scripting` —
    an existing tab if one is open, otherwise a background tab that is closed
    when the sync finishes. The sync walks the all-posts saved feed; each
    item's `saved_collection_ids` is resolved to collection names via one
    `collections/list` call (a post in several collections keeps one row
    with those names stored as a JSON array), and `published_at` holds the
    post's publish time (`taken_at`) — save time isn't exposed.
  - **YouTube**: the **InnerTube API** (`youtubei/v1/browse`) behind the
    website. YouTube has no single "saved" feed — saving a video or Short
    files it into a playlist (Watch Later by default) — so a sync enumerates
    your playlists plus Watch Later and walks each one, merging multiple
    playlist names into one video row. Playlist pages expose only relative
    publish age text, so `published_at` is an approximate publish date derived
    from that age and the page fetch time. Requests need auth material only a
    youtube.com page has (`SAPISIDHASH`, `ytcfg`), so like Instagram they run
    inside a youtube.com tab. Liked videos are not treated as saved.
  - **X (Twitter)**: the **GraphQL `Bookmarks` endpoint** behind
    x.com/i/bookmarks (CSRF token from the `ct0` cookie, plus the public
    bearer token baked into X's web app). Like Instagram, requests run inside
    an x.com tab via `chrome.scripting`. X's GraphQL requires a map of client
    feature flags that drifts with web-app deployments; the provider ships a
    baseline and self-repairs by parsing the server's "features cannot be
    null"/"unknown features" errors and retrying. `published_at` holds the
    post's publish time — bookmark time isn't exposed. `kind` is
    `tweet`/`photo`/`video`/`gif`.
  - **Facebook**: the **Comet GraphQL API** behind facebook.com/saved
    (request token `fb_dtsg` scraped from the page, user id from the `c_user`
    cookie). The first page of items is server-rendered into the document as
    embedded Relay JSON — but only for real navigations, so the provider
    works in a tab actually showing `/saved/` (an existing one if open, else
    a background tab) and reads the data out of its DOM. Later pages use
    Facebook's *persisted queries*, where requests send only a numeric
    `doc_id` that rotates with web-app deployments — the provider discovers
    the current id for `CometSaveDashboardAllItemsPaginationQuery` by
    scanning the page's own JS bundles for its `_facebookRelayOperation`
    module and caches it until it stops working. Save time isn't exposed
    (`bookmarked_at` is NULL) and the account is the numeric user id. `kind` is
    `post`/`video`/`photo`/…; `collection` holds the user's collection
    names.
  - **Substack**: the **reader API** behind substack.com/saved
    (`/api/v1/reader/saved?filter=all`, cursor-paginated). Plain
    session-cookie auth, so requests go straight from the extension like
    LinkedIn and Hacker News. Saved items cover both posts and Substack
    notes; `kind` is the post type (`newsletter`/`podcast`/…) or `note`.
    `bookmarked_at` uses the item's save time when the API exposes it;
    `published_at` holds the post/comment publish date.
  - **Hacker News**: upvoted items are not exposed by HN's official
    (Firebase) API — they only appear on the private `/upvoted` page — so the
    provider fetches that page (and its `&comments=t` twin for upvoted
    comments) with your session cookie and scrapes the HTML. Parsing is
    regex-based (MV3 service workers have no `DOMParser`); HN's markup has
    been stable for many years. `kind` is `story` or `comment`.
- Items are stored in a real **SQLite database** (SQLite compiled to WASM,
  vendored in [src/vendor/](src/vendor/)) whose file lives in the browser's Origin
  Private File System — it persists across browser restarts. Schema: one
  `saved_items` table (`provider`, `account`, `external_id`, `url`, `title`,
  `publication`, `summary`, `image`, `bookmarked_at`, `published_at`,
  `created_at`, plus `kind` — e.g. `short`/`video`/`reel` — `duration` in
  seconds, `collection` as JSON array text, `poster_name`/`poster_handle` for
  the author of the saved content, and `stats` as JSON)
  and an **FTS5** full-text index that powers the popup's search box. A
  second table, `raw_data`, archives raw API responses — but only while the
  developer-only capture mode is on (see Development below).
- The search box accepts **FTS5 query syntax**: plain words are matched with
  the last word as a prefix, but queries containing operators are passed
  through raw, so `kind:short`, `collection:"watch later" pasta`,
  `poster_name:"jane doe"`, `poster_handle:jane`, `cats AND NOT dogs` all work
  (`title`, `publication`, `summary`, `collection`, `kind`, `poster_name` and
  `poster_handle` are the indexed columns). A
  query that fails to parse falls back to a plain substring scan.
- Search also understands **meaning**, not just keywords: every item gets a
  vector embedding computed **on-device** (quantized `bge-small-en-v1.5` via
  [transformers.js](https://github.com/huggingface/transformers.js), running
  in a dedicated worker — the model downloads once from huggingface.co
  (~34 MB) and is cached for offline use). The selector next to the search
  box picks the mode: **Text** (default; exactly the FTS5 behavior above),
  **Hybrid** (text and semantic rankings fused) or **Semantic** (pure
  similarity). Queries using FTS5 operators always run as text search. Each
  row's **≈** button lists the most similar saved items ("more like this").
  The extension's options page can switch embeddings to a cloud API (OpenAI /
  Gemini / Voyage) via an API key for higher quality; by default nothing
  leaves the machine.
- Syncs are **incremental**: the services list saved items newest-first,
  so syncing stops as soon as it reaches a page it has already stored — a
  typical refresh is 1–2 requests. (Exception: YouTube playlists other than
  Watch Later can be manually reordered, so they are re-walked fully each
  sync — still cheap at ~100 videos per request.) **Options → Developer → Full
  sync** re-walks everything (use occasionally to refresh stale
  titles/snippets/thumbnails). Items you
  unsave on the service are kept in the DB — it's an archive, not a mirror.
- Syncs are saved **page by page**: each fetched page is written to the DB
  before the next request, the popup live-updates while a sync runs, and if
  a sync fails partway (rate limit, dropped session) everything fetched so
  far is kept — the next sync resumes from the top and stops at known
  items as usual.
- Because MV3 service workers can't spawn workers or use the synchronous
  OPFS handles SQLite needs, the DB runs in a dedicated worker
  ([src/workers/db.worker.ts](src/workers/db.worker.ts)) hosted by an
  offscreen document ([src/pages/offscreen.ts](src/pages/offscreen.ts)); the
  background worker talks to it over a typed RPC protocol
  ([src/core/rpc/](src/core/rpc/)).
- Clicking an item opens it on the original service in a new tab.

## Caveats

- All of these APIs are **unofficial and undocumented**. LinkedIn rotates its GraphQL
  `queryId` versions occasionally; the provider tries the known ones in
  [src/ext/providers/linkedin.ts](src/ext/providers/linkedin.ts) but may eventually need
  updating. To find the current id, open the saved-posts page, scroll, and
  look for the `voyagerSearchDashClusters` request in DevTools → Network.
  If the Instagram endpoint drifts, watch for `feed/saved` requests on the
  saved-posts page instead; for YouTube, watch for `youtubei/v1/browse`
  requests on the playlists page; for X, watch for `graphql/<queryId>/Bookmarks`
  requests on the bookmarks page (queryIds live in
  [src/ext/providers/twitter.ts](src/ext/providers/twitter.ts)). Facebook's pagination
  `doc_id` is discovered automatically; if that breaks, look for
  `CometSaveDashboardAllItemsPaginationQuery` requests to `/api/graphql/` on
  the saved page and update the query name in
  [src/ext/providers/facebook.ts](src/ext/providers/facebook.ts). If Substack drifts, watch
  for `reader/saved` requests on substack.com/saved.
- `bookmarked_at` is the actual save/bookmark time when a provider exposes
  it; `published_at` is the content publish time or a provider-specific
  estimate. The list sorts by `bookmarked_at`, then `published_at`, then local
  `created_at`.
- YouTube Shorts are detected from the thumbnail's `SHORTS` badge (or a
  `/shorts/` link) in the playlist data; a Short saved before YouTube added
  that badge may be classified as a plain video.
- Instagram thumbnail URLs are **signed CDN links that expire** after a
  while, so thumbnails of old items may stop loading. Run **Options →
  Developer → Full sync** to refresh them (the post links themselves never
  expire).
- Cloud embedding API keys entered on the options page are stored in
  `chrome.storage.local`, which is **plaintext on the local disk** —
  acceptable for a personal machine, but don't use a key you can't revoke.
  Semantic search silently falls back to text search until the local model's
  first download finishes (needs network once) or while a provider switch is
  re-embedding the corpus; the options page shows the backlog.
- Heavy refreshing could in theory trip rate limits; the extension waits
  400 ms (LinkedIn, YouTube, Substack) / 500 ms (Hacker News, X) / 600 ms
  (Instagram) / 700 ms (Facebook) between pages and caps at 100 pages per
  sync (per playlist for YouTube). If a service returns HTTP 429, wait a few
  minutes and try again.

## Development & testing

- `npm test` typechecks every project (`tsc -b`) and runs the Node test
  suite — `node --test` executes the `.ts` sources directly (Node ≥ 23.6
  type stripping) against the same vendored SQLite WASM build and the same
  parse/ingest/sync/RPC modules the extension runs. Provider pagination and
  self-repair are covered against a scripted fake environment; only live
  fetching and the chrome plumbing itself need a real browser.
- `npm run ux` serves the real popup UI (built assets + the extension's own
  background service over HTTP) from a fixture-seeded database at
  `http://127.0.0.1:5173/` — handy for UI work without loading the extension.
- **Capture mode** (Options → Developer) changes what a sync does: instead
  of writing items, every raw response page is archived verbatim into the
  `raw_data` table and the item list is left untouched. Options → Developer
  provides **Ingest raw** (replay the archive through the parsing pipeline
  into `saved_items`) and **Clear raw** (drop the archive). This is
  how you iterate on the parsing/embedding pipeline without re-fetching from
  the services: capture once, **Export database** from Options → Developer,
  then re-run the pipeline on the copy offline with
  `node src/node/tools/ingest.ts linkosh.sqlite [--reingest]`.
  `node src/node/tools/capture-fixtures.ts <db.sqlite>` turns captured pages
  into parser regression fixtures (review and scrub before committing —
  bodies are verbatim).

## Adding a new service

1. Create `src/core/parse/<service>.ts` — a pure parser exporting
   `parsePage({ kind, body, context })` → `{ items, cursor, hasNext }` —
   and register it in [src/core/parse/index.ts](src/core/parse/index.ts)
   (plus the new id in `ProviderId`, [src/core/types.ts](src/core/types.ts)).
2. Create `src/ext/providers/<service>.ts` exporting
   `createProvider(env: ProviderEnv)` — fetching/auth/pagination only; it
   hands raw pages to `onPage` and gets the parse result back (contract in
   [src/core/types.ts](src/core/types.ts), env port in
   [src/ext/providers/env.ts](src/ext/providers/env.ts)).
3. Register it in the `PROVIDERS` wiring in
   [src/ext/background.ts](src/ext/background.ts).
4. Add the service's origin to `host_permissions` in
   [src/manifest.json](src/manifest.json).
5. Add fixture pages + a parser test under [tests/](tests/).

The popup picks up new providers automatically via its service dropdown.
