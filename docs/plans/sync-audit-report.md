# Sync safety: audit findings + hardening plan

## Context

User asked for an audit of sync-related hazards — (1) does changing the provider dropdown mid-sync retarget an "All services" sync, (2) concurrency safety, (3) Chrome-crash / tab-reload safety, (4) a safe way to stop an ongoing sync — and for the missing pieces to be built. The audit (below) found the data layer is already crash-safe by design, but there is **no concurrency guard, no sync visibility after the popup closes, and no stop mechanism**, plus one popup race. The plan adds a background-owned sync-run state (single-flight + status + stop), threads a stop token through `core/sync.ts` with **zero provider changes**, fixes the popup progress-poll race, and adds an SW keepalive so long syncs aren't killed by MV3's 30s idle timer.

## Audit findings (the report)

### Q1 — Dropdown changes during an "All services" sync: **backend safe, popup has a race**
- The sync scope is pinned at click time: `doSync` reads `providerRef.current` once, synchronously, before any await ([app.tsx:351](src/pages/popup/app.tsx:351)) and calls `syncAll` or `sync({provider})`. Background `syncAll` iterates its fixed registry ([sync.ts:183-187](src/core/sync.ts:183)); nothing re-reads UI state. **The sync cannot "forget" or narrow its scope.**
- Real issues found around it:
  - The 800 ms progress poll ([app.tsx:332-348](src/pages/popup/app.tsx:332)) is the only async view-writer that ignores `generationRef` — a search or "more like this" started mid-sync is clobbered every 800 ms by the poll's `setItems`/`setStatus`.
  - Post-sync `await loadItems()` ([app.tsx:357](src/pages/popup/app.tsx:357)) unconditionally replaces the view — a query typed mid-sync stays in the box while its results are wiped.
  - The completion message doesn't name the synced scope, so after a dropdown change it reads as if it describes the current view.

### Q2 — Concurrency: **no guard anywhere; reachable in practice**
- `serveRuntime` dispatches every message immediately ([transports.ts:138-143](src/core/rpc/transports.ts:138)); `createBackgroundService` has no in-flight tracking. The Sync button's `disabled={syncing}` is per-popup-instance only.
- Reachable via: popup + page.html open together (same `<App/>`, separate state); popup closed and reopened mid-sync (background keeps syncing; reopened popup shows idle and lets you click Sync again).
- Impact of overlap: DB is safe (single DB-worker thread, sync handlers, per-page transactions [items.ts:136](src/core/db/items.ts:136), idempotent `ON CONFLICT` upserts; watermark races are benign — worst case extra refetch). The harm is service-level: doubled walks defeat pacing (HN's 500 ms delay becomes ~250 ms effective → rate-limit/"Sorry" pages), doubled injected traffic in the same site tab (account-flag risk), duplicate `raw_data` rows in capture mode (`rawStore` is a plain INSERT, no uniqueness — [raw.ts:44](src/core/db/raw.ts:44)).
- Adjacent hole: `clearItems`/`rawClear`/`rawIngest` can run mid-sync; a clear during sync leaves a fresh watermark over a gutted table, hiding the cleared older items from incremental sync until a ⟳ Full.

### Q3 — Crash / tab-reload safety: **data model already crash-safe; SW lifetime is the gap**
- Already correct by design: each page is persisted before the next fetch ([sync.ts:109-111](src/core/sync.ts:109)); the watermark is written only after a fully successful walk ([sync.ts:174](src/core/sync.ts:174)), so any death re-covers the gap next incremental sync; upserts are transactional and idempotent; OPFS + SQLite journaling survives hard crashes; tab reload/close mid-injection rejects `execInTab` → `ProviderError` → `partial` report with landed pages kept.
- Gaps:
  - **MV3 idle kill**: the SW's 30 s idle timer resets on extension-API calls (every `onPage` → RPC to offscreen does), but a single slow `fetch()` + `sleep()` stretch (direct providers have no fetch timeout, e.g. [hackernews.ts:20](src/ext/providers/hackernews.ts:20)) makes no chrome.* calls — Chrome kills the SW mid-sync. Silent death; an open popup sees "message port closed"; a closed one sees nothing.
  - If the SW dies inside `withTab`, the `finally` that closes a created background tab ([env.ts:88](src/ext/providers/env.ts:88)) never runs — orphaned youtube/facebook tab.
  - No resume/visibility: nothing records "a sync is running", so no UI surface can reattach.

### Q4 — Stop: **does not exist** (`SyncOptions` = full/captureRaw/maxItems only). Plan below adds it.

## Plan

### A. Core: stop token through the sync layer (no provider changes)

- [src/core/types.ts](../../src/core/types.ts): add to `SyncOptions` — `stop?: { readonly aborted: boolean }`. Structural on purpose: a real `AbortSignal` satisfies it while `core/` stays bare-ES2022 (no DOM lib). Add `stopped?: true` to the `partial`/`failed` variants of `SyncReport`.
- [src/core/sync.ts](../../src/core/sync.ts):
  - Module-local `class SyncStopped extends Error`.
  - At `onPage` entry: `if (stop?.aborted) throw new SyncStopped()` — the same choke point `maxItems` uses, so all 7 providers stop at their next page boundary with zero changes.
  - Classification: `SyncStopped` (or `stop?.aborted` after a normal `fetchItems` return — covers a provider finishing without another `onPage`) ⇒ never `setMeta` (watermark untouched ⇒ next sync heals the gap, same invariant as failures), report `partial`/`failed` by landed counts with `stopped: true`, `error: "Sync stopped"`.
  - `syncAllProviders`: `if (opts.stop?.aborted) break` between providers.

### B. Background service: single-flight + status + stop ([src/ext/background-service.ts](../../src/ext/background-service.ts))

- Per-instance run state: `let running: { controller: AbortController; scope: ProviderId | "all"; startedAt: number } | null`.
- `sync`/`syncAll`: throw `"A sync is already running"` if `running`; else set it, pass `stop: controller.signal`, clear in `finally`. Global lock (not per-provider) — matches the single Sync button and covers syncAll-vs-provider overlap.
- New `BackgroundApi` ops (chrome-free, so popup, page.html and `npm run ux` all get them automatically):
  - `syncStatus({}) → { running: false } | { running: true; scope; startedAt; stopping: boolean }`
  - `syncStop({}) → { stopping: boolean }` — aborts **and clears `running` immediately**, so a zombie walk (hung fetch) can't hold the lock forever; the stop-token + setMeta guard keep the zombie inert (idempotent upserts make a brief overlap with a new sync harmless).
- Guard `clearItems`, `rawClear`, `rawIngest`, `rawReingest` with the same `running` check (reject while a sync runs).

### C. SW keepalive during sync ([src/ext/background.ts](../../src/ext/background.ts))

- Chrome-side only: decorate the service's `sync`/`syncAll` handlers before `serveRuntime` — `setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)` while a sync runs, cleared in `finally`. A cheap extension-API call resets the 30 s idle timer (Chrome 110+ rule), closing the idle-kill gap in Q3. `syncStop` (B) is the escape hatch if a fetch truly hangs.

### D. Popup UI ([src/pages/popup/app.tsx](../../src/pages/popup/app.tsx))

- **Fix the poll race**: track view ownership in a ref (`"list" | "search" | "similar"`, set by `loadItems`/`runSearch`/`showSimilar`). The progress poll snapshots `generationRef.current` before its `listItems` call and only applies results if the generation is unchanged **and** the view is `"list"`.
- **Stop button**: while syncing, the Sync button becomes Stop → `api.syncStop({})` (brief "Stopping…" disabled state); a `stopped` report renders as neutral status text (not error styling), scope-labelled: `"All services: 12 new · … · stopped"`.
- **Reattach on open**: in the init effect, `api.syncStatus({})`; if running, set `syncing`, start the extracted progress-poll loop, and poll `syncStatus` until `running: false`, then refresh. Fixes reopened-popup blindness and makes popup + page.html surfaces coherent (also the UI-level fix for Q2 — the backend lock in B is the hard guarantee).
- **Post-sync view restore**: if the view is `"search"`, re-run `runSearch(query, mode)` instead of `loadItems()`.
- Surface the B-lock rejection as a status message (race window: two surfaces clicking simultaneously).

### E. Tests (zero-dep `node:test`, per repo convention)

- Extend [tests/sync.test.ts](../../tests/sync.test.ts) (scripted-provider harness already there): stop mid-walk ⇒ landed pages kept, `stopped: true`, watermark untouched, next incremental sync refetches the gap; `syncAll` stops between providers; aborted-after-return ⇒ no watermark.
- New `tests/background-service.test.ts`: `createBackgroundService` with `asyncDbApi(openDb())` (+ stub `export`/`rawIngest`/`rawReingest`), stub AI client, `createMemoryPrefs` ([prefs.ts:35](src/core/prefs.ts:35)), a slow scripted provider ⇒ second `sync` rejects while first runs; `syncStatus` transitions; `syncStop` resolves the in-flight call with a stopped report and frees the lock; maintenance ops rejected mid-sync.

## Verification

1. `npm test` (tsc -b + full suite) — new core + service tests above.
2. `npm run build` → reload unpacked `dist/src` → live smoke (per CLAUDE.md checklist): incremental HN (direct) + YouTube (injected) sync; **mid-YouTube-sync click Stop** → neutral "stopped" status, no watermark advance, re-sync picks the gap up; close + reopen popup mid-sync → reattaches showing Stop/progress; open popup + page.html together → second surface reflects running state, direct RPC double-sync rejected; type a search mid-sync → results no longer clobbered by the poll; then search (3 modes), "≈ more like this", Export, options save.
3. `npm run ux` — dev harness parity: sync/stop/status flow against the fixture DB with the fake embedder.

## Out of scope (documented residual risks)

- **Per-fetch timeouts** in direct providers (`AbortSignal.timeout` in their fetch helpers) and plumbing the stop signal into `ProviderEnv.sleep`/fetches for instant (not page-boundary) cancellation — follow-up hardening; Stop + keepalive make the current page-boundary latency (~1–4 s typical) acceptable.
- **Orphaned created tab** if the SW dies inside `withTab` — follow-up: tag created tab ids in `chrome.storage.session`, sweep on SW start.
- Capture-mode duplicate `raw_data` rows from concurrent syncs — mooted by the single-flight lock.
