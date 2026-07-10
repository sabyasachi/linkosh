import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "./helpers/open-db.ts";
import { count } from "../src/core/db/items.ts";
import { rawStore, rawKnownIds, rawClear, rawStats } from "../src/core/db/raw.ts";
import { ingestPending, reingest } from "../src/core/ingest.ts";
import type { SqlDatabase } from "../src/core/db/port.ts";

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

function storeFixturePages(db: SqlDatabase) {
  rawStore(db, {
    provider: "hackernews",
    account: "alice",
    page: {
      kind: "stories",
      url: "https://news.ycombinator.com/upvoted?id=alice",
      page: 0,
      context: { url: "https://news.ycombinator.com/upvoted?id=alice" },
      body: fixture("hackernews/upvoted-stories.html"),
    },
    externalIds: ["11111", "22222"],
    fetchedAt: Date.now(),
  });
  rawStore(db, {
    provider: "instagram",
    account: "janedoe",
    page: {
      kind: "items",
      url: "/api/v1/feed/saved/posts/",
      page: 0,
      context: { collections: { 111: "Recipes", 222: "Travel" } },
      body: fixture("instagram/saved-feed-page.json"),
    },
    externalIds: ["310000000000001", "310000000000002"],
    fetchedAt: Date.now(),
  });
  // Aux page: no saveable items, still archived and ingestable.
  rawStore(db, {
    provider: "instagram",
    account: "janedoe",
    page: {
      kind: "collections",
      url: "/api/v1/collections/list/",
      page: 0,
      body: fixture("instagram/collections-page.json"),
    },
    externalIds: [],
    fetchedAt: Date.now(),
  });
}

test("ingestPending replays raw pages into saved_items via the shared parsers", async () => {
  const db = await openDb();
  storeFixturePages(db);
  assert.equal(count(db, {}), 0); // capture wrote nothing to saved_items

  const res = ingestPending(db);
  assert.equal(res.pages, 3);
  assert.equal(res.ingested, 3);
  assert.equal(res.failed, 0);
  assert.equal(res.inserted, 4); // 2 HN stories + 2 IG posts; collections page adds none

  // Parsed exactly like a live sync would: context applied, facets in place.
  const ig = db.rows<{ collection: string; kind: string }>(
    "SELECT * FROM saved_items WHERE provider = 'instagram' ORDER BY external_id"
  );
  assert.equal(ig[0]!.collection, '["Recipes","Travel"]');
  assert.equal(ig[0]!.kind, "reel");
  const hn = db.rows<{ title: string; poster_handle: string }>(
    "SELECT * FROM saved_items WHERE provider = 'hackernews' ORDER BY external_id"
  );
  assert.equal(hn[0]!.title, "Story One & friends");
  assert.equal(hn[0]!.poster_handle, "alice");

  assert.deepEqual(
    db.rows<{ status: string }>("SELECT DISTINCT status FROM raw_data").map((r) => r.status),
    ["ingested"]
  );
  db.close();
});

test("a bad page is marked failed with its body intact, then retried after a fix", async () => {
  const db = await openDb();
  rawStore(db, {
    provider: "substack",
    account: "u",
    page: { kind: "items", url: "", page: 0, body: "definitely not json" },
    externalIds: [],
    fetchedAt: Date.now(),
  });

  let res = ingestPending(db);
  assert.equal(res.failed, 1);
  assert.equal(res.ingested, 0);
  const failed = db.rows<{ status: string; error: string; body: string }>(
    "SELECT status, error, body FROM raw_data"
  )[0]!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /JSON/);
  assert.equal(failed.body, "definitely not json"); // regression fixture material

  // "Fix" the page (stand-in for fixing the parser) — ingestPending picks
  // failed rows back up.
  db.run("UPDATE raw_data SET body = ? WHERE 1", [fixture("substack/saved-page.json")]);
  res = ingestPending(db);
  assert.equal(res.ingested, 1);
  assert.equal(res.inserted, 2);
  assert.equal(db.rows<{ status: string }>("SELECT status FROM raw_data")[0]!.status, "ingested");
  db.close();
});

test("reingest is idempotent and re-runs ingested rows (the pipeline-changed path)", async () => {
  const db = await openDb();
  storeFixturePages(db);
  ingestPending(db);
  const before = db.rows("SELECT external_id, title FROM saved_items ORDER BY id");

  const res = reingest(db);
  assert.equal(res.pages, 3);
  assert.equal(res.ingested, 3);
  assert.equal(res.inserted, 0); // all rows already exist
  assert.equal(res.updated, 4);
  assert.deepEqual(db.rows("SELECT external_id, title FROM saved_items ORDER BY id"), before);
  assert.equal(count(db, {}), 4); // no duplicates
  db.close();
});

test("rawKnownIds flattens crawl-time ids up to the fetch-time cutoff", async () => {
  const db = await openDb();
  const page = { kind: "items", url: "", page: 0 } as const;
  rawStore(db, { provider: "hackernews", account: "u", page: { ...page, body: "x" }, externalIds: ["1", "2"], fetchedAt: Date.now() });
  rawStore(db, { provider: "hackernews", account: "u", page: { ...page, body: "y" }, externalIds: ["3"], fetchedAt: Date.now() });
  rawStore(db, { provider: "substack", account: "u", page: { ...page, body: "z" }, externalIds: ["post:9"], fetchedAt: Date.now() });

  assert.deepEqual(rawKnownIds(db, { provider: "hackernews" }).sort(), ["1", "2", "3"]);
  // Cutoff before any row was stored → nothing is known.
  assert.deepEqual(rawKnownIds(db, { provider: "hackernews", fetchedBefore: 1 }), []);
  // Ingested rows still count (their fetch time is the clock, not ingest time).
  db.exec("UPDATE raw_data SET status = 'ingested'");
  assert.equal(rawKnownIds(db, { provider: "hackernews" }).length, 3);
  db.close();
});

test("rawClear and rawStats", async () => {
  const db = await openDb();
  storeFixturePages(db);
  const stats = rawStats(db);
  assert.deepEqual(
    stats.map((s) => [s.provider, s.status, s.pages]),
    [
      ["hackernews", "pending", 1],
      ["instagram", "pending", 2],
    ]
  );
  assert.ok(stats.every((s) => s.bytes > 0));

  rawClear(db, { provider: "instagram" });
  assert.equal(rawStats(db).length, 1);
  rawClear(db);
  assert.deepEqual(rawStats(db), []);
  db.close();
});
