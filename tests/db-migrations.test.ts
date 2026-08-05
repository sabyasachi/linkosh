import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseMigrationError, DatabaseVersionError } from "../src/core/errors.ts";
import {
  CURRENT_DATABASE_VERSION,
  initializeDatabase,
  initializeDatabaseWithRegistry,
  readDatabaseVersion,
  type Migration,
} from "../src/core/db/migrations.ts";
import type { SqlDatabase, SqlValue } from "../src/core/db/port.ts";
import { wasmDb, type WasmSqlDatabase } from "../src/core/db/wasm.ts";
import { gateDbWorkerHandlers, type DbWorkerApi } from "../src/core/db/service.ts";
import type { Handlers } from "../src/core/rpc/protocol.ts";
import { search } from "../src/core/db/items.ts";
import { loadSqlite3 } from "./helpers/open-db.ts";
import { openDbFile } from "../src/node/node-db.ts";

async function emptyDb(): Promise<WasmSqlDatabase> {
  const sqlite3 = await loadSqlite3();
  return wasmDb(new sqlite3.oo1.DB(":memory:"));
}

// Historical fixtures are deliberately independent of both the live schema
// and the frozen production adoption constants. They model deployed v0 DDL.
const HISTORICAL_SAVED_COLUMNS: Record<string, string> = {
  id: "id INTEGER PRIMARY KEY",
  provider: "provider TEXT NOT NULL",
  account: "account TEXT NOT NULL",
  external_id: "external_id TEXT NOT NULL",
  url: "url TEXT NOT NULL",
  title: "title TEXT",
  publication: "publication TEXT",
  summary: "summary TEXT",
  image: "image TEXT",
  kind: "kind TEXT NOT NULL DEFAULT ''",
  duration: "duration INTEGER",
  collection: "collection TEXT NOT NULL DEFAULT '[]'",
  poster_name: "poster_name TEXT NOT NULL DEFAULT ''",
  poster_handle: "poster_handle TEXT NOT NULL DEFAULT ''",
  poster_bio: "poster_bio TEXT NOT NULL DEFAULT ''",
  stats: "stats TEXT NOT NULL DEFAULT '{}'",
  bookmarked_at: "bookmarked_at INTEGER",
  published_at: "published_at INTEGER",
  created_at: "created_at INTEGER NOT NULL",
  sort_key: "sort_key INTEGER",
  deleted_at: "deleted_at INTEGER",
  starred_at: "starred_at INTEGER",
  embedding: "embedding BLOB",
  embedding_model: "embedding_model TEXT",
};

const HISTORICAL_RAW_SCHEMA = `
  CREATE TABLE raw_data (
    id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'items', url TEXT NOT NULL DEFAULT '',
    page INTEGER NOT NULL DEFAULT 0, context TEXT, body TEXT NOT NULL,
    external_ids TEXT NOT NULL DEFAULT '[]', fetched_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', ingested_at INTEGER, error TEXT
  );
  CREATE INDEX raw_data_status ON raw_data (status, provider, id);
`;

const HISTORICAL_FTS_SCHEMA = `
  CREATE VIRTUAL TABLE saved_items_fts USING fts5(
    title, publication, summary, collection, kind, poster_name, poster_handle,
    content='saved_items', content_rowid='id'
  );
  CREATE TRIGGER saved_items_ai AFTER INSERT ON saved_items BEGIN
    INSERT INTO saved_items_fts(rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES (new.id, new.title, new.publication, new.summary, new.collection, new.kind, new.poster_name, new.poster_handle);
  END;
  CREATE TRIGGER saved_items_ad AFTER DELETE ON saved_items BEGIN
    INSERT INTO saved_items_fts(saved_items_fts, rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES ('delete', old.id, old.title, old.publication, old.summary, old.collection, old.kind, old.poster_name, old.poster_handle);
  END;
  CREATE TRIGGER saved_items_au AFTER UPDATE ON saved_items BEGIN
    INSERT INTO saved_items_fts(saved_items_fts, rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES ('delete', old.id, old.title, old.publication, old.summary, old.collection, old.kind, old.poster_name, old.poster_handle);
    INSERT INTO saved_items_fts(rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES (new.id, new.title, new.publication, new.summary, new.collection, new.kind, new.poster_name, new.poster_handle);
  END;
`;

function createHistoricalSchema(
  db: SqlDatabase,
  options: { omit?: readonly string[]; raw?: boolean; fts?: boolean } = {}
): void {
  const omitted = new Set(options.omit ?? []);
  const columns = Object.entries(HISTORICAL_SAVED_COLUMNS)
    .filter(([name]) => !omitted.has(name))
    .map(([, ddl]) => ddl);
  db.exec(`CREATE TABLE saved_items (${columns.join(",")}, UNIQUE (provider, account, external_id));`);
  if (options.raw !== false) db.exec(HISTORICAL_RAW_SCHEMA);
  if (options.fts !== false) db.exec(HISTORICAL_FTS_SCHEMA);
}

function insertRepresentativeData(db: SqlDatabase): void {
  db.run(
    `INSERT INTO saved_items (
       id, provider, account, external_id, url, title, publication, summary, image,
       kind, duration, collection, poster_name, poster_handle, poster_bio, stats,
       bookmarked_at, published_at, created_at, sort_key, deleted_at, starred_at,
       embedding, embedding_model
     ) VALUES (${Array.from({ length: 24 }, () => "?").join(",")})`,
    [
      42,
      "youtube",
      "owner@example.com",
      "video-42",
      "https://example.com/video-42",
      "Migration astronomy",
      "Example channel",
      "A preserved summary",
      "https://example.com/image.jpg",
      "video",
      123,
      '["Watch later","Research"]',
      "Jane Doe",
      "@jane",
      "Space educator",
      '{"views":"10K"}',
      null,
      1_700_000_000_000,
      1_700_000_000_100,
      99,
      null,
      1_700_000_000_200,
      new Uint8Array([0, 0, 128, 63, 0, 0, 0, 0]),
      "local:test+r1",
    ]
  );
  db.run(
    `INSERT INTO raw_data
       (id, provider, account, kind, url, page, context, body, external_ids,
        fetched_at, status, ingested_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      7,
      "youtube",
      "owner@example.com",
      "items",
      "https://example.com/feed",
      3,
      '{"playlistId":"WL"}',
      "verbatim raw body \u0000 preserved",
      '["video-42"]',
      1_700_000_000_300,
      "failed",
      null,
      "fixture parse error",
    ]
  );
}

function directSavedRow(db: SqlDatabase): Record<string, SqlValue> {
  return db.rows<Record<string, SqlValue>>("SELECT * FROM saved_items WHERE id = 42")[0]!;
}

function directRawRow(db: SqlDatabase): Record<string, SqlValue> {
  return db.rows<Record<string, SqlValue>>("SELECT * FROM raw_data WHERE id = 7")[0]!;
}

test("fresh database creates canonical schema and stores version 1", async () => {
  const db = await emptyDb();
  const result = initializeDatabase(db);
  assert.deepEqual(result, {
    fromVersion: 0,
    toVersion: CURRENT_DATABASE_VERSION,
    applied: [],
    created: true,
    adopted: false,
  });
  assert.equal(readDatabaseVersion(db), 1);
  assert.equal(db.rows("SELECT * FROM saved_items").length, 0);
  assert.equal(db.rows("SELECT * FROM raw_data").length, 0);
  db.close();
});

test("version-0 adoption preserves representative user and archive values", async () => {
  const db = await emptyDb();
  createHistoricalSchema(db);
  insertRepresentativeData(db);
  const savedBefore = directSavedRow(db);
  const rawBefore = directRawRow(db);
  assert.equal(search(db, { query: "astronomy" }).length, 1);
  assert.equal(search(db, { query: "collection:Research" }).length, 1);

  const result = initializeDatabase(db);
  assert.equal(result.adopted, true);
  assert.deepEqual(result.applied, [{ version: 1, name: "adopt unversioned database" }]);
  assert.deepEqual(directSavedRow(db), savedBefore);
  assert.deepEqual(directRawRow(db), rawBefore);
  assert.equal(search(db, { query: "astronomy" }).length, 1);
  assert.equal(search(db, { query: "collection:Research" }).length, 1);
  db.close();
});

test("version-0 adoption repairs every known additive-column variant", async () => {
  const variants = [["deleted_at"], ["starred_at"], ["sort_key"], ["deleted_at", "starred_at", "sort_key"]];
  for (const omit of variants) {
    const db = await emptyDb();
    createHistoricalSchema(db, { omit });
    initializeDatabase(db);
    const columns = new Set(
      db.rows<{ name: string }>("SELECT name FROM pragma_table_info('saved_items')").map((row) => row.name)
    );
    for (const name of ["deleted_at", "starred_at", "sort_key"]) assert.ok(columns.has(name));
    db.close();
  }
});

test("adoption creates missing raw objects without replacing saved_items", async () => {
  const db = await emptyDb();
  createHistoricalSchema(db, { raw: false });
  db.run(
    "INSERT INTO saved_items (id, provider, account, external_id, url, created_at) VALUES (42, 'hackernews', 'u', 'x', 'https://x', 1)"
  );
  initializeDatabase(db);
  assert.equal(db.rows<{ id: number }>("SELECT id FROM saved_items")[0]!.id, 42);
  assert.equal(
    db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'raw_data_status'")[0]!.n,
    1
  );
  db.close();

  const missingIndex = await emptyDb();
  createHistoricalSchema(missingIndex);
  missingIndex.exec("DROP INDEX raw_data_status");
  initializeDatabase(missingIndex);
  assert.equal(
    missingIndex.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'index' AND name = 'raw_data_status'"
    )[0]!.n,
    1
  );
  missingIndex.close();
});

test("missing FTS is rebuilt, while an existing FTS index is not rebuilt merely for adoption", async () => {
  const missing = await emptyDb();
  createHistoricalSchema(missing, { fts: false });
  missing.run(
    "INSERT INTO saved_items (provider, account, external_id, url, title, created_at) VALUES ('hackernews','u','a','https://a','nebula telescope',1)"
  );
  initializeDatabase(missing);
  assert.equal(search(missing, { query: "nebula" }).length, 1);
  missing.close();

  const existing = await emptyDb();
  createHistoricalSchema(existing);
  existing.run(
    "INSERT INTO saved_items (provider, account, external_id, url, title, created_at) VALUES ('hackernews','u','a','https://a','uniqueadoptiontoken',1)"
  );
  existing.exec(
    `INSERT INTO saved_items_fts(saved_items_fts, rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
     SELECT 'delete', id, title, publication, summary, collection, kind, poster_name, poster_handle FROM saved_items`
  );
  assert.equal(search(existing, { query: "uniqueadoptiontoken" }).length, 0);
  initializeDatabase(existing);
  assert.equal(search(existing, { query: "uniqueadoptiontoken" }).length, 0);
  existing.close();
});

test("reopening a current database is a no-op", async () => {
  const db = await emptyDb();
  initializeDatabase(db);
  db.run(
    "INSERT INTO saved_items (provider, account, external_id, url, title, created_at) VALUES ('substack','u','a','https://a','unchanged',1)"
  );
  const schemaBefore = db.rows("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name");
  const dataBefore = db.rows("SELECT * FROM saved_items");
  const result = initializeDatabase(db);
  assert.deepEqual(result.applied, []);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.toVersion, 1);
  assert.deepEqual(db.rows("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name"), schemaBefore);
  assert.deepEqual(db.rows("SELECT * FROM saved_items"), dataBefore);
  db.close();
});

test("invalid, newer, and inconsistent versions fail without mutation", async () => {
  let execs = 0;
  const invalidDb = {
    rows: () => [{ user_version: -1 }],
    exec: () => execs++,
  } as unknown as SqlDatabase;
  assert.throws(() => readDatabaseVersion(invalidDb), DatabaseVersionError);
  assert.equal(execs, 0);

  const newer = await emptyDb();
  initializeDatabase(newer);
  newer.exec("PRAGMA user_version = 2");
  const before = newer.rows("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name");
  assert.throws(() => initializeDatabase(newer), DatabaseVersionError);
  assert.deepEqual(newer.rows("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name"), before);
  assert.equal(readDatabaseVersion(newer), 2);
  newer.close();

  const inconsistent = await emptyDb();
  inconsistent.exec("PRAGMA user_version = 1");
  assert.throws(() => initializeDatabase(inconsistent), DatabaseVersionError);
  assert.deepEqual(inconsistent.rows("SELECT name FROM sqlite_schema WHERE type = 'table'"), []);
  assert.equal(readDatabaseVersion(inconsistent), 1);
  inconsistent.close();
});

test("version reader rejects missing, multiple, fractional, negative, and oversized values", () => {
  for (const rows of [
    [],
    [{ user_version: 0 }, { user_version: 0 }],
    [{ user_version: 1.5 }],
    [{ user_version: -1 }],
    [{ user_version: 2_147_483_648 }],
    [{}],
  ]) {
    const db = { rows: () => rows } as unknown as SqlDatabase;
    assert.throws(() => readDatabaseVersion(db), DatabaseVersionError);
  }
});

test("registry validation rejects duplicates, gaps, and unordered versions", () => {
  const noop = (version: number): Migration => ({ version, name: `v${version}`, up() {} });
  const db = {} as SqlDatabase; // validation happens before any database access
  for (const migrations of [
    [noop(2), noop(2)],
    [noop(2), noop(4)],
    [noop(3), noop(2)],
  ]) {
    assert.throws(() => initializeDatabaseWithRegistry(db, 3, migrations), DatabaseVersionError);
  }
});

test("synthetic skipped-version history runs each step once and in order", async () => {
  const db = await emptyDb();
  initializeDatabase(db);
  const order: number[] = [];
  const migrations: Migration[] = [
    {
      version: 2,
      name: "add synthetic table",
      up(database) {
        order.push(2);
        database.exec("CREATE TABLE synthetic (id INTEGER PRIMARY KEY, value TEXT)");
      },
    },
    {
      version: 3,
      name: "populate synthetic table",
      up(database) {
        order.push(3);
        database.run("INSERT INTO synthetic (value) VALUES (?)", ["landed"]);
      },
    },
  ];
  const result = initializeDatabaseWithRegistry(db, 3, migrations);
  assert.deepEqual(order, [2, 3]);
  assert.equal(readDatabaseVersion(db), 3);
  assert.equal(db.rows<{ value: string }>("SELECT value FROM synthetic")[0]!.value, "landed");
  initializeDatabaseWithRegistry(db, 3, migrations);
  assert.deepEqual(order, [2, 3]);
  assert.deepEqual(result.applied.map((step) => step.version), [2, 3]);
  db.close();
});

test("failed synthetic step rolls back DDL/DML and retries from the prior commit", async () => {
  const db = await emptyDb();
  initializeDatabase(db);
  let v2Runs = 0;
  let v3Runs = 0;
  let failV3 = true;
  const migrations: Migration[] = [
    {
      version: 2,
      name: "durable first step",
      up(database) {
        v2Runs++;
        database.exec("CREATE TABLE durable_step (value TEXT)");
        database.run("INSERT INTO durable_step VALUES ('kept')");
      },
    },
    {
      version: 3,
      name: "retryable second step",
      up(database) {
        v3Runs++;
        database.exec("CREATE TABLE retryable_step (value TEXT)");
        database.run("INSERT INTO retryable_step VALUES ('rolled back once')");
        if (failV3) throw new Error("injected failure");
      },
    },
  ];
  assert.throws(
    () => initializeDatabaseWithRegistry(db, 3, migrations),
    (error) => error instanceof DatabaseMigrationError && error.fromVersion === 2 && error.toVersion === 3
  );
  assert.equal(readDatabaseVersion(db), 2);
  assert.equal(db.rows("SELECT * FROM durable_step").length, 1);
  assert.equal(
    db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'retryable_step'")[0]!.n,
    0
  );
  failV3 = false;
  initializeDatabaseWithRegistry(db, 3, migrations);
  assert.equal(readDatabaseVersion(db), 3);
  assert.equal(v2Runs, 1);
  assert.equal(v3Runs, 2);
  assert.equal(db.rows("SELECT * FROM retryable_step").length, 1);
  db.close();
});

interface ColumnShape {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function normalizedColumns(db: SqlDatabase, table: string): ColumnShape[] {
  return db
    .rows<ColumnShape>(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`, [table])
    .sort((a, b) => a.name.localeCompare(b.name));
}

function namedObjects(db: SqlDatabase): { type: string; name: string }[] {
  return db.rows<{ type: string; name: string }>(
    `SELECT type, name FROM sqlite_schema
     WHERE name IN ('saved_items','raw_data','saved_items_fts','raw_data_status',
                    'saved_items_ai','saved_items_ad','saved_items_au')
     ORDER BY type, name`
  );
}

function assertRepositoryBehavior(db: SqlDatabase): void {
  db.run(
    `INSERT INTO saved_items
       (provider, account, external_id, url, title, summary, kind, collection, created_at)
     VALUES ('substack','u','equivalence','https://equivalence','Equivalence title',
             'behavior token','article','["Reading"]',123)`
  );
  assert.equal(search(db, { query: "behavior" }).length, 1);
  assert.equal(search(db, { query: "kind:article" }).length, 1);
  db.run("UPDATE saved_items SET summary = 'updated token' WHERE external_id = 'equivalence'");
  assert.equal(search(db, { query: "updated" }).length, 1);
  db.run("DELETE FROM saved_items WHERE external_id = 'equivalence'");
  assert.equal(search(db, { query: "updated" }).length, 0);
}

test("fresh and adopted schemas are normalized-equivalent and behave identically", async () => {
  const fresh = await emptyDb();
  initializeDatabase(fresh);
  const adopted = await emptyDb();
  createHistoricalSchema(adopted, { omit: ["deleted_at", "starred_at", "sort_key"] });
  initializeDatabase(adopted);

  for (const table of ["saved_items", "raw_data", "saved_items_fts"]) {
    assert.deepEqual(normalizedColumns(adopted, table), normalizedColumns(fresh, table));
  }
  assert.deepEqual(namedObjects(adopted), namedObjects(fresh));
  const indexSql = "SELECT seqno, name FROM pragma_index_info('raw_data_status') ORDER BY seqno";
  assert.deepEqual(adopted.rows(indexSql), fresh.rows(indexSql));
  assertRepositoryBehavior(fresh);
  assertRepositoryBehavior(adopted);
  fresh.close();
  adopted.close();
});

test("disk-backed opener mutates only in explicit migrate mode and preserves rollback boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkosh-migrations-"));
  const file = join(dir, "db.sqlite");
  try {
    const fresh = openDbFile(file, { schema: "migrate" });
    assert.equal(fresh.migration!.created, true);
    assert.equal(readDatabaseVersion(fresh), 1);
    fresh.exec("PRAGMA user_version = 0");
    fresh.close();

    const bytesBeforeInspect = readFileSync(file);
    const inspected = openDbFile(file, { schema: "inspect", readOnly: true });
    assert.equal(inspected.migration, null);
    assert.equal(readDatabaseVersion(inspected), 0);
    inspected.close();
    assert.deepEqual(readFileSync(file), bytesBeforeInspect);

    const adopted = openDbFile(file, { schema: "migrate" });
    assert.equal(adopted.migration!.adopted, true);
    assert.equal(readDatabaseVersion(adopted), 1);

    const migrations: Migration[] = [
      {
        version: 2,
        name: "disk commit",
        up(db) {
          db.exec("CREATE TABLE disk_committed (value TEXT)");
          db.run("INSERT INTO disk_committed VALUES ('kept')");
        },
      },
      {
        version: 3,
        name: "disk rollback",
        up(db) {
          db.exec("CREATE TABLE disk_rolled_back (value TEXT)");
          db.run("INSERT INTO disk_rolled_back VALUES ('nope')");
          throw new Error("injected disk failure");
        },
      },
    ];
    assert.throws(() => initializeDatabaseWithRegistry(adopted, 3, migrations), DatabaseMigrationError);
    assert.equal(readDatabaseVersion(adopted), 2);
    assert.equal(adopted.rows("SELECT * FROM disk_committed").length, 1);
    assert.equal(
      adopted.rows<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'disk_rolled_back'")[0]!.n,
      0
    );
    adopted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed tool call sites explicitly select inspect or migrate mode", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(source("../src/node/tools/ingest.ts"), /openDbFile\(target, \{ schema: "migrate" \}\)/);
  assert.match(source("../src/node/tools/ux-server.ts"), /openDbFile\(dbFile, \{ schema: "migrate" \}\)/);
  assert.match(source("../src/node/tools/compare-sqlite.ts"), /schema: "inspect", readOnly: true/);
  assert.match(source("../src/node/tools/capture-fixtures.ts"), /schema: "inspect", readOnly: true/);
});

test("worker handler gate keeps export available when migration fails", async () => {
  let rejectMigration!: (reason: unknown) => void;
  const migration = new Promise<Handlers<DbWorkerApi>>((_resolve, reject) => {
    rejectMigration = reject;
  });
  const exportOnly = {
    export: () => ({ file: "recovery.sqlite", size: 123 }),
  } as Pick<Handlers<DbWorkerApi>, "export">;
  const handlers = gateDbWorkerHandlers(Promise.resolve(exportOnly), migration);
  assert.deepEqual(await handlers.export({}), { file: "recovery.sqlite", size: 123 });
  rejectMigration(new DatabaseVersionError("newer database"));
  await assert.rejects(async () => handlers.count({}), DatabaseVersionError);
});
