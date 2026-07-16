import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./helpers/open-db.ts";
import { upsert } from "../src/core/db/items.ts";
import { storeEmbeddings, pendingEmbeddings, embeddingStats, toVector } from "../src/core/db/embeddings.ts";
import { cosineTop, hybridSearch, semanticSearch, similar } from "../src/core/db/search.ts";
import type { SqlDatabase } from "../src/core/db/port.ts";
import type { ProviderId } from "../src/core/types.ts";

interface Spec {
  externalId?: string;
  title?: string;
  publication?: string;
  summary?: string;
}

// Seed items and return their DB ids in insertion order.
function seed(db: SqlDatabase, provider: ProviderId, specs: Spec[]) {
  upsert(db, {
    provider,
    account: "u",
    items: specs.map((s, i) => ({
      externalId: s.externalId ?? `x${i}`,
      url: "",
      title: s.title ?? `item ${i}`,
      ...(s.publication !== undefined ? { publication: s.publication } : {}),
      ...(s.summary !== undefined ? { summary: s.summary } : {}),
    })),
  });
  return db.rows<{ id: number; external_id: string }>(
    "SELECT id, external_id FROM saved_items WHERE provider = ? ORDER BY id",
    [provider]
  );
}

const vec = (...xs: number[]) => new Float32Array(xs);

test("storeEmbeddings round-trips Float32 vectors through the BLOB column", async () => {
  const db = await openDb();
  const [{ id }] = seed(db, "hackernews", [{}]) as [{ id: number; external_id: string }];
  const v = vec(0.25, -1, 3.5, 0);
  storeEmbeddings(db, { model: "m", rows: [{ id, vector: v }] });
  const blob = db.rows<{ embedding: Uint8Array }>("SELECT embedding FROM saved_items WHERE id = ?", [id])[0]!
    .embedding;
  assert.deepEqual([...toVector(blob)], [...v]);
  db.close();
});

test("pendingEmbeddings: NULL model rows match, embedded rows drop off, newest first", async () => {
  const db = await openDb();
  const ids = seed(db, "hackernews", [{}, {}, {}]).map((r) => r.id);
  // newest (highest id) first
  assert.deepEqual(pendingEmbeddings(db, { model: "m" }).map((r) => r.id), [...ids].reverse());

  storeEmbeddings(db, { model: "m", rows: [{ id: ids[2]!, vector: vec(1, 0) }] });
  assert.deepEqual(pendingEmbeddings(db, { model: "m" }).map((r) => r.id), [ids[1], ids[0]]);

  // rows embedded under another model still count as pending for this one
  storeEmbeddings(db, { model: "other", rows: [{ id: ids[1]!, vector: vec(1, 0) }] });
  assert.deepEqual(pendingEmbeddings(db, { model: "m" }).map((r) => r.id), [ids[1], ids[0]]);

  assert.equal(pendingEmbeddings(db, { model: "m", limit: 1 }).length, 1);

  assert.deepEqual(embeddingStats(db, { model: "m" }), { total: 3, embedded: 1 });
  db.close();
});

test("cosineTop ranks by dot product with excludeId, dim and minScore filters", async () => {
  const db = await openDb();
  const ids = seed(db, "hackernews", [{}, {}, {}, {}, {}]).map((r) => r.id);
  storeEmbeddings(db, {
    model: "m",
    rows: [
      { id: ids[0]!, vector: vec(1, 0, 0) }, // sim 1.0
      { id: ids[1]!, vector: vec(0.8, 0.6, 0) }, // sim 0.8
      { id: ids[2]!, vector: vec(0, 1, 0) }, // sim 0.0
      { id: ids[3]!, vector: vec(0.6, 0.8) }, // wrong dim: skipped
    ],
  });
  storeEmbeddings(db, { model: "other", rows: [{ id: ids[4]!, vector: vec(1, 0, 0) }] });

  const q = vec(1, 0, 0);
  const top = cosineTop(db, { queryVector: q, model: "m" });
  assert.deepEqual(top.map((t) => t.id), [ids[0], ids[1], ids[2]]);
  assert.ok(Math.abs(top[1]!.similarity - 0.8) < 1e-6);

  assert.deepEqual(
    cosineTop(db, { queryVector: q, model: "m", excludeId: ids[0]! }).map((t) => t.id),
    [ids[1], ids[2]]
  );
  assert.deepEqual(
    cosineTop(db, { queryVector: q, model: "m", minScore: 0.5 }).map((t) => t.id),
    [ids[0], ids[1]]
  );
  assert.deepEqual(cosineTop(db, { queryVector: q, model: "m", limit: 1 }).map((t) => t.id), [ids[0]]);
  db.close();
});

test("hybridSearch fuses FTS and vector ranks (RRF k=60), FTS rank breaks ties", async () => {
  const db = await openDb();
  const seeded = seed(db, "hackernews", [
    { externalId: "both", title: "coffee brewing guide" },
    { externalId: "fts-only", title: "coffee history" },
    { externalId: "vec-only", title: "espresso" },
  ]);
  const byExt = new Map(seeded.map((r) => [r.external_id, r.id]));
  storeEmbeddings(db, {
    model: "m",
    rows: [
      { id: byExt.get("both")!, vector: vec(1, 0) },
      { id: byExt.get("vec-only")!, vector: vec(0.9, Math.sqrt(1 - 0.81)) },
      { id: byExt.get("fts-only")!, vector: vec(0, 1) }, // below SIM_FLOOR_MIN vs query
    ],
  });

  const items = hybridSearch(db, { query: "coffee", queryVector: vec(1, 0), model: "m" });
  const order = items.map((r) => r.externalId);
  // "both" appears in both lists → highest RRF score; the two single-list
  // candidates each score 1/(60+rank) and are ordered by that.
  assert.equal(order[0], "both");
  assert.equal(order.length, 3);
  assert.deepEqual(new Set(order), new Set(["both", "fts-only", "vec-only"]));
  db.close();
});

test("hybridSearch vector arm reaches past rank 100 (deep recall, no FTS overlap)", async () => {
  const db = await openDb();
  // 105 decoy rows more similar to the query than the target, none matching
  // the FTS query — under the old CANDIDATES = 100 cap the target (vector
  // rank 106) never entered the fusion.
  const seeded = seed(db, "hackernews", [
    ...Array.from({ length: 105 }, (_, i) => ({ externalId: `decoy${i}`, title: `filler ${i}` })),
    { externalId: "target", title: "unrelated words" },
  ]);
  const byExt = new Map(seeded.map((r) => [r.external_id, r.id]));
  const withSim = (s: number) => vec(s, Math.sqrt(1 - s * s));
  storeEmbeddings(db, {
    model: "m",
    rows: [
      ...Array.from({ length: 105 }, (_, i) => ({
        id: byExt.get(`decoy${i}`)!,
        vector: withSim(0.9 - i * 0.001),
      })),
      { id: byExt.get("target")!, vector: withSim(0.5) },
    ],
  });
  const items = hybridSearch(db, { query: "coffee", queryVector: vec(1, 0), model: "m" });
  assert.ok(items.some((r) => r.externalId === "target"));
  db.close();
});

test("semanticSearch attaches similarity and applies the query-adaptive floor", async () => {
  const db = await openDb();
  const ids = seed(db, "hackernews", [{}, {}, {}]).map((r) => r.id);
  const withSim = (s: number) => vec(s, Math.sqrt(1 - s * s));
  storeEmbeddings(db, {
    model: "m",
    rows: [
      { id: ids[0]!, vector: vec(1, 0) }, // sim 1.0 → floor = min(0.35, 0.5·1.0) = 0.35
      { id: ids[1]!, vector: withSim(0.4) }, // above floor
      { id: ids[2]!, vector: withSim(0.3) }, // below floor: dropped
    ],
  });
  const items = semanticSearch(db, { queryVector: vec(1, 0), model: "m" });
  assert.deepEqual(items.map((r) => r.id), [ids[0], ids[1]]);
  assert.ok(Math.abs(items[0]!.similarity! - 1) < 1e-6);
  db.close();
});

test("semanticSearch floor relaxes below the old 0.25 when the top score is weak", async () => {
  const db = await openDb();
  const ids = seed(db, "hackernews", [{}, {}, {}]).map((r) => r.id);
  const withSim = (s: number) => vec(s, Math.sqrt(1 - s * s));
  storeEmbeddings(db, {
    model: "m",
    rows: [
      { id: ids[0]!, vector: withSim(0.3) }, // top → floor = max(0.2, 0.5·0.3) = 0.2
      { id: ids[1]!, vector: withSim(0.22) }, // kept: 0.22 ≥ 0.2 (an absolute 0.25 would cut it)
      { id: ids[2]!, vector: withSim(0.1) }, // below SIM_FLOOR_MIN: dropped
    ],
  });
  const items = semanticSearch(db, { queryVector: vec(1, 0), model: "m" });
  assert.deepEqual(items.map((r) => r.id), [ids[0], ids[1]]);
  db.close();
});

test("floor band is per-model: bge ids get the high compressed band, rank 1 always survives", async () => {
  const db = await openDb();
  const ids = seed(db, "hackernews", [{}, {}, {}]).map((r) => r.id);
  const withSim = (s: number) => vec(s, Math.sqrt(1 - s * s));
  // bge similarity scale: clamp(0.8·top, 0.55, 0.65). Top 0.7 → floor 0.56.
  storeEmbeddings(db, {
    model: "local:bge-small-en-v1.5-q8+r2",
    rows: [
      { id: ids[0]!, vector: withSim(0.7) },
      { id: ids[1]!, vector: withSim(0.6) }, // kept under bge band, would be kept under default too
      { id: ids[2]!, vector: withSim(0.5) }, // below the bge floor: dropped
    ],
  });
  const items = semanticSearch(db, { queryVector: vec(1, 0), model: "local:bge-small-en-v1.5-q8+r2" });
  assert.deepEqual(items.map((r) => r.id), [ids[0], ids[1]]);

  // A query where nothing clears the band's min comes back empty — "no good
  // matches" rather than a list of noise.
  const none = semanticSearch(db, { queryVector: vec(-1, 0), model: "local:bge-small-en-v1.5-q8+r2" });
  assert.deepEqual(none, []);
  db.close();
});

test("similar finds neighbors of an item, excluding itself; errors are explicit", async () => {
  const db = await openDb();
  const ids = seed(db, "hackernews", [{}, {}, {}]).map((r) => r.id);
  storeEmbeddings(db, {
    model: "m",
    rows: [
      { id: ids[0]!, vector: vec(1, 0) },
      { id: ids[1]!, vector: vec(0.9, Math.sqrt(1 - 0.81)) },
    ],
  });
  const items = similar(db, { id: ids[0]! });
  assert.deepEqual(items.map((r) => r.id), [ids[1]]);

  assert.throws(() => similar(db, { id: 999999 }), /No item with id/);
  assert.throws(() => similar(db, { id: ids[2]! }), /not embedded/);
  db.close();
});
