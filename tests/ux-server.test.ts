// The dev harness's BackgroundApi service — the same createBackgroundService
// the extension runs, over a direct in-process DB with the fake embedder.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "./helpers/open-db.ts";
import { count } from "../src/core/db/items.ts";
import { rawStore } from "../src/core/db/raw.ts";
import { createDevService, seedFixtures } from "../src/node/tools/ux-server.ts";

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

test("dev service: rawIngest processes pending raw pages and then becomes a no-op", async () => {
  const db = await openDb();
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
  const service = createDevService(db);

  let res = await service.rawIngest({});
  assert.equal(res.pages, 1);
  assert.equal(res.ingested, 1);
  assert.equal(count(db, {}), 2);

  res = await service.rawIngest({});
  assert.equal(res.pages, 0);
  assert.equal(count(db, {}), 2);
  db.close();
});

test("dev service: fixture seed + search over the fake embedding space", async () => {
  const db = await openDb();
  seedFixtures(db);
  const service = createDevService(db);

  const list = await service.listItems({ provider: null });
  assert.ok(list.total >= 7); // HN 2 + IG 2 + YT 2 + Substack 2 (minus overlaps)

  // FTS works immediately; hybrid falls back until the backlog drains.
  const fts = await service.search({ provider: null, query: "coffee OR story", mode: "fts" });
  assert.equal(fts.mode, "fts");

  await service.embed({}); // kick + await is fine: embed() itself is fire-and-forget
  const status = await service.aiStatus({});
  assert.equal(status.model, "dev:token-hash");

  // Sync is extension-only in the harness and says so.
  await assert.rejects(async () => service.sync({ provider: "hackernews" }), /extension-only/);
  db.close();
});
