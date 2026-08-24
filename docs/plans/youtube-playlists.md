# YouTube: saved playlists as items

Status: implemented (2026-08-24), **pending live verification** — see "What was not verified".

## Diagnosis — yes, only videos are picked up

Confirmed in the code, not guessed:

- The YouTube provider fetches the playlists feed (`browseId: FEplaylist_aggregation`) **only to
  build an id → title map** of playlists to walk
  ([youtube.ts:61](../../src/ext/providers/youtube.ts#L61)).
- Those pages go through `onPage` with `kind: "playlists"`, and the parser's playlists branch
  returns **`items: []`** by construction — `parsePage` is literally
  `if (kind === "playlists") return { items: [], ...parsePlaylists(json) }`
  ([youtube.ts:284](../../src/core/parse/youtube.ts#L284)).
- The only rows YouTube ever writes come from `parseVideos`, i.e. `playlistVideoRenderer` rows,
  with `kind: "video" | "short"` ([youtube.ts:217](../../src/core/parse/youtube.ts#L217)).

So a playlist is a *label* (the `collection` facet), never a row. "Database Internals" cannot
appear in the list today, by design — nothing else is wrong.

What *should* already work: a playlist saved from someone else appears in `/feed/playlists`, so its
id lands in the map and **its videos get ingested**, tagged `collection: ["Database Internals"]`.
Verify that before implementing anything (DB worker console, see CLAUDE.md → Debug consoles):

```
__sql("SELECT collection, COUNT(*) FROM saved_items WHERE provider='youtube' GROUP BY 1 ORDER BY 2 DESC")
```

Two outcomes, both worth knowing:

- **The collection is present** → the feed lists saved-from-others playlists; this plan is purely
  additive (surface the container).
- **The collection is absent** → `FEplaylist_aggregation` doesn't enumerate them (or its
  new-UI dialect isn't parsed), and step 0 below has to find the real source before anything else.

## Second, independent bug: the playlists feed never paginates

`listPlaylists` loops up to `MAX_PLAYLIST_LIST_PAGES` on `res.hasNext`, but the playlists branch
computes `hasNext` from `nextContinuation()` — which is deliberately scoped to *video* lists
(`playlistVideoListRenderer`, and continuation batches containing `playlistVideoRenderer` rows,
[youtube.ts:131](../../src/core/parse/youtube.ts#L131)). A playlists-feed page contains neither, so
`cursor` is always `null` and **only the first feed page's playlists are ever discovered** — any
playlist past it is invisible along with all of its videos. Fix this in the same change; it is a
plausible second cause of a missing playlist.

## Outcome

A saved playlist becomes a first-class row in the library: title, channel/owner, cover thumbnail,
video count, `kind:playlist` as an FTS facet, opening `https://www.youtube.com/playlist?list=<id>`.
It sits in the one list next to videos, and shares a `collection` label with the videos inside it,
so `collection:"database internals"` returns the playlist *and* its contents.

## Design decisions

- **Source the playlist row from the playlist's own first page, not the feed lockup.** The
  `VL<playlistId>` browse response's header (`playlistHeaderRenderer` on the old dialect, the
  page-header view-model on the new one) carries title, owner, description, video/view counts and a
  cover thumbnail; the feed lockup carries a title and little else, and its shape is the one
  currently drifting between UI experiments. The provider already walks every playlist, so this
  costs zero extra requests: emit the item from `page 0` of each `VL` walk (continuation pages have
  no header — that's the natural guard against re-emitting).
- **Fall back to the context we already have.** If the header can't be parsed, synthesize the row
  from `context.{playlistId, collection}` (id + title are known for certain). A drifted header
  should degrade to a thin row, never to a missing playlist — the failure mode we're fixing.
- **`externalId` is `playlist:<playlistId>`, prefixed.** Video ids are 11 chars and playlist ids are
  longer, so a raw id would almost certainly not collide — but `UNIQUE (provider, account,
  external_id)` is the identity key and changing it later would duplicate every row instead of
  updating it. Choose the unambiguous form once, now.
- **`kind: "playlist"`** — free FTS facet (`kind:playlist`), and the hook the UI needs.
- **`collection: [<playlist title>]`**, same label its videos carry. This is what makes the
  container and its contents filter together, and it's why the row is worth having at all.
- **Emit for every playlist except Watch Later** — not just foreign ones. Ownership detection
  (header owner vs. the signed-in handle) is drift-prone, and gating emission on it means a header
  shape change silently removes rows again. Instead ownership only *fills* `posterName` (the owning
  channel), which is empty for your own playlists — visible, honest, and non-load-bearing. Watch
  Later is a system bucket, not a saved playlist, and is excluded explicitly (`WL`, alongside the
  `LL` exclusion that already exists).
- **Keep ingesting the videos inside foreign playlists** (current behavior). Arguably you saved the
  playlist, not its 60 videos — but those rows are already in users' databases, they are searchable
  content, and the `collection` label ties them to the new container row. Suppressing them would be
  a destructive change to existing libraries and belongs in its own decision, not this one.
- **`stats`**: `{videos: "24 videos", views: "…", age: "Updated …"}`, values verbatim (the YouTube
  convention already used for `{views, age}`). `formatStats` renders only recognized keys value-only,
  so add `"videos"` to its key order ([format.ts:32](../../src/core/format.ts#L32)) — otherwise it
  renders `videos: 24 videos`.
- **No `duration`, no dates.** A playlist total isn't exposed on the header; `bookmarkedAt` isn't
  either, and "Updated 2 days ago" is an update time, not a publish time — leave `publishedAt` null
  rather than laundering it through `estimatePublishedAt`. Ordering comes from `sort_key` as usual.
- **No `ROWTEXT_VERSION` bump.** Playlist rows are new, so they embed with the current recipe
  (title + description + collection label) on first sync. The label duplicating the title is mild
  redundancy, not worth re-embedding the whole corpus over.

## UX: how playlists sit next to videos

One list, one row shape — no separate section, no grouping mode. **The playlist is an ordinary row
and clicks like a video row**: `ItemRow` already wraps thumbnail + text in `<a href={item.url}>`
([app.tsx:246](../../src/pages/popup/app.tsx#L246)), so setting `url` to
`https://www.youtube.com/playlist?list=<id>` on the parsed item is the whole of it — clicking the row
opens the playlist on YouTube in a new tab. Star, "≈ more like this" and delete work on it unchanged,
because nothing about the row is special-cased. Three small changes finish the presentation:

0. **The playlist name leads the row.** Rows with both a poster and a title normally put the poster
   first (you scan for the channel, then pick a video under it); a playlist inverts that, because its
   own name *is* its identity and the owning channel is context. `ItemRow` gets a `titlePoster` case
   for `kind === "playlist"`, and a `.title-poster-item .poster` rule mirroring the existing
   `.poster-title-item .title` one so the second line is the lighter of the two either way.
1. **Meta line says what it is.** `metaParts` currently labels only `"short"`
   ([format.ts:139](../../src/core/format.ts#L139)); add `"playlist"` → `"Playlist"`. A row then
   reads: `YouTube · Playlist · 24 videos · Database Internals`.
2. **Drop a collection label that equals the title** in `metaParts`, so the playlist row doesn't
   read `Database Internals … · Database Internals`. General, one line, helps every provider.
3. **Cover thumbnail** comes from the header, so the row is visually distinct from a bare video
   without any new component. `Thumbnail`'s placeholder path already handles a missing image.

Filtering is what the user actually needs and it's free: `kind:playlist` lists every saved playlist,
`collection:"database internals"` lists the playlist plus its videos. Worth adding both to the
search box's `title` hint ([app.tsx:956](../../src/pages/popup/app.tsx#L956)).

The collection *label* stays plain text — it is not a link and does not become one. `collection` is a
JSON array of names ([schema.ts:20](../../src/core/db/schema.ts#L20)) with no id or URL attached, and
the playlist row already provides the click-out. Typing the facet in the search box remains the way
to filter.

Deliberately *not* doing: a separate "Playlists" tab, collapsible parent/child rows, or hiding
member videos behind their playlist. All three fight the single flat archive the app is built
around, and none is needed to make the playlist findable.

## What was not verified

Step 0 below (live capture) **was not run** — it needs a signed-in browser session, which the
implementation session did not have. The code was written against the two header dialects this
parser already handles, and everything that could compensate for that was built in:

- A header that drifts out of recognition still produces a row from `context` alone (id + title),
  covered by a test. The failure mode is a thin row, never a missing playlist.
- Field paths degrade independently: an unparsed owner, cover or count leaves that field empty
  rather than throwing.
- The new-dialect metadata classifiers work on localized display text and are best-effort by
  design — an unrecognized string is dropped, never filed under a wrong key.

Still worth running the capture to confirm the exact field paths (and to replace the two hand-built
header fixtures with scrubbed real ones). The one thing the fallbacks cannot compensate for is the
diagnostic question at the top: whether `FEplaylist_aggregation` enumerates playlists saved from
other people at all. If it does not, no row will appear regardless of this change, and the aux-page
work in step 0.4 is still needed.

One finding from implementation worth keeping: `deepFind` does **not** descend into a subtree once
its key matches, so the first draft of `feedContinuation` (a generic scan for `contents`/`items`
arrays) matched the outermost wrapper and never reached the grid. It now looks up the grid renderers
by name.

## Step 0 — live capture before writing code (per CLAUDE.md)

Remembered InnerTube shapes are stale; the header dialect is exactly the kind of thing that has
already drifted twice in this parser. Capture first:

1. Options → Developer → **Capture mode**, sync YouTube, **Export** the DB.
2. `node src/node/tools/capture-fixtures.ts <copy.sqlite>` → scrub → commit as fixtures.
3. From the captured pages answer: does the feed page list the saved-from-others playlist (both
   `gridPlaylistRenderer` and `lockupViewModel` dialects)? What is the feed's own continuation
   shape? What header renderer does a `VL` page 0 carry, and which fields hold owner, description,
   video count and cover?
4. If the feed does **not** list saved playlists, capture `/feed/library` (`FElibrary`) or the
   playlists feed's "Saved" chip in DevTools → Network and add it as a second aux page (a new
   `PageKind`, following the `learning` precedent in
   [linkedin-learning.md](linkedin-learning.md)) before proceeding.

## Implementation steps

As built (all landed): 1–5 below, plus a playlist page in the ux-harness fixture seed
([ux-server.ts](../../src/node/tools/ux-server.ts)) so the row is visible in `npm run ux`. Emission
is suppressed for system buckets by *id* (`WL`/`LL`) rather than by a context flag from the
provider, so re-ingesting an already-archived capture reaches the same verdict — which left the
provider needing no code change at all, only a comment.

1. **core/parse/youtube.ts** — `parsePlaylistHeader(json, ctx)` returning a `ParsedItem` (or null),
   plus a `feedContinuation(json)` for grid/rich-grid continuation tokens, kept *separate* from
   `nextContinuation` and commented with why (the scoping in `nextContinuation` is load-bearing
   anti-recommendation logic — do not widen it). `parsePage`: the `"items"` branch prepends the
   playlist item when `context.page === 0`-equivalent (header present); the `"playlists"` branch
   uses `feedContinuation`.
2. **ext/providers/youtube.ts** — skip header emission for `WL` (pass a flag through `context`, e.g.
   `{playlistId, collection, isSystem: true}`, so the parser stays pure and the raw archive stays
   independently re-parseable). Update the file header comment with capture dates.
3. **core/format.ts** — `"videos"` in the recognized stats keys; `"playlist"` → `"Playlist"` label;
   drop collection labels equal to the title.
4. **pages/popup/app.tsx** — extend the search-box hint with `kind:playlist`.
5. **README** — YouTube row: "…and the playlists themselves"; note that a saved playlist appears
   both as its own row and as a collection over its videos.

No schema, DB, ingest or background changes: `kind` is free-form TEXT, ingest re-dispatches through
the parse registry, and the UI derives everything from stored rows.

## Tests

- **Fixtures**: a `VL` page 0 with a real header (scrubbed capture) in both header dialects if both
  are observed; a header-less continuation page; a feed page with a continuation token.
- **Parser** ([parsers.test.ts](../../tests/parsers.test.ts)): page 0 yields the playlist item
  *plus* its videos, with prefixed `externalId`, `kind: "playlist"`, `collection: [title]`, cover
  and `stats.videos`; a continuation page yields **no** playlist item (no duplicate rows); a
  header-shape change degrades to the context-synthesized thin row rather than throwing; the
  recommendation/shelf exclusions still hold (the existing regression fixtures must not budge);
  `feedContinuation` finds the feed's token while `nextContinuation` still returns null for it.
- **Provider** ([providers.test.ts](../../tests/providers.test.ts)) — there is **no YouTube
  scenario there today**; add one against the scripted `ProviderEnv`: the feed paginates past page 0
  (regression for the second bug), `WL` walks incrementally and emits no playlist row, a non-WL
  playlist walks fully and emits exactly one.
- **Format** ([format.test.ts](../../tests/format.test.ts)): `Playlist` label, `videos` rendered
  value-only, title-equal collection suppressed, existing meta lines unchanged.
- **Sync** ([sync.test.ts](../../tests/sync.test.ts)): a page mixing a playlist item and videos
  upserts both; the playlist row counts toward `unseen` once and never resurrects.

## Live smoke checklist

`npm run build` → reload unpacked (`dist/src`) → YouTube sync → the saved playlist appears as a row
with cover + "Playlist · N videos" → `kind:playlist` and `collection:"…"` both return it → second
sync inserts 0 (no duplicate from the `playlist:` prefix, no re-emission from continuation pages) →
a semantic search and one "≈ more like this" on a playlist row → capture-mode sync →
`__sql("SELECT kind, status FROM raw_data WHERE provider='youtube'")` → Ingest raw → Clear raw.

## Open questions

- **Own playlists as rows**: this plan emits them (minus Watch Later). If they read as noise once
  live, the cheap retreat is filling `posterName` only for foreign playlists and hiding own ones —
  but that reintroduces ownership as a load-bearing signal, so prefer living with the rows first.
- **Foreign playlist contents**: should saving a 200-video playlist really add 200 rows? Out of
  scope here; if it becomes a complaint, the lever is skipping the video walk for non-owned
  playlists — which also cuts the per-sync request cost, since non-WL playlists are fully re-walked
  every run ([README](../../README.md) "YouTube playlists other than Watch Later…").
- ~~**Playlist description length**~~: resolved — the list CSS line-clamps `.summary` to 4 lines and
  `rowText` caps embedding input at 1000 chars, so the description is stored whole.
