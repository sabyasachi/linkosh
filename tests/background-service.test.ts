// createBackgroundService exercised directly (handlers called in-process, no
// RPC transports): the single-flight sync lock, syncStatus/syncStop, and the
// maintenance-op guards, driven by gate-controlled scripted providers against
// a real in-memory DB.
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./helpers/open-db.ts";
import { asyncDbApi } from "./helpers/async-db.ts";
import { createMemoryPrefs } from "../src/core/prefs.ts";
import { createBackgroundService } from "../src/ext/background-service.ts";
import type { AiApi } from "../src/core/ai/api.ts";
import type { DbWorkerApi } from "../src/core/db/service.ts";
import type { Client } from "../src/core/rpc/protocol.ts";
import type { IngestReport, Provider } from "../src/core/types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const EMPTY_INGEST: IngestReport = { pages: 0, ingested: 0, failed: 0, inserted: 0, updated: 0, errors: [] };

/** The worker-only ops (OPFS export, in-worker ingest) stubbed onto the
 *  promise-shaped DbApi — the service only forwards them. */
function dbClient(db: Parameters<typeof asyncDbApi>[0]): Client<DbWorkerApi> {
  return {
    ...asyncDbApi(db),
    export: async () => ({ file: "test.sqlite", size: 0 }),
    rawIngest: async () => EMPTY_INGEST,
    rawReingest: async () => EMPTY_INGEST,
  };
}

const aiStub: Client<AiApi> = {
  search: async () => ({ items: [], mode: "fts", requested: "fts" }),
  status: async () => ({
    modelReady: false,
    model: "fake",
    downloading: null,
    error: null,
    backlog: 0,
    embedded: 0,
    total: 0,
    embedding: { running: false, done: 0, total: 0 },
  }),
  embedBacklog: async () => undefined,
  configure: async () => undefined,
};

const pageBody = (ids: number[]) =>
  JSON.stringify({
    items: ids.map((id) => ({
      post: {
        id,
        title: `Post ${id}`,
        canonical_url: `https://x.substack.com/p/${id}`,
        publishedBylines: [{ name: "Author" }],
        post_date: "2026-01-01T00:00:00.000Z",
        type: "post",
      },
    })),
    nextCursor: null,
  });

/** A provider that lands one page, then blocks on a gate until the test
 *  releases it — keeping the sync in flight for as long as needed. It signals
 *  `landed` once the first page is through, and (if released while stopped)
 *  attempts a second page so the stop token can take effect. */
function gatedProvider() {
  const gate = deferred();
  const landed = deferred();
  const provider: Provider = {
    id: "substack",
    label: "Substack",
    async fetchItems({ onPage }) {
      await onPage("tester", { kind: "items", url: "/saved?p=0", page: 0, body: pageBody([1]) });
      landed.resolve();
      await gate.promise;
      await onPage("tester", { kind: "items", url: "/saved?p=1", page: 1, body: pageBody([2]) });
      return { account: "tester" };
    },
  };
  return { provider, gate, landed };
}

function makeService(provider: Provider) {
  return openDb().then((db) => ({
    db,
    svc: createBackgroundService({
      providers: { [provider.id]: provider },
      db: dbClient(db),
      ai: aiStub,
      prefs: createMemoryPrefs(),
    }),
  }));
}

test("a second sync (or syncAll) rejects while one is running; the lock frees on completion", async () => {
  const { provider, gate, landed } = gatedProvider();
  const { db, svc } = await makeService(provider);

  const first = svc.sync({ provider: "substack" });
  await landed.promise;
  await assert.rejects(async () => svc.sync({ provider: "substack" }), /already running/);
  await assert.rejects(async () => svc.syncAll({}), /already running/);

  gate.resolve();
  const report = await first;
  assert.equal(report.status, "ok");

  // Lock released — the next sync goes through (its walk completes instantly:
  // the gated provider's promises are already resolved).
  const again = await svc.sync({ provider: "substack" });
  assert.equal(again.status, "ok");
  db.close();
});

test("syncStatus reports idle → running (with scope and startedAt) → idle", async () => {
  const { provider, gate, landed } = gatedProvider();
  const { db, svc } = await makeService(provider);

  assert.deepEqual(await svc.syncStatus({}), { running: false });

  const run = svc.sync({ provider: "substack" });
  await landed.promise;
  const during = await svc.syncStatus({});
  assert.ok(during.running);
  assert.equal(during.scope, "substack");
  assert.ok(during.startedAt > 0);
  assert.equal(during.stopping, false);

  gate.resolve();
  await run;
  assert.deepEqual(await svc.syncStatus({}), { running: false });
  db.close();
});

test("syncAll reports scope 'all'", async () => {
  const { provider, gate, landed } = gatedProvider();
  const { db, svc } = await makeService(provider);
  const run = svc.syncAll({});
  await landed.promise;
  const during = await svc.syncStatus({});
  assert.ok(during.running && during.scope === "all");
  gate.resolve();
  await run;
  db.close();
});

test("syncStop frees the lock immediately and the in-flight call resolves stopped", async () => {
  const { provider, gate, landed } = gatedProvider();
  const { db, svc } = await makeService(provider);

  const run = svc.sync({ provider: "substack" });
  await landed.promise;
  assert.deepEqual(await svc.syncStop({}), { stopping: true });

  // The lock is freed right away — a wedged walk can't hold it hostage.
  assert.deepEqual(await svc.syncStatus({}), { running: false });

  // The old walk unwinds: its next onPage hits the aborted token, the call
  // resolves as a stopped partial with the landed page kept.
  gate.resolve();
  const report = await run;
  assert.equal(report.status, "partial");
  assert.ok(report.status === "partial");
  assert.equal(report.stopped, true);
  assert.equal(report.inserted, 1);
  db.close();
});

test("syncStop with nothing running is a no-op", async () => {
  const { provider } = gatedProvider();
  const { db, svc } = await makeService(provider);
  assert.deepEqual(await svc.syncStop({}), { stopping: false });
  db.close();
});

test("maintenance ops are rejected while a sync runs, allowed after", async () => {
  const { provider, gate, landed } = gatedProvider();
  const { db, svc } = await makeService(provider);

  const run = svc.sync({ provider: "substack" });
  await landed.promise;
  for (const op of [
    async () => svc.clearItems({}),
    async () => svc.rawClear({}),
    async () => svc.rawIngest({}),
    async () => svc.rawReingest({}),
  ]) {
    await assert.rejects(op, /sync is running/);
  }

  gate.resolve();
  await run;
  const cleared = await svc.clearItems({});
  assert.equal(cleared.deleted, 2); // both landed pages
  assert.deepEqual(await svc.rawClear({}), { cleared: true });
  db.close();
});
