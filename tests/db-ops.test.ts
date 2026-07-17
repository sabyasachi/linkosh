import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./helpers/open-db.ts";
import {
  upsert,
  list,
  search,
  count,
  clearItems,
  knownIds,
  setDeleted,
  setStarred,
} from "../src/core/db/items.ts";
import { initSchema } from "../src/core/db/schema.ts";
import { storeEmbeddings } from "../src/core/db/embeddings.ts";
import { extractQueryFlags, ftsQuery } from "../src/core/fts.ts";
import type { ParsedItem } from "../src/core/types.ts";

const item = (externalId: string, extra: Partial<ParsedItem> = {}): ParsedItem => ({
  externalId,
  url: `https://example.com/${externalId}`,
  title: `Title ${externalId}`,
  ...extra,
});

test("upsert counts inserts vs updates", async () => {
  const db = await openDb();
  let res = upsert(db, { provider: "hackernews", account: "u", items: [item("a"), item("b")] });
  assert.deepEqual(res, { inserted: 2, updated: 0 });
  res = upsert(db, { provider: "hackernews", account: "u", items: [item("b"), item("c")] });
  assert.deepEqual(res, { inserted: 1, updated: 1 });
  assert.equal(count(db, { provider: "hackernews" }), 3);
  db.close();
});

test("upsert keeps prior bookmarked_at and published_at when the new one is null", async () => {
  const db = await openDb();
  const times = () =>
    db.rows<{ bookmarked_at: number; published_at: number }>(
      "SELECT bookmarked_at, published_at FROM saved_items"
    )[0]!;
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [item("a", { bookmarkedAt: 1111, publishedAt: 3333 })],
  });
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [item("a", { bookmarkedAt: null, publishedAt: null })],
  });
  assert.deepEqual(times(), { bookmarked_at: 1111, published_at: 3333 });
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [item("a", { bookmarkedAt: 2222, publishedAt: 4444 })],
  });
  assert.deepEqual(times(), { bookmarked_at: 2222, published_at: 4444 });
  db.close();
});

test("upsert stores 0-valued duration/bookmarkedAt/publishedAt as NULL", async () => {
  // 0 means "absent" for these numeric fields; a stored 0 would defeat the
  // COALESCE(bookmarked_at, published_at, 0) list sort and sink the row to
  // epoch 0. (Regression guard: an earlier TS port used `?? null`, persisting 0.)
  const db = await openDb();
  upsert(db, {
    provider: "substack",
    account: "u",
    items: [item("a", { duration: 0, bookmarkedAt: 0, publishedAt: 1780000000000 })],
  });
  const row = db.rows<{ duration: number | null; bookmarked_at: number | null; published_at: number | null }>(
    "SELECT duration, bookmarked_at, published_at FROM saved_items"
  )[0]!;
  assert.equal(row.duration, null);
  assert.equal(row.bookmarked_at, null); // 0 → NULL, so the sort falls through
  assert.equal(row.published_at, 1780000000000); // a real timestamp is preserved
  db.close();
});

test("upsert invalidates the embedding only when row text changes", async () => {
  const db = await openDb();
  upsert(db, { provider: "hackernews", account: "u", items: [item("a", { summary: "s" })] });
  const id = db.rows<{ id: number }>("SELECT id FROM saved_items")[0]!.id;
  storeEmbeddings(db, { model: "m1", rows: [{ id, vector: new Float32Array([1, 0]) }] });

  const embeddingRow = () =>
    db.rows<{ embedding: Uint8Array | null; embedding_model: string | null }>(
      "SELECT embedding, embedding_model FROM saved_items"
    )[0]!;

  // Same text: embedding survives the upsert.
  upsert(db, { provider: "hackernews", account: "u", items: [item("a", { summary: "s" })] });
  assert.ok(embeddingRow().embedding);
  assert.equal(embeddingRow().embedding_model, "m1");

  // Changed text: embedding nulled, row back on the backlog.
  upsert(db, { provider: "hackernews", account: "u", items: [item("a", { summary: "different" })] });
  assert.equal(embeddingRow().embedding, null);
  assert.equal(embeddingRow().embedding_model, null);
  db.close();
});

test("upsert stores stats and merges collection arrays without re-embedding", async () => {
  const db = await openDb();
  upsert(db, {
    provider: "youtube",
    account: "u",
    items: [
      item("abc123", {
        title: "A Long Video",
        collection: ["Watch later"],
        stats: { views: "1.2M views", age: "2 years ago" },
      }),
    ],
  });
  const id = db.rows<{ id: number }>("SELECT id FROM saved_items")[0]!.id;
  storeEmbeddings(db, { model: "m1", rows: [{ id, vector: new Float32Array([1, 0]) }] });

  upsert(db, {
    provider: "youtube",
    account: "u",
    items: [
      item("abc123", {
        title: "A Long Video",
        collection: ["Recipes", "Watch later"],
        stats: { views: "2M views", age: "1 year ago" },
      }),
    ],
  });

  const row = db.rows<{
    collection: string;
    stats: string;
    embedding: Uint8Array | null;
    embedding_model: string | null;
  }>("SELECT collection, stats, embedding, embedding_model FROM saved_items")[0]!;
  assert.equal(row.collection, '["Watch later","Recipes"]');
  assert.equal(row.stats, '{"views":"2M views","age":"1 year ago"}');
  assert.ok(row.embedding);
  assert.equal(row.embedding_model, "m1");

  // Decoded SavedItem carries the merged array, and the FTS column filter finds it.
  const hits = search(db, { query: 'collection:"watch later"' });
  assert.deepEqual(hits.map((r) => r.externalId), ["abc123"]);
  assert.deepEqual(hits[0]!.collection, ["Watch later", "Recipes"]);
  assert.deepEqual(hits[0]!.stats, { views: "2M views", age: "1 year ago" });
  db.close();
});

test("knownIds respects the createdBefore cutoff", async () => {
  const db = await openDb();
  const insert = (extId: string, createdAt: number) =>
    db.run(
      "INSERT INTO saved_items (provider, account, external_id, url, created_at) VALUES ('hackernews','u',?,'',?)",
      [extId, createdAt]
    );
  insert("old", 1000);
  insert("new", 2000);
  assert.deepEqual(knownIds(db, { provider: "hackernews" }).sort(), ["new", "old"]);
  assert.deepEqual(knownIds(db, { provider: "hackernews", createdBefore: 1500 }), ["old"]);
  assert.deepEqual(knownIds(db, { provider: "twitter" }), []);
  db.close();
});

test("list orders by bookmarked_at, then published_at, then created_at; paging is stable", async () => {
  const db = await openDb();
  const insert = (extId: string, bookmarkedAt: number | null, publishedAt: number | null, createdAt: number) =>
    db.run(
      `INSERT INTO saved_items
        (provider, account, external_id, url, bookmarked_at, published_at, created_at)
        VALUES ('hackernews','u',?,'',?,?,?)`,
      [extId, bookmarkedAt, publishedAt, createdAt]
    );
  insert("bookmark-late", 5000, 1000, 1); // bookmarked_at wins overall
  insert("bookmark-early", 4000, 9000, 1);
  insert("published-late", null, 3000, 1);
  insert("published-early", null, 2000, 1);
  insert("sync2-a", null, null, 200); // no timestamps: newer sync first, id asc within
  insert("sync2-b", null, null, 200);
  insert("sync1-a", null, null, 100);

  const order = list(db, {}).map((r) => r.externalId);
  assert.deepEqual(order, [
    "bookmark-late",
    "bookmark-early",
    "published-late",
    "published-early",
    "sync2-a",
    "sync2-b",
    "sync1-a",
  ]);

  const paged = [
    ...list(db, { limit: 2, offset: 0 }),
    ...list(db, { limit: 2, offset: 2 }),
    ...list(db, { limit: 2, offset: 4 }),
    ...list(db, { limit: 2, offset: 6 }),
  ].map((r) => r.externalId);
  assert.deepEqual(paged, order);
  db.close();
});

test("ftsQuery quotes plain words, adds prefix star, passes operators through", () => {
  assert.equal(ftsQuery("  "), null);
  assert.equal(ftsQuery("hello world"), '"hello" "world"*');
  assert.equal(ftsQuery('say "hi"'), 'say "hi"'); // quoted phrase: untouched
  assert.equal(ftsQuery("kind:short cats"), "kind:short cats"); // column filter: untouched
  assert.equal(ftsQuery("cats AND dogs"), "cats AND dogs");
});

test("extractQueryFlags strips is:starred anywhere in the query, case-insensitively", () => {
  assert.deepEqual(extractQueryFlags("is:starred"), { text: "", starred: true });
  assert.deepEqual(extractQueryFlags("cats is:starred dogs"), { text: "cats  dogs", starred: true });
  assert.deepEqual(extractQueryFlags("IS:STARRED rust"), { text: "rust", starred: true });
  assert.deepEqual(extractQueryFlags("kind:short"), { text: "kind:short", starred: false });
  // No accidental match inside a longer token.
  assert.deepEqual(extractQueryFlags("this:starred"), { text: "this:starred", starred: false });
});

test("search honors is:starred in the FTS arm, the LIKE fallback, and flags-only queries", async () => {
  const db = await openDb();
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [
      item("fav", { title: 'rust "unbalanced favorite' }),
      item("plain", { title: 'rust "unbalanced ordinary' }),
    ],
  });
  const id = db.rows<{ id: number }>("SELECT id FROM saved_items WHERE external_id = 'fav'")[0]!.id;
  setStarred(db, { id, starred: true });

  // FTS arm: text narrowed to starred rows.
  assert.deepEqual(search(db, { query: "rust is:starred" }).map((r) => r.externalId), ["fav"]);
  assert.equal(search(db, { query: "rust" }).length, 2);
  // Flags-only query degrades to the starred list.
  assert.deepEqual(search(db, { query: "is:starred" }).map((r) => r.externalId), ["fav"]);
  // LIKE fallback (unterminated quote breaks FTS5) applies the flag too.
  assert.deepEqual(search(db, { query: '"unbalanced is:starred' }).map((r) => r.externalId), ["fav"]);
  // Starred but deleted stays hidden.
  setDeleted(db, { id, deleted: true });
  assert.deepEqual(search(db, { query: "rust is:starred" }), []);
  db.close();
});

test("search: plain text, prefix-as-you-type, column filter, provider scope", async () => {
  const db = await openDb();
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [
      item("1", { title: "Rust in production", kind: "story" }),
      item("2", { title: "Cooking with cast iron", kind: "story" }),
    ],
  });
  upsert(db, {
    provider: "youtube",
    account: "u",
    items: [item("3", { title: "Rust tutorial", kind: "short" })],
  });
  upsert(db, {
    provider: "linkedin",
    account: "u",
    items: [
      item("4", {
        title: "",
        posterName: "Jane Doe",
        posterHandle: "jane",
        posterBio: "Distributed systems engineer",
      }),
    ],
  });

  assert.deepEqual(search(db, { query: "rust" }).map((r) => r.externalId).sort(), ["1", "3"]);
  // last word acts as a prefix
  assert.equal(search(db, { query: "cook" }).length, 1);
  // provider scoping
  assert.deepEqual(search(db, { provider: "youtube", query: "rust" }).map((r) => r.externalId), ["3"]);
  // FTS column filter passes through
  assert.deepEqual(search(db, { query: "kind:short" }).map((r) => r.externalId), ["3"]);
  assert.deepEqual(search(db, { query: "poster_handle:jane" }).map((r) => r.externalId), ["4"]);
  // poster_bio is structured display data, not search/ranking content.
  assert.deepEqual(search(db, { query: "distributed systems engineer" }), []);
  // empty query lists everything
  assert.equal(search(db, { query: "  " }).length, 4);
  db.close();
});

test("search falls back to a LIKE scan when the FTS query does not parse", async () => {
  const db = await openDb();
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [item("1", { summary: 'he said "unbalanced things' })],
  });
  // Unterminated quote: passes the operator check, breaks FTS5, LIKE catches it.
  const hits = search(db, { query: '"unbalanced' });
  assert.deepEqual(hits.map((r) => r.externalId), ["1"]);
  db.close();
});

test("count scopes by provider or spans all", async () => {
  const db = await openDb();
  upsert(db, { provider: "hackernews", account: "u", items: [item("1"), item("2")] });
  upsert(db, { provider: "youtube", account: "u", items: [item("3")] });
  assert.equal(count(db, { provider: "hackernews" }), 2);
  assert.equal(count(db, {}), 3);
  assert.equal(count(db), 3);
  db.close();
});

test("setDeleted hides an item from list/search/count; the trash lists it; restore reverses", async () => {
  const db = await openDb();
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [item("a", { title: 'hidden "unbalanced gem' }), item("b")],
  });
  const id = db.rows<{ id: number }>("SELECT id FROM saved_items WHERE external_id = 'a'")[0]!.id;

  assert.deepEqual(setDeleted(db, { id, deleted: true }), { changed: 1 });
  assert.deepEqual(list(db, {}).map((r) => r.externalId), ["b"]);
  assert.equal(count(db, {}), 1);
  // FTS arm: the row is still in the FTS index (the update trigger re-added
  // it), so the filter on the joined saved_items row must catch it.
  assert.equal(search(db, { query: "hidden" }).length, 0);
  // LIKE fallback arm (unterminated quote breaks FTS5) filters too.
  assert.equal(search(db, { query: '"unbalanced' }).length, 0);

  const trash = list(db, { deleted: true });
  assert.deepEqual(trash.map((r) => r.externalId), ["a"]);
  assert.ok(trash[0]!.deletedAt! > 0);
  assert.equal(count(db, { deleted: true }), 1);
  // The deleted item stays known — sync's stop rule must not re-fetch it as new.
  assert.deepEqual(knownIds(db, { provider: "hackernews" }).sort(), ["a", "b"]);

  assert.deepEqual(setDeleted(db, { id, deleted: false }), { changed: 1 });
  assert.equal(count(db, {}), 2);
  assert.equal(list(db, { deleted: true }).length, 0);
  assert.equal(search(db, { query: "hidden" }).length, 1);
  assert.equal(list(db, {})[1]!.deletedAt, null);

  assert.deepEqual(setDeleted(db, { id: 999999, deleted: true }), { changed: 0 });
  db.close();
});

test("upsert refreshes a deleted item's fields without resurrecting it", async () => {
  const db = await openDb();
  upsert(db, { provider: "substack", account: "u", items: [item("a")] });
  const id = db.rows<{ id: number }>("SELECT id FROM saved_items")[0]!.id;
  setDeleted(db, { id, deleted: true });
  const before = db.rows<{ deleted_at: number }>("SELECT deleted_at FROM saved_items")[0]!.deleted_at;

  // The item is still saved on the service: every incremental sync re-upserts it.
  upsert(db, { provider: "substack", account: "u", items: [item("a", { title: "refreshed" })] });
  const row = db.rows<{ title: string; deleted_at: number | null }>(
    "SELECT title, deleted_at FROM saved_items"
  )[0]!;
  assert.equal(row.title, "refreshed");
  assert.equal(row.deleted_at, before); // deleted_at untouched by the SET list
  assert.equal(count(db, {}), 0);
  db.close();
});

test("initSchema adds deleted_at/starred_at to a DB created before them, idempotently", async () => {
  const db = await openDb();
  const hasColumn = (name: string) =>
    db.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pragma_table_info('saved_items') WHERE name = ?",
      [name]
    )[0]!.n;
  // Simulate a pre-column OPFS DB (nothing else references these columns).
  db.exec("ALTER TABLE saved_items DROP COLUMN deleted_at");
  db.exec("ALTER TABLE saved_items DROP COLUMN starred_at");
  assert.equal(hasColumn("deleted_at"), 0);
  assert.equal(hasColumn("starred_at"), 0);
  initSchema(db);
  assert.equal(hasColumn("deleted_at"), 1);
  assert.equal(hasColumn("starred_at"), 1);
  initSchema(db); // re-init on an up-to-date DB is a no-op
  assert.equal(hasColumn("deleted_at"), 1);
  db.close();
});

test("setStarred filters list/count, composes with deleted, survives upsert refresh", async () => {
  const db = await openDb();
  upsert(db, { provider: "hackernews", account: "u", items: [item("a"), item("b"), item("c")] });
  const idOf = (extId: string) =>
    db.rows<{ id: number }>("SELECT id FROM saved_items WHERE external_id = ?", [extId])[0]!.id;

  assert.deepEqual(setStarred(db, { id: idOf("a"), starred: true }), { changed: 1 });
  setStarred(db, { id: idOf("b"), starred: true });

  // Starring hides nothing from the main list; the starred filter narrows it.
  assert.equal(list(db, {}).length, 3);
  assert.deepEqual(list(db, { starred: true }).map((r) => r.externalId).sort(), ["a", "b"]);
  assert.equal(count(db, { starred: true }), 2);
  assert.ok(list(db, { starred: true })[0]!.starredAt! > 0);

  // A starred item in the trash belongs to the trash, not the starred view.
  setDeleted(db, { id: idOf("a"), deleted: true });
  assert.deepEqual(list(db, { starred: true }).map((r) => r.externalId), ["b"]);
  assert.equal(count(db, { starred: true }), 1);
  // Restore: the star was kept.
  setDeleted(db, { id: idOf("a"), deleted: false });
  assert.equal(count(db, { starred: true }), 2);

  // Re-sync refresh must not unstar (starred_at is outside upsert's SET list).
  upsert(db, { provider: "hackernews", account: "u", items: [item("a", { title: "refreshed" })] });
  assert.equal(count(db, { starred: true }), 2);

  assert.deepEqual(setStarred(db, { id: idOf("a"), starred: false }), { changed: 1 });
  assert.deepEqual(list(db, { starred: true }).map((r) => r.externalId), ["b"]);
  db.close();
});

test("clearItems counts soft-deleted rows in its return and removes them", async () => {
  const db = await openDb();
  upsert(db, { provider: "hackernews", account: "u", items: [item("1"), item("2")] });
  const id = db.rows<{ id: number }>("SELECT id FROM saved_items WHERE external_id = '1'")[0]!.id;
  setDeleted(db, { id, deleted: true });
  assert.deepEqual(clearItems(db), { deleted: 2 }); // live count alone would say 1
  assert.equal(count(db, { deleted: true }), 0);
  db.close();
});

test("clearItems deletes rows, keeps FTS consistent, can scope by provider", async () => {
  const db = await openDb();
  upsert(db, {
    provider: "hackernews",
    account: "u",
    items: [item("1", { title: "keep me hn" }), item("2")],
  });
  upsert(db, { provider: "youtube", account: "u", items: [item("3", { title: "keep me yt" })] });

  assert.deepEqual(clearItems(db, { provider: "hackernews" }), { deleted: 2 });
  assert.equal(count(db), 1);
  // FTS triggers kept the index in step — deleted rows no longer match.
  assert.equal(search(db, { query: "keep" }).length, 1);

  assert.deepEqual(clearItems(db), { deleted: 1 });
  assert.equal(count(db), 0);
  assert.equal(search(db, { query: "keep" }).length, 0);
  db.close();
});
