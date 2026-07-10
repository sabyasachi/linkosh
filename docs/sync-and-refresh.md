# Sync, refresh & backfill semantics

How a Refresh actually walks a service, when it stops, and what happens when
it fails partway. Applies to every provider; provider-specific quirks (e.g.
Instagram's throttle-resume checkpoint) build on this. Core:
[src/core/sync.ts](../src/core/sync.ts).

## The onPage inversion

Providers own only fetching/auth/pagination — never parsing. `fetchItems`
does not return items; it hands each raw page to `onPage(account, rawPage)`,
which the sync layer supplies. `onPage` parses the page once (through the
shared registry), persists it (upsert in normal mode, `raw_data` archive in
capture mode), and returns a typed `PageOutcome` back to the provider:

```
{ items, cursor, hasNext, unseen, ...aux }
```

The provider uses `cursor`/`hasNext` to page and `unseen` to know when to
stop. Parsing happens exactly once, in one place, whether a page was just
fetched or replayed from the archive.

## The incremental stop rule

Services list saved items **newest-first**, so a refresh only needs to fetch
until it reaches items it already has. The mechanics:

- Before the walk, the sync layer computes `knownIds` — the external ids
  already stored — and passes it to the provider via `onPage`'s accounting.
- For each page, `onPage` counts `unseen` = items not in `knownIds`.
- The provider stops when a page reports `unseen === 0` (everything below is
  already stored) or `!hasNext` (end of feed).

So a typical incremental refresh is 1–2 requests.

### Only items from the last *successful* sync count as known

`knownIds` is populated **only when** `!full && lastGoodSync`, where
`lastGoodSync` is the `syncedAt` recorded by the previous **ok** sync. This is
a deliberate safety rule: a partial sync leaves the newest pages saved, and if
those counted as "known", the next refresh would stop at the first page and
skip the gap underneath them. (In capture mode the `raw_data` archive is a
second source of "known" — pages already fetched must not be re-fetched even
if their items aren't ingested yet.)

A **full sync** (⟳ Full) passes an empty `knownIds` and re-walks everything —
used to refresh stale titles/snippets/thumbnails. Unsaved items are never
deleted: the DB is an archive, not a mirror.

## SyncReport: a closed union, never thrown

`syncProvider` never throws for a provider failure. It always returns a
`SyncReport` discriminated on `status`, with common counts
(`inserted`/`updated`/`captured`/`total`):

| status | meaning | records `syncedAt`? |
|---|---|---|
| `ok` | completed | **yes** → next incremental watermark |
| `partial` | some pages landed, then a fetch failed | no |
| `failed` | nothing landed | no |

`partial`/`failed` also carry `error` and `needsLogin`. `syncAllProviders`
runs each provider in turn (one failing never aborts the rest) and returns the
per-provider reports; the UI derives any joined error string itself. Only a
*programmer* error (unknown provider id) throws.

## What a Refresh does after a partial sync

This is subtle and worth stating plainly, because it is **not** "resume from
the page that errored". It describes the **default** sync-layer behavior — a
provider that keeps its own resume checkpoint (currently Instagram) overrides
it; see the mitigations below.

Because a partial sync does **not** record `syncedAt`, the next Refresh sees
no successful watermark, so `knownIds` is empty and the provider re-walks from
the **top** (the newest items). With an empty `knownIds`, `unseen` is never 0
for a non-empty page, so the walk does not stop early — it pages from the
newest items straight down through everything already saved (re-fetched and
re-upserted as "updated", cheap on the DB but real network requests) and
continues into the older, not-yet-fetched region, until it reaches the end or
fails again.

Consequences:

- **Progress is monotonic** — each run gets further, and the first run that
  reaches the end cleanly records `syncedAt`, after which every Refresh is
  truly incremental (1–2 pages).
- **But re-walking the known prefix wastes request budget.** For services that
  throttle on request *volume* (Instagram), later Refreshes spend more of
  their budget grinding back through known pages before reaching new territory
  — so a very large first backfill gets slower per Refresh.

The mitigations live at the provider layer:

1. **Retry through transient failures within a run** so a single Refresh
   completes more of the backfill (see Instagram's backoff).
2. **A resume checkpoint** for volume-throttled providers: as the walk pages,
   it checkpoints the cursor of the next page in `env.cache`, so a partial
   stop leaves the next un-fetched page's cursor cached; the following Refresh
   resumes from it instead of restarting at the top, and the key is cleared
   once the backfill reaches the end. This trades "re-walk everything" for
   "continue where it left off", at the cost of temporarily deferring
   brand-new saves (which sit above the resume point) until the backfill
   completes and a normal incremental sync picks them up. Implemented for
   Instagram — see [instagram-provider.md](instagram-provider.md).

   Caveat: a provider learns nothing about `full` from `FetchContext`, so
   while a checkpoint is set even a ⟳ Full sync resumes from it rather than
   re-walking from the top. That only matters during an incomplete backfill
   (a checkpoint exists only then); once it clears, Full behaves normally. If
   Full-during-backfill ever needs to force a top re-walk, thread a `full`
   flag through `FetchContext` so the provider can drop the checkpoint.

## Test mode (the `maxItems` cap)

A soft cap for smoke-testing a provider without a full fetch: once ~`maxItems`
items have landed, `onPage` reports the page as fully known (`unseen = 0`),
reusing the same stop signal — no provider changes needed. Providers that walk
several lists (HN stories+comments, YT playlists) fetch one page per remaining
list before stopping, so expect a little more than `maxItems`.
