// core/ai/orchestrator.ts under Node: real in-memory DB + deterministic fake
// embedder — the exact vector plumbing (backlog drain, mode fallbacks,
// hybrid search) the offscreen document runs, minus the model.
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./helpers/open-db.ts";
import { asyncDbApi } from "./helpers/async-db.ts";
import { createFakeAi, FAKE_MODEL } from "./helpers/fake-embedder.ts";
import { upsert } from "../src/core/db/items.ts";
import { embeddingStats } from "../src/core/db/embeddings.ts";
import { createOrchestrator, rowText } from "../src/core/ai/orchestrator.ts";
import type { SqlDatabase } from "../src/core/db/port.ts";
import type { AiSettings } from "../src/core/types.ts";

function seedItems(db: SqlDatabase, titles: string[]) {
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: titles.map((title, i) => ({ externalId: `x${i}`, url: "", title })),
  });
}

function makeOrchestrator(
  db: SqlDatabase,
  fakeAi: ReturnType<typeof createFakeAi>,
  { settings = null }: { settings?: AiSettings | null } = {}
) {
  let settingsCalls = 0;
  const orchestrator = createOrchestrator({
    db: asyncDbApi(db),
    ai: fakeAi.ai,
    getSettings: async () => {
      settingsCalls++;
      return settings;
    },
  });
  return { orchestrator, settingsCalls: () => settingsCalls };
}

test("embedBacklog drains everything in 64-row pulls and ≤16-text batches", async () => {
  const db = await openDb();
  seedItems(db, Array.from({ length: 100 }, (_, i) => `item number ${i}`));
  const fake = createFakeAi();
  const { orchestrator } = makeOrchestrator(db, fake);

  await orchestrator.embedBacklog({});

  const stats = embeddingStats(db, { model: FAKE_MODEL });
  assert.deepEqual(stats, { total: 100, embedded: 100 });
  const embeds = fake.calls.filter((c) => c.op === "embed");
  assert.ok(embeds.every((c) => c.texts!.length <= 16));
  assert.equal(embeds.reduce((n, c) => n + c.texts!.length, 0), 100);
  db.close();
});

test("status reports model state and backlog math", async () => {
  const db = await openDb();
  seedItems(db, ["a", "b", "c"]);
  const fake = createFakeAi();
  const { orchestrator, settingsCalls } = makeOrchestrator(db, fake);

  let s = await orchestrator.status({});
  assert.equal(s.modelReady, true);
  assert.equal(s.model, FAKE_MODEL);
  assert.equal(s.backlog, 3);
  assert.equal(s.embedded, 0);

  await orchestrator.embedBacklog({});
  s = await orchestrator.status({});
  assert.equal(s.backlog, 0);
  assert.equal(s.embedded, 3);
  assert.equal(settingsCalls(), 1); // settings pulled once, at creation
  db.close();
});

test("search: explicit fts mode and operator queries never touch the model", async () => {
  const db = await openDb();
  seedItems(db, ["rust in production", "cooking with cast iron"]);
  const fake = createFakeAi();
  const { orchestrator } = makeOrchestrator(db, fake);

  let r = await orchestrator.search({ query: "rust", mode: "fts" });
  assert.equal(r.mode, "fts");
  assert.equal(r.items.length, 1);

  r = await orchestrator.search({ query: "title:rust", mode: "hybrid" });
  assert.deepEqual({ mode: r.mode, requested: r.requested }, { mode: "fts", requested: "hybrid" });
  assert.equal(fake.calls.filter((c) => c.op === "embed").length, 0);
  db.close();
});

test("search defaults to text mode when the caller omits mode", async () => {
  const db = await openDb();
  seedItems(db, ["rust in production"]);
  const fake = createFakeAi();
  const { orchestrator } = makeOrchestrator(db, fake);
  const result = await orchestrator.search({ query: "rust" });
  assert.deepEqual({ mode: result.mode, requested: result.requested }, { mode: "fts", requested: "fts" });
  assert.equal(fake.calls.filter((c) => c.op === "embed").length, 0);
  db.close();
});

test("search falls back to fts while the model isn't ready, kicking the backlog", async () => {
  const db = await openDb();
  seedItems(db, ["rust in production"]);
  const fake = createFakeAi({ ready: false });
  const { orchestrator } = makeOrchestrator(db, fake);

  const r = await orchestrator.search({ query: "rust", mode: "hybrid" });
  assert.deepEqual({ mode: r.mode, requested: r.requested }, { mode: "fts", requested: "hybrid" });
  assert.equal(r.items.length, 1);
  db.close();
});

test("search falls back to fts when zero rows are embedded for the model", async () => {
  const db = await openDb();
  seedItems(db, ["rust in production"]);
  const fake = createFakeAi();
  const { orchestrator } = makeOrchestrator(db, fake);

  const r = await orchestrator.search({ query: "rust", mode: "semantic" });
  assert.equal(r.mode, "fts");
  assert.equal(r.requested, "semantic");
  db.close();
});

test("hybrid and semantic search end-to-end over the fake embedding space", async () => {
  const db = await openDb();
  seedItems(db, ["coffee brewing guide", "the history of coffee", "javascript performance tricks"]);
  const fake = createFakeAi();
  const { orchestrator } = makeOrchestrator(db, fake);
  await orchestrator.embedBacklog({});

  const hybrid = await orchestrator.search({ query: "coffee brewing", mode: "hybrid" });
  assert.equal(hybrid.mode, "hybrid");
  assert.equal(hybrid.items[0]!.title, "coffee brewing guide"); // in both rankings

  const semantic = await orchestrator.search({ query: "coffee brewing guide", mode: "semantic" });
  assert.equal(semantic.mode, "semantic");
  assert.ok(semantic.items.length >= 1);
  assert.equal(semantic.items[0]!.title, "coffee brewing guide");
  assert.ok(semantic.items[0]!.similarity! > 0.9); // near-identical token bag
  db.close();
});

test("overlapping embedBacklog triggers coalesce (single-flight)", async () => {
  const db = await openDb();
  seedItems(db, Array.from({ length: 30 }, (_, i) => `row ${i}`));
  const fake = createFakeAi();
  const { orchestrator } = makeOrchestrator(db, fake);

  await Promise.all([orchestrator.embedBacklog({}), orchestrator.embedBacklog({}), orchestrator.embedBacklog({})]);
  const embedded = fake.calls.filter((c) => c.op === "embed").reduce((n, c) => n + c.texts!.length, 0);
  assert.equal(embedded, 30); // not 90
  db.close();
});

test("rowText joins title/publication/summary and truncates at 1000 chars", () => {
  assert.equal(rowText({ title: "t", publication: "", summary: "s" }), "t\ns");
  assert.equal(rowText({ title: "x".repeat(2000), publication: null, summary: null }).length, 1000);
});
