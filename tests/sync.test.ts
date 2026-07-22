// core/sync.ts exercised end-to-end with a scripted provider and a real
// in-memory DB. The scripted provider speaks Substack's page shape so the
// real parse registry runs — no parser fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "./helpers/open-db.ts";
import { asyncDbApi } from "./helpers/async-db.ts";
import { count, list, setDeleted } from "../src/core/db/items.ts";
import { ingestPending } from "../src/core/ingest.ts";
import { createSync } from "../src/core/sync.ts";
import { ProviderError } from "../src/core/errors.ts";
import type { Provider, ProviderId, ProviderMeta } from "../src/core/types.ts";

const post = (id: number) => ({
  post: {
    id,
    title: `Post ${id}`,
    canonical_url: `https://x.substack.com/p/${id}`,
    publishedBylines: [{ name: "Author" }],
    post_date: "2026-01-01T00:00:00.000Z",
    type: "post",
  },
});

// One page body per element; newest-first across pages like the live service.
const pageBody = (ids: number[], nextCursor: string | null) =>
  JSON.stringify({ items: ids.map(post), nextCursor });
const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

/** A provider that serves scripted page bodies and follows the real
 *  stop-rule protocol (res.unseen / res.hasNext). */
function scriptedProvider(pages: string[], { failAfterPage = Infinity }: { failAfterPage?: number } = {}) {
  const stats = { fetched: 0 };
  const provider: Provider = {
    id: "substack",
    label: "Substack",
    async fetchItems({ onPage }) {
      for (let i = 0; i < pages.length; i++) {
        stats.fetched++;
        const res = await onPage("tester", { kind: "items", url: `/saved?p=${i}`, page: i, body: pages[i]! });
        if (i >= failAfterPage) throw new ProviderError("service hiccup");
        if (res.unseen === 0 || !res.hasNext) break;
      }
      return { account: "tester" };
    },
  };
  return { provider, stats };
}

function harness(provider: Provider, db: Parameters<typeof asyncDbApi>[0]) {
  const meta = new Map<ProviderId, ProviderMeta>();
  const synced: ProviderId[] = [];
  const sync = createSync({
    providers: { [provider.id]: provider },
    db: asyncDbApi(db),
    getMeta: async (id) => meta.get(id) ?? null,
    setMeta: async (id, m) => void meta.set(id, m),
    onSynced: (id) => synced.push(id),
  });
  return { sync, meta, synced };
}

test("full walk: every page lands, meta recorded, onSynced fired", async () => {
  const db = await openDb();
  const { provider, stats } = scriptedProvider([pageBody([3, 2], "c1"), pageBody([1], null)]);
  const { sync, meta, synced } = harness(provider, db);

  const res = await sync.syncProvider("substack");
  assert.equal(res.status, "ok");
  assert.deepEqual(
    { inserted: res.inserted, updated: res.updated, total: res.total },
    { inserted: 3, updated: 0, total: 3 }
  );
  assert.equal(stats.fetched, 2);
  assert.ok(meta.get("substack")!.syncedAt > 0);
  assert.ok(res.status === "ok" && res.syncedAt === meta.get("substack")!.syncedAt);
  assert.deepEqual(synced, ["substack"]);
  db.close();
});

test("incremental sync stops at the first page with nothing unseen", async () => {
  const db = await openDb();
  const first = scriptedProvider([pageBody([3, 2], "c1"), pageBody([1], null)]);
  const h1 = harness(first.provider, db);
  await h1.sync.syncProvider("substack");

  // One new item appears at the top. Page 1 {4, 3} has one unseen item so
  // paging continues; page 2 {2, 1} is all known — stop there, never
  // touching page 3.
  const second = scriptedProvider([
    pageBody([4, 3], "c1"),
    pageBody([2, 1], "c2"),
    pageBody([0], null), // must never be fetched
  ]);
  const h2 = harness(second.provider, db);
  h2.meta.set("substack", h1.meta.get("substack")!);

  const res = await h2.sync.syncProvider("substack");
  assert.equal(res.inserted, 1);
  assert.equal(res.updated, 3); // known items 3, 2, 1 refreshed on the way
  assert.equal(second.stats.fetched, 2); // ← the stop rule
  assert.equal(res.total, 4);

  // full: true ignores knownIds and re-walks everything.
  const third = scriptedProvider([pageBody([4, 3], "c1"), pageBody([2, 1], null)]);
  const h3 = harness(third.provider, db);
  h3.meta.set("substack", h2.meta.get("substack")!);
  const fullRes = await h3.sync.syncProvider("substack", { full: true });
  assert.equal(third.stats.fetched, 2);
  assert.equal(fullRes.updated, 4);
  db.close();
});

const listedIds = (db: Awaited<ReturnType<typeof openDb>>) =>
  list(db, {}).map((r) => r.externalId);

test("sort keys: one run shares one decrementing band, so the list is newest-first", async () => {
  const db = await openDb();
  const { provider } = scriptedProvider([pageBody([5, 4], "c1"), pageBody([3, 2], "c2"), pageBody([1], null)]);
  const { sync } = harness(provider, db);
  await sync.syncProvider("substack");

  // Keys fall monotonically in arrival order across ALL pages of the run —
  // the cursor is threaded, never restarted per page.
  const rows = db.rows<{ external_id: string; sort_key: number }>(
    "SELECT external_id, sort_key FROM saved_items ORDER BY id"
  );
  assert.deepEqual(rows.map((r) => r.external_id), ["post:5", "post:4", "post:3", "post:2", "post:1"]);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.sort_key, rows[0]!.sort_key - i);
  assert.deepEqual(listedIds(db), ["post:5", "post:4", "post:3", "post:2", "post:1"]);
  db.close();
});

test("sort keys: a delta run lands above earlier runs; an old item bookmarked late tops the list", async () => {
  const db = await openDb();
  const first = scriptedProvider([pageBody([3, 2], "c1"), pageBody([1], null)]);
  const h1 = harness(first.provider, db);
  await h1.sync.syncProvider("substack");

  // The user bookmarks old post 0 — the service lists it newest-first on
  // page 1 next to new post 4. Delta band > everything stored, arrival order
  // kept within it.
  await new Promise((r) => setTimeout(r, 2)); // distinct Date.now() band
  const second = scriptedProvider([pageBody([4, 0, 3], "c1"), pageBody([2, 1], null)]);
  const h2 = harness(second.provider, db);
  h2.meta.set("substack", h1.meta.get("substack")!);
  await h2.sync.syncProvider("substack");

  assert.deepEqual(listedIds(db), ["post:4", "post:0", "post:3", "post:2", "post:1"]);
  db.close();
});

test("sort keys: an interrupted initial sync's retry decrements below what landed", async () => {
  const db = await openDb();
  // First attempt dies after page 1: the newest items {4, 3} land.
  const first = scriptedProvider(
    [pageBody([4, 3], "c1"), pageBody([2, 1], null)],
    { failAfterPage: 0 }
  );
  const h1 = harness(first.provider, db);
  const res1 = await h1.sync.syncProvider("substack");
  assert.equal(res1.status, "partial");

  // Retry (still no watermark → initial mode): re-walks from the top; known
  // items keep their keys, the older gap items {2, 1} continue below the
  // table minimum — never above the first attempt's rows.
  const second = scriptedProvider([pageBody([4, 3], "c1"), pageBody([2, 1], null)]);
  const h2 = harness(second.provider, db);
  const res2 = await h2.sync.syncProvider("substack");
  assert.equal(res2.status, "ok");
  assert.equal(res2.inserted, 2);

  assert.deepEqual(listedIds(db), ["post:4", "post:3", "post:2", "post:1"]);
  const keys = db.rows<{ external_id: string; sort_key: number }>(
    "SELECT external_id, sort_key FROM saved_items ORDER BY sort_key DESC"
  );
  assert.deepEqual(keys.map((r) => r.external_id), ["post:4", "post:3", "post:2", "post:1"]);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i]!.sort_key < keys[i - 1]!.sort_key);
  db.close();
});

test("a soft-deleted item survives re-sync: refreshed, not resurrected, stop rule intact", async () => {
  const db = await openDb();
  const first = scriptedProvider([pageBody([3, 2], "c1"), pageBody([1], null)]);
  const h1 = harness(first.provider, db);
  await h1.sync.syncProvider("substack");

  // The user deletes an item that is still saved on the service.
  const id = db.rows<{ id: number }>("SELECT id FROM saved_items WHERE title = 'Post 2'")[0]!.id;
  setDeleted(db, { id, deleted: true });
  assert.equal(count(db), 2);

  // The next incremental sync re-serves it on the way to the stop page.
  const second = scriptedProvider([
    pageBody([4, 3], "c1"),
    pageBody([2, 1], "c2"),
    pageBody([0], null), // must never be fetched
  ]);
  const h2 = harness(second.provider, db);
  h2.meta.set("substack", h1.meta.get("substack")!);
  const res = await h2.sync.syncProvider("substack");

  assert.equal(res.inserted, 1);
  assert.equal(second.stats.fetched, 2); // deleted row still counts as known — stop rule unchanged
  assert.equal(count(db), 3); // 4 stored, one still hidden
  assert.equal(count(db, { deleted: true }), 1);
  assert.ok(
    db.rows<{ deleted_at: number | null }>("SELECT deleted_at FROM saved_items WHERE title = 'Post 2'")[0]!
      .deleted_at
  );
  db.close();
});

test("partial failure keeps landed pages, reports the error, skips setMeta", async () => {
  const db = await openDb();
  const { provider } = scriptedProvider(
    [pageBody([3, 2], "c1"), pageBody([1], null)],
    { failAfterPage: 0 } // throw right after the first page landed
  );
  const { sync, meta, synced } = harness(provider, db);

  const res = await sync.syncProvider("substack");
  assert.equal(res.status, "partial");
  assert.equal(res.inserted, 2); // first page kept
  assert.ok(res.status === "partial");
  assert.equal(res.error, "service hiccup");
  assert.equal(res.needsLogin, false);
  assert.equal(meta.get("substack"), undefined); // failed run never counts as "last good sync"
  assert.deepEqual(synced, ["substack"]); // pages landed → embedding still kicked
  db.close();
});

test("a failure with nothing landed reports status failed (no throw)", async () => {
  const db = await openDb();
  const provider: Provider = {
    id: "substack",
    label: "Substack",
    async fetchItems() {
      throw new ProviderError("Not logged in", { needsLogin: true });
    },
  };
  const { sync, meta, synced } = harness(provider, db);
  const res = await sync.syncProvider("substack");
  assert.equal(res.status, "failed");
  assert.ok(res.status === "failed");
  assert.equal(res.error, "Not logged in");
  assert.equal(res.needsLogin, true);
  assert.deepEqual({ inserted: res.inserted, updated: res.updated, captured: res.captured }, { inserted: 0, updated: 0, captured: 0 });
  assert.equal(meta.get("substack"), undefined);
  assert.deepEqual(synced, []); // nothing landed → no embedding kick
  db.close();
});

test("unknown provider id still throws (programmer error, not a sync outcome)", async () => {
  const db = await openDb();
  const { provider } = scriptedProvider([pageBody([1], null)]);
  const { sync } = harness(provider, db);
  await assert.rejects(() => sync.syncProvider("twitter"), /Unknown provider/);
  db.close();
});

test("capture mode archives raw pages, leaves saved_items alone, and raw ingest replays them", async () => {
  const db = await openDb();
  const first = scriptedProvider([pageBody([3, 2], "c1"), pageBody([1], null)]);
  const h1 = harness(first.provider, db);

  const res = await h1.sync.syncProvider("substack", { captureRaw: true });
  assert.equal(res.status, "ok");
  assert.equal(res.captured, 2);
  assert.equal(res.inserted, 0);
  assert.equal(count(db, {}), 0); // pristine baseline
  const raw = db.rows<{ external_ids: string; status: string }>("SELECT * FROM raw_data ORDER BY id");
  assert.equal(raw.length, 2);
  assert.deepEqual(JSON.parse(raw[0]!.external_ids), ["post:3", "post:2"]);
  assert.equal(raw[0]!.status, "pending");

  // Incremental capture: the archive counts as known (rawKnownIds), so the
  // provider stops after one page even though saved_items is still empty.
  const second = scriptedProvider([pageBody([3, 2], "c1"), pageBody([1], null)]);
  const h2 = harness(second.provider, db);
  h2.meta.set("substack", h1.meta.get("substack")!);
  await h2.sync.syncProvider("substack", { captureRaw: true });
  assert.equal(second.stats.fetched, 1);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) n FROM raw_data")[0]!.n, 3); // the re-fetched first page is archived too

  // Raw ingest: the same shared pipeline moves the archive into saved_items.
  const ingested = ingestPending(db);
  assert.equal(ingested.inserted, 3);
  assert.equal(count(db, {}), 3);
  db.close();
});

test("youtube sync merges the same video from multiple playlists into one row", async () => {
  const db = await openDb();
  const body = fixture("youtube/playlist-page.json");
  const provider: Provider = {
    id: "youtube",
    label: "YouTube",
    async fetchItems({ onPage }) {
      await onPage("tester", {
        kind: "items",
        url: "youtubei/v1/browse#VLWL",
        page: 0,
        context: { playlistId: "WL", collection: "Watch later" },
        body,
      });
      await onPage("tester", {
        kind: "items",
        url: "youtubei/v1/browse#VLPL111",
        page: 0,
        context: { playlistId: "PL111", collection: "Recipes" },
        body,
      });
      return { account: "tester" };
    },
  };
  const { sync } = harness(provider, db);

  const res = await sync.syncProvider("youtube");
  assert.equal(res.inserted, 2);
  assert.equal(res.updated, 2);
  assert.equal(count(db, { provider: "youtube" }), 2);
  const row = db.rows<{ external_id: string; collection: string }>(
    "SELECT external_id, collection FROM saved_items WHERE external_id = 'abc123'"
  )[0]!;
  assert.equal(row.external_id, "abc123");
  assert.equal(row.collection, '["Watch later","Recipes"]');
  db.close();
});

test("test mode caps a run at ~maxItems and stops paging early", async () => {
  const db = await openDb();
  // Three pages of 2 items each; a cap of 3 should stop after page 2 (4 items
  // collected) and never fetch page 3.
  const { provider, stats } = scriptedProvider([
    pageBody([6, 5], "c1"),
    pageBody([4, 3], "c2"),
    pageBody([2, 1], null),
  ]);
  const { sync } = harness(provider, db);

  const res = await sync.syncProvider("substack", { maxItems: 3 });
  assert.equal(stats.fetched, 2); // page 3 never requested
  assert.equal(res.inserted, 4);
  assert.equal(count(db, {}), 4);
  db.close();
});

test("no cap (maxItems 0) walks everything", async () => {
  const db = await openDb();
  const { provider, stats } = scriptedProvider([
    pageBody([6, 5], "c1"),
    pageBody([4, 3], "c2"),
    pageBody([2, 1], null),
  ]);
  const { sync } = harness(provider, db);
  const res = await sync.syncProvider("substack", { maxItems: 0 });
  assert.equal(stats.fetched, 3);
  assert.equal(res.inserted, 6);
  db.close();
});

test("stop mid-walk keeps landed pages, skips the watermark, and the next sync heals the gap", async () => {
  const db = await openDb();
  const stop = { aborted: false };
  const pages = [pageBody([4, 3], "c1"), pageBody([2, 1], null)];
  let fetched = 0;
  const provider: Provider = {
    id: "substack",
    label: "Substack",
    async fetchItems({ onPage }) {
      for (let i = 0; i < pages.length; i++) {
        fetched++;
        const res = await onPage("tester", { kind: "items", url: `/saved?p=${i}`, page: i, body: pages[i]! });
        if (i === 0) stop.aborted = true; // the user clicks Stop after the first page landed
        if (res.unseen === 0 || !res.hasNext) break;
      }
      return { account: "tester" };
    },
  };
  const { sync, meta, synced } = harness(provider, db);

  const res = await sync.syncProvider("substack", { stop });
  assert.equal(res.status, "partial");
  assert.ok(res.status === "partial");
  assert.equal(res.stopped, true);
  assert.equal(res.error, "Sync stopped");
  assert.equal(res.inserted, 2); // first page kept
  assert.equal(fetched, 2); // second page attempted, dropped at the onPage gate
  assert.equal(meta.get("substack"), undefined); // watermark untouched
  assert.deepEqual(synced, ["substack"]); // landed pages still get embeddings

  // No watermark ⇒ the next incremental sync re-walks and backfills the gap.
  const second = scriptedProvider([pageBody([4, 3], "c1"), pageBody([2, 1], null)]);
  const h2 = harness(second.provider, db);
  const res2 = await h2.sync.syncProvider("substack");
  assert.equal(res2.status, "ok");
  assert.equal(res2.inserted, 2); // items 2 and 1 recovered
  assert.equal(res2.total, 4);
  db.close();
});

test("stop before anything lands reports failed + stopped", async () => {
  const db = await openDb();
  const { provider, stats } = scriptedProvider([pageBody([1], null)]);
  const { sync, meta, synced } = harness(provider, db);

  const res = await sync.syncProvider("substack", { stop: { aborted: true } });
  assert.equal(res.status, "failed");
  assert.ok(res.status === "failed");
  assert.equal(res.stopped, true);
  assert.equal(res.inserted, 0);
  assert.equal(stats.fetched, 1); // the page was fetched but never persisted
  assert.equal(meta.get("substack"), undefined);
  assert.deepEqual(synced, []);
  db.close();
});

test("abort after the provider's normal return still skips the watermark", async () => {
  const db = await openDb();
  const stop = { aborted: false };
  const provider: Provider = {
    id: "substack",
    label: "Substack",
    async fetchItems({ onPage }) {
      await onPage("tester", { kind: "items", url: "/saved?p=0", page: 0, body: pageBody([1], null) });
      stop.aborted = true; // abort lands while the last page is finishing — no further onPage
      return { account: "tester" };
    },
  };
  const { sync, meta } = harness(provider, db);

  const res = await sync.syncProvider("substack", { stop });
  assert.equal(res.status, "partial");
  assert.ok(res.status === "partial");
  assert.equal(res.stopped, true);
  assert.equal(res.inserted, 1); // the page landed and stays
  assert.equal(meta.get("substack"), undefined); // an aborted run never counts as "last good sync"
  db.close();
});

test("syncAllProviders stops between providers", async () => {
  const db = await openDb();
  const stop = { aborted: false };
  const first: Provider = {
    id: "substack",
    label: "Substack",
    async fetchItems({ onPage }) {
      await onPage("tester", { kind: "items", url: "/saved?p=0", page: 0, body: pageBody([1], null) });
      stop.aborted = true; // stop arrives while the first provider is finishing
      return { account: "tester" };
    },
  };
  let secondRan = false;
  const second: Provider = {
    id: "hackernews",
    label: "Hacker News",
    async fetchItems() {
      secondRan = true;
      return { account: "tester" };
    },
  };
  const meta = new Map<ProviderId, ProviderMeta>();
  const sync = createSync({
    providers: { substack: first, hackernews: second },
    db: asyncDbApi(db),
    getMeta: async (id) => meta.get(id) ?? null,
    setMeta: async (id, m) => void meta.set(id, m),
  });

  const res = await sync.syncAllProviders({ stop });
  assert.equal(secondRan, false); // never reached
  assert.equal(res.reports.length, 1); // finished reports stand
  assert.equal(res.inserted, 1);
  const ss = res.reports[0]!;
  assert.equal(ss.status, "partial");
  assert.ok(ss.status === "partial");
  assert.equal(ss.stopped, true);
  db.close();
});

test("syncAllProviders aggregates counts and carries per-provider reports", async () => {
  const db = await openDb();
  const ok = scriptedProvider([pageBody([1], null)]);
  const broken: Provider = {
    id: "hackernews",
    label: "Hacker News",
    async fetchItems() {
      throw new Error("boom");
    },
  };
  const meta = new Map<ProviderId, ProviderMeta>();
  const sync = createSync({
    providers: { substack: ok.provider, hackernews: broken },
    db: asyncDbApi(db),
    getMeta: async (id) => meta.get(id) ?? null,
    setMeta: async (id, m) => void meta.set(id, m),
  });
  const res = await sync.syncAllProviders();
  assert.equal(res.inserted, 1);
  assert.equal(res.reports.length, 2);
  const hn = res.reports.find((r) => r.providerId === "hackernews")!;
  assert.equal(hn.status, "failed");
  assert.ok(hn.status === "failed");
  assert.equal(hn.error, "boom");
  const ss = res.reports.find((r) => r.providerId === "substack")!;
  assert.equal(ss.status, "ok");
  db.close();
});

test("syncAllProviders honors include: providers outside it are skipped, no report emitted", async () => {
  const db = await openDb();
  const ok = scriptedProvider([pageBody([1], null)]);
  let skippedRan = false;
  const skipped: Provider = {
    id: "hackernews",
    label: "Hacker News",
    async fetchItems() {
      skippedRan = true;
      throw new Error("should not run");
    },
  };
  const meta = new Map<ProviderId, ProviderMeta>();
  const sync = createSync({
    providers: { substack: ok.provider, hackernews: skipped },
    db: asyncDbApi(db),
    getMeta: async (id) => meta.get(id) ?? null,
    setMeta: async (id, m) => void meta.set(id, m),
  });
  const res = await sync.syncAllProviders({ include: ["substack"] });
  assert.equal(skippedRan, false);
  assert.deepEqual(
    res.reports.map((r) => r.providerId),
    ["substack"]
  );
  assert.equal(res.inserted, 1);
  db.close();
});
