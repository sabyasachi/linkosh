# Detailed sync progress on the home page

Status: proposed (not implemented).

## Outcome

While a sync is running, the popup and full-page home view should say which service is active,
where that service sits in an “All services” run, and what the sync most recently accomplished.
The display must keep moving even when no new items are found, survive closing and reopening the
popup, and distinguish a slow request from a UI that has stopped receiving updates.

The implementation should reuse the existing sync path rather than add progress logic to all seven
providers. Every provider already awaits `onPage` after each response, and `syncAllProviders` walks
providers sequentially. Those two choke points are sufficient for service- and page-level progress.

## Current behavior and problem

- [app.tsx](../../src/pages/popup/app.tsx) changes the button from **Sync** to **Stop** and refreshes
  the visible item list every 800 ms.
- Its only in-progress copy is `Syncing… N items in database so far`. That number is the entire
  stored database, not work completed in this run, so it often does not change.
- [background-service.ts](../../src/ext/background-service.ts) exposes only the run scope,
  `startedAt`, and whether stopping was requested. A popup reopened during a sync can reattach, but
  cannot identify the active provider or recent activity.
- [sync.ts](../../src/core/sync.ts) already knows when a provider begins, when each page has been
  parsed and persisted, and how each provider finishes; that state is currently discarded until
  the final `SyncReport` is returned.

## UX specification

### Placement

Add a dedicated progress banner directly below the sticky header and above filtered-view banners,
search, and the item list. It is close to the control that started the work, remains visible while
the list refreshes, and does not compete with search-result or saved-item status copy.

The banner is present only while a sync is running. On completion it disappears and the existing
`#status` line reports the final outcome. Keep the existing header **Stop** button as the single stop
control; do not duplicate it inside the narrow popup banner.

### Information hierarchy

For an “All services” run:

```text
◌ Syncing YouTube                                      3 of 7
Fetched playlists page 4 · 18 new · active 2s ago
LinkedIn and Instagram complete
```

For a single-service run:

```text
◌ Syncing YouTube
Fetched saved items page 4 · 18 new · active 2s ago
```

Before the first page arrives:

```text
◌ Connecting to YouTube                               3 of 7
Started 4s ago
```

Capture mode replaces item counts with pages archived:

```text
◌ Syncing Instagram                                   2 of 7
Captured collections page 1 · 3 pages archived · active now
```

If a provider fails and the all-services run continues, retain a concise issue line while showing
the next active provider:

```text
◌ Syncing Facebook                                    6 of 7
Waiting for the first page · active 3s ago
X needs login · continuing with remaining services
```

### Progress semantics

- Show `current provider index / provider count`, not a percentage of pages. Provider APIs do not
  reveal a reliable total page count, so page percentages or ETAs would be misleading.
- Add a slim track whose completed portion represents **finished providers only**. The current
  provider segment remains animated/indeterminate to communicate ongoing work without pretending
  its duration is known.
- Count `inserted` as “new”. Do not display the total database count as work completed in this run.
- A page with zero items still updates the page number and `lastActivityAt`; this proves the sync is
  walking rather than frozen.
- Use one-based page numbers in copy even though `RawPage.page` is zero-based.
- Translate `PageKind` to readable labels in the UI:
  - `items` → `saved items`
  - `stories` → `stories`
  - `comments` → `comments`
  - `collections` → `collections`
  - `playlists` → `playlists`
  - `connection` → `saved items`
- After 15 seconds without a page/start/finish event, change “active Ns ago” to “waiting Ns” while
  retaining neutral styling. After 60 seconds, add “Still waiting — Stop keeps fetched items.” This
  is a latency warning, not an error or a claim that the service is stuck.
- A stop request changes the heading to `Stopping after the current page…`; the header button stays
  disabled as it does today.

### Completion copy

Retain the existing final report behavior, with elapsed time added:

```text
All services: 31 new · 1,284 total · synced in 1m 42s
```

If some services failed, name them after the successful summary. If the user stopped the run, keep
the neutral `stopped` result and mention that already fetched items were retained. A surface that
only reattached to someone else’s run may not have the final report; it should remove the banner and
refresh the normal list status rather than manufacture a completion summary.

### Accessibility and motion

- Give the banner `role="status"` and `aria-live="polite"`; do not announce the every-second age
  tick. Update the live text only for provider, page, completion, failure, or stopping changes.
- The spinner/animated segment is supplementary. Provider name, ordinal, and last activity remain
  readable without color or motion.
- Respect `prefers-reduced-motion: reduce` by disabling the animation and leaving a static current
  segment.
- Preserve visible keyboard focus on the existing Stop button and ensure banner text meets the
  current light/dark muted-text contrast.

## Progress data contract

### Core events

Add JSON-safe progress event types near the existing sync types in
[types.ts](../../src/core/types.ts):

```ts
export type SyncProgressEvent =
  | {
      type: "provider-start";
      providerId: ProviderId;
      at: number;
    }
  | {
      type: "page-complete";
      providerId: ProviderId;
      at: number;
      kind: PageKind;
      page: number;
      inserted: number;
      updated: number;
      captured: number;
      processed: number;
    }
  | {
      type: "provider-complete";
      providerId: ProviderId;
      at: number;
      report: SyncReport;
    };
```

The page counters are cumulative for the current provider, not per-page deltas. `processed` counts
distinct parsed items kept during the run, including known items refreshed by an incremental sync.
This makes each status snapshot self-contained and avoids accumulating deltas in multiple UI
surfaces.

Extend `SyncOptions` with an in-process observer:

```ts
onProgress?: (event: SyncProgressEvent) => void;
```

This callback never crosses RPC; it connects the pure core sync to the chrome-free background
service in the same JavaScript container. Invoke it through a small `emitProgress` helper that
catches observer exceptions so presentation/telemetry code can never fail a sync.

Provider index/count do not belong in core events. The background already resolves the exact
ordered provider list before starting the run, and can derive the ordinal by provider id. This also
keeps a direct `syncProvider` reusable without inventing an all-provider context.

### Background status snapshot

Extend `SyncRunStatus` in [background-service.ts](../../src/ext/background-service.ts):

```ts
export interface RunningProviderProgress {
  providerId: ProviderId;
  index: number;       // one-based
  count: number;
  phase: "connecting" | "fetching";
  kind?: PageKind;
  page?: number;       // zero-based in the API; UI owns presentation
  inserted: number;
  updated: number;
  captured: number;
  processed: number;
  lastActivityAt: number;
}

export interface CompletedProviderProgress {
  providerId: ProviderId;
  status: SyncReport["status"];
  inserted: number;
  updated: number;
  captured: number;
  error?: string;
  needsLogin?: boolean;
}

export type SyncRunStatus =
  | { running: false }
  | {
      running: true;
      scope: ProviderId | "all";
      startedAt: number;
      stopping: boolean;
      active: RunningProviderProgress;
      completed: CompletedProviderProgress[];
    };
```

`completed` has at most seven entries, so returning it in each polling response is cheap and makes
reattached surfaces fully reconstructable. Do not include raw response data, account identifiers,
URLs, parser context, or error stacks.

The run object remains process-local. If Chrome terminates and restarts the service worker, status
returns idle as it does today; page-level DB commits and the untouched watermark continue to make
the next sync safe.

## Implementation plan

### 1. Emit progress from the pure sync layer

Update [types.ts](../../src/core/types.ts) and [sync.ts](../../src/core/sync.ts):

1. Add `SyncProgressEvent` and `SyncOptions.onProgress`.
2. In `syncProvider`, emit `provider-start` immediately before `provider.fetchItems` begins. Do this
   after the known-id/meta setup so “connecting” describes provider/network work rather than DB
   preparation.
3. In `onPage`, record cumulative `processed`, `inserted`, `updated`, and `captured`. Emit
   `page-complete` only after `rawStore`/`upsert` resolves; “fetched” therefore always means the page
   is safely persisted.
4. Refactor the stopped/error/success return branches to assign one `SyncReport`, emit
   `provider-complete` once, then return it. Emit completion after `setMeta` for a successful run.
5. In `syncAllProviders`, forward the same observer into each `syncProvider` call. Keep the current
   include order and stop-between-providers behavior unchanged.
6. Treat observer failures as non-fatal and add a contract comment explaining why.

No provider file or injected function changes are needed.

### 2. Make the background own a reconstructable snapshot

Update [background-service.ts](../../src/ext/background-service.ts):

1. Resolve the provider sequence before acquiring the run:
   - explicit provider sync: `[provider]`
   - all-services sync: the enabled-provider list already passed through `include`
2. Expand the single-flight `running` record with that sequence, an `active` snapshot, and completed
   rows. Initialize `active` to the first provider in `connecting` phase with zero counters.
3. Pass an observer closure to core through `SyncOptions.onProgress`:
   - `provider-start` resets the active provider/counters and updates `lastActivityAt`;
   - `page-complete` changes phase to `fetching` and copies the cumulative counters/page metadata;
   - `provider-complete` appends/replaces its completed row.
4. Guard every observer update with `if (running !== run) return`. `syncStop` deliberately releases
   the lock immediately, so a stopped zombie run must not overwrite a newer run’s progress.
5. Return fresh plain objects/arrays from `syncStatus`; do not leak mutable internal references.
6. Keep `syncStatus` read-only and cheap—no DB calls, provider probes, or preference reads.
7. Continue clearing the run in `finally` only when it is still the same run.

If no providers are enabled, preserve the current empty all-sync result and avoid constructing an
invalid active snapshot. `syncAll` can complete immediately without ever exposing `running: true`
to a poller.

### 3. Separate progress presentation from list status

Update [app.tsx](../../src/pages/popup/app.tsx):

1. Add `syncProgress: SyncRunStatus | null` state, restricted to the running variant.
2. Replace the list-only `startSyncPoll` with one coordinator that:
   - polls `api.syncStatus({})` every 800 ms regardless of the current list/search/similar view;
   - updates `syncProgress`, `syncing`, and `stopping` from the background snapshot;
   - retains the existing guarded `listItems` refresh only while the view owner is `list`;
   - stops both loops when the run becomes idle or the initiating RPC finishes.
3. Use the same coordinator for a locally started run and for `watchSync`, eliminating the two
   slightly different sources of truth.
4. Do not write progress text into the generic `status` state. Searches, similar-item views, deletes,
   and progress can then coexist without overwriting one another.
5. Keep an interval-local display clock for `active Ns ago`, but place the changing age in an
   `aria-hidden` visual span. Update an assistive-text sentence only on actual progress snapshots.
6. Render the banner immediately after `<header>` so popup, `page.html`, and the HTTP dev harness
   receive identical behavior from the shared tree.
7. Add a small formatter/helper in the same module for page-kind labels, elapsed time, and compact
   completed-provider grammar. Reuse `providerLabels` for all user-facing names.
8. When `stopping` is true, prioritize the stop copy over the active phase. When a completed report
   has `needsLogin`, say “needs login”; otherwise use its short error text.
9. Add elapsed time to the completion outcome available to `doSync`, using the start time captured
   when the click begins or reported by `syncStatus`.

Avoid putting provider progress into the item-list polling result. A sync can be processing one
provider while the dropdown shows another, and searches intentionally suppress live list writes;
the background snapshot is the authoritative run state in every case.

### 4. Style the shared banner

Update [popup.css](../../src/pages/popup/popup.css) and, only where necessary,
[page.css](../../src/pages/popup/page.css):

- `.sync-progress` uses the existing border, hover-surface, accent, foreground, and muted tokens.
- Popup margins align with the current 12 px search/status inset; full-page margins align with its
  16 px content inset.
- The first row holds the heading and ordinal. The detail/completed lines may wrap rather than
  truncate provider names or errors.
- Add the thin provider-level track below the text. Its determinate width is completed/count; an
  active accent segment animates within the remaining track.
- Add a neutral waiting treatment after 15 seconds and a restrained warning treatment after 60
  seconds. Do not reuse `#status.error` red unless an actual provider error has occurred.
- Add reduced-motion rules and keep dark-mode behavior token-driven.

### 5. Keep other surfaces compatible

- [runtime.ts](../../src/pages/popup/runtime.ts), popup `main.ts`, and `dev.ts` require no new runtime
  methods because they already expose `BackgroundApi` generically.
- The options-page **Full sync** action can remain visually unchanged for this scope. A simultaneously
  open home page will still display its progress through `syncStatus`.
- The background API change is additive to the running branch, but existing exact-shape tests must
  be updated. There is no persisted schema, manifest, worker protocol, or database migration.

## Automated tests

### Core sync tests

Extend [sync.test.ts](../../tests/sync.test.ts):

- A two-page provider emits `provider-start`, two `page-complete` events, then
  `provider-complete`, in that order.
- `page-complete` fires after persistence and carries cumulative counters, the raw page kind, and
  zero-based page number.
- A zero-item/known-item page still emits activity.
- Capture mode increments `captured` while inserted/updated remain zero.
- Partial failure and cooperative stop each emit exactly one final provider event with the same
  report returned to the caller.
- An observer that throws does not change the sync report or watermark behavior.
- `syncAllProviders({ include })` emits events only for included providers and preserves provider
  order.

### Background service tests

Extend [background-service.test.ts](../../tests/background-service.test.ts) with gate-controlled
providers:

- Status transitions from idle → first provider connecting → first page fetched → first provider
  complete/second provider connecting → idle.
- Active ordinal and count reflect the enabled provider sequence; disabled providers are excluded.
- Repeated `syncStatus` calls return snapshots that cannot mutate internal state.
- A partial/failed provider is retained in `completed` while the next provider runs, including
  `needsLogin` without an error stack.
- Stop sets `stopping`, releases the lock as today, and late progress from the old run cannot alter a
  newly started run.
- Explicit single-provider sync reports index/count as `1/1`.
- Capture-mode progress reports captured-page totals.

There is no DOM test framework in the repository. Keep copy/formatting helpers pure enough to test
with `node:test` if they become non-trivial; otherwise cover rendering through the manual harness
below rather than introducing a UI dependency.

## Verification checklist

1. Run `npm test` for all TypeScript projects and the full Node suite.
2. Run `npm run build`, then `npm run ux` and verify at `http://127.0.0.1:5173/`:
   - banner placement in popup-width and full-page layouts;
   - long provider/error names wrap without pushing controls off-screen;
   - search and similar-item results remain untouched while the banner updates;
   - light, dark, and reduced-motion presentations.
3. Reload the unpacked extension from `dist/src` and start **All services**:
   - the first enabled provider appears with the correct ordinal;
   - each fetched page updates activity even when it finds no new items;
   - the current provider advances sequentially and completed services remain summarized;
   - the new-item counter reflects this run, not the total database.
4. Close and reopen the popup during a long YouTube or Instagram sync. It must reconstruct the same
   provider/page/count state and show Stop immediately.
5. Keep `page.html` open while starting a sync from the popup (and vice versa). Both surfaces should
   converge on the same background-owned progress within one poll interval.
6. During a sync, change the provider dropdown and run a search. The progress banner must continue
   describing the pinned sync scope while the selected/search view remains intact.
7. Trigger a known login failure for one provider in an all-services run. The banner should name the
   issue, continue to the next provider, and the final status should retain the error.
8. Turn on capture mode and confirm the banner speaks in captured pages rather than new items.
9. Click Stop during a multi-page provider. Confirm the stopping copy, neutral final result, landed
   items retained, and the next incremental sync re-covers the gap.

## Acceptance criteria

- At every point in a running sync, the home page names the current provider or truthfully says it
  is waiting to start one.
- An all-services run shows the correct provider ordinal and enabled-provider count.
- Every safely persisted response page refreshes the page/activity details, including empty pages.
- Counts describe this run and use capture-specific wording in capture mode.
- The banner remains accurate after popup reopen and across simultaneous popup/full-page surfaces.
- Search, similar, deleted, and starred views are not replaced or mislabeled by progress polling.
- Provider failures and safe stopping remain visible without falsely marking the entire continuing
  run as stuck.
- No provider, injected script, DB schema, or RPC transport changes are required.
- `npm test` and `npm run build` pass.

## Out of scope

- Page-count percentages, completion ETAs, or byte-level network progress; the unofficial APIs do
  not expose reliable totals.
- Provider-specific substeps such as YouTube playlist names or Instagram collection names. The
  shared `PageKind` label is the v1 detail level; a future optional provider event hook can add safe,
  scrubbed labels if live testing proves that useful.
- Persisting run progress across service-worker termination or browser restart. Existing page
  commits/watermark rules provide data safety, but durable resumable jobs are a separate design.
- Moving the options page’s Full sync controls or adding notifications when a background sync ends.
