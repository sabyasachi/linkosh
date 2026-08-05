// Versioned database initialization and migration runner. New databases are
// created from the canonical latest schema; deployed unversioned databases
// are first adopted through the independent, permanently frozen v1 SQL below.
import { DatabaseMigrationError, DatabaseVersionError } from "../errors.ts";
import type { SqlDatabase, SqlValue } from "./port.ts";
import { createLatestSchema } from "./schema.ts";

export const CURRENT_DATABASE_VERSION = 1;
const MAX_DATABASE_VERSION = 2_147_483_647;

export interface Migration {
  /** Target version after this migration commits. */
  version: number;
  name: string;
  up(db: SqlDatabase): void;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: ReadonlyArray<{ version: number; name: string }>;
  created: boolean;
  adopted: boolean;
}

const MIGRATIONS: readonly Migration[] = [
  // The first future persisted change targets version 2.
];

const V1_ADOPTION_NAME = "adopt unversioned database";

// Frozen version-1 adoption SQL. This must never import, interpolate, or alias
// SCHEMA/FTS_SCHEMA: later canonical-schema edits must not change the path an
// unversioned deployed database takes before numbered migrations 2, 3, ... .
const V1_RAW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS raw_data (
    id           INTEGER PRIMARY KEY,
    provider     TEXT NOT NULL,
    account      TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'items',
    url          TEXT NOT NULL DEFAULT '',
    page         INTEGER NOT NULL DEFAULT 0,
    context      TEXT,
    body         TEXT NOT NULL,
    external_ids TEXT NOT NULL DEFAULT '[]',
    fetched_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    ingested_at  INTEGER,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS raw_data_status ON raw_data (status, provider, id);
`;

const V1_FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS saved_items_fts USING fts5(
    title, publication, summary, collection, kind, poster_name, poster_handle,
    content='saved_items', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS saved_items_ai AFTER INSERT ON saved_items BEGIN
    INSERT INTO saved_items_fts(rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES (new.id, new.title, new.publication, new.summary, new.collection, new.kind, new.poster_name, new.poster_handle);
  END;

  CREATE TRIGGER IF NOT EXISTS saved_items_ad AFTER DELETE ON saved_items BEGIN
    INSERT INTO saved_items_fts(saved_items_fts, rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES ('delete', old.id, old.title, old.publication, old.summary, old.collection, old.kind, old.poster_name, old.poster_handle);
  END;

  CREATE TRIGGER IF NOT EXISTS saved_items_au AFTER UPDATE ON saved_items BEGIN
    INSERT INTO saved_items_fts(saved_items_fts, rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES ('delete', old.id, old.title, old.publication, old.summary, old.collection, old.kind, old.poster_name, old.poster_handle);
    INSERT INTO saved_items_fts(rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES (new.id, new.title, new.publication, new.summary, new.collection, new.kind, new.poster_name, new.poster_handle);
  END;
`;

const SAVED_ITEMS_V1_COLUMNS = [
  "id",
  "provider",
  "account",
  "external_id",
  "url",
  "title",
  "publication",
  "summary",
  "image",
  "kind",
  "duration",
  "collection",
  "poster_name",
  "poster_handle",
  "poster_bio",
  "stats",
  "bookmarked_at",
  "published_at",
  "created_at",
  "sort_key",
  "deleted_at",
  "starred_at",
  "embedding",
  "embedding_model",
] as const;

const RAW_DATA_V1_COLUMNS = [
  "id",
  "provider",
  "account",
  "kind",
  "url",
  "page",
  "context",
  "body",
  "external_ids",
  "fetched_at",
  "status",
  "ingested_at",
  "error",
] as const;

const FTS_V1_COLUMNS = [
  "title",
  "publication",
  "summary",
  "collection",
  "kind",
  "poster_name",
  "poster_handle",
] as const;

function versionNumber(value: SqlValue | undefined): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof numeric !== "number" ||
    !Number.isInteger(numeric) ||
    numeric < 0 ||
    numeric > MAX_DATABASE_VERSION
  ) {
    throw new DatabaseVersionError(
      `Invalid database version; expected an integer from 0 through ${MAX_DATABASE_VERSION}.`
    );
  }
  return numeric;
}

export function readDatabaseVersion(db: SqlDatabase): number {
  const rows = db.rows<{ user_version?: SqlValue }>("PRAGMA user_version");
  if (rows.length !== 1 || !("user_version" in rows[0]!)) {
    throw new DatabaseVersionError("Invalid database version metadata returned by SQLite.");
  }
  return versionNumber(rows[0]!.user_version);
}

function setDatabaseVersion(db: SqlDatabase, version: number): void {
  // PRAGMA does not accept a bound value. This integer reaches interpolation
  // only after registry/adoption validation; no runtime/provider value can.
  const safeVersion = versionNumber(version);
  db.exec(`PRAGMA user_version = ${safeVersion}`);
}

function objectExists(db: SqlDatabase, type: "table" | "index" | "trigger", name: string): boolean {
  return db.rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = ? AND name = ?",
    [type, name]
  )[0]?.n === 1;
}

function applicationTables(db: SqlDatabase): string[] {
  return db
    .rows<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    .map((row) => row.name);
}

function columnNames(db: SqlDatabase, table: string): Set<string> {
  return new Set(
    db.rows<{ name: string }>("SELECT name FROM pragma_table_info(?)", [table]).map((row) => row.name)
  );
}

function requireColumns(db: SqlDatabase, table: string, required: readonly string[]): void {
  if (!objectExists(db, "table", table)) {
    throw new DatabaseVersionError(`Database schema version 1 is missing required table ${table}.`);
  }
  const columns = columnNames(db, table);
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length) {
    throw new DatabaseVersionError(
      `Database schema version 1 table ${table} is missing required columns: ${missing.join(", ")}.`
    );
  }
}

function validateVersion1(db: SqlDatabase): void {
  requireColumns(db, "saved_items", SAVED_ITEMS_V1_COLUMNS);
  requireColumns(db, "raw_data", RAW_DATA_V1_COLUMNS);
  requireColumns(db, "saved_items_fts", FTS_V1_COLUMNS);

  const ftsSql = db.rows<{ sql: string | null }>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'saved_items_fts'"
  )[0]?.sql;
  if (!ftsSql || !/^CREATE\s+VIRTUAL\s+TABLE\b/i.test(ftsSql) || !/\bUSING\s+fts5\s*\(/i.test(ftsSql)) {
    throw new DatabaseVersionError("Database schema version 1 saved_items_fts is not an FTS5 virtual table.");
  }

  const hasIdentityIndex = db
    .rows<{ name: string; unique: number }>(
      `SELECT name, "unique" FROM pragma_index_list('saved_items') ORDER BY seq`
    )
    .some((index) => {
      if (index.unique !== 1) return false;
      const columns = db
        .rows<{ name: string }>("SELECT name FROM pragma_index_info(?) ORDER BY seqno", [index.name])
        .map((row) => row.name);
      return columns.join(",") === "provider,account,external_id";
    });
  if (!hasIdentityIndex) {
    throw new DatabaseVersionError(
      "Database schema version 1 is missing the saved_items provider/account/external_id identity constraint."
    );
  }

  if (!objectExists(db, "index", "raw_data_status")) {
    throw new DatabaseVersionError("Database schema version 1 is missing required index raw_data_status.");
  }
  const indexColumns = db
    .rows<{ name: string }>("SELECT name FROM pragma_index_info('raw_data_status') ORDER BY seqno")
    .map((row) => row.name);
  if (indexColumns.join(",") !== "status,provider,id") {
    throw new DatabaseVersionError("Database schema version 1 index raw_data_status has unexpected columns.");
  }
  for (const trigger of ["saved_items_ai", "saved_items_ad", "saved_items_au"]) {
    if (!objectExists(db, "trigger", trigger)) {
      throw new DatabaseVersionError(`Database schema version 1 is missing required trigger ${trigger}.`);
    }
  }
}

function validateRegistry(currentVersion: number, migrations: readonly Migration[]): void {
  versionNumber(currentVersion);
  if (currentVersion < 1) {
    throw new DatabaseVersionError("The current database version must be at least 1.");
  }
  const expectedCount = currentVersion - 1;
  if (migrations.length !== expectedCount) {
    throw new DatabaseVersionError(
      `Migration registry must contain every target version from 2 through ${currentVersion}.`
    );
  }
  for (let i = 0; i < migrations.length; i++) {
    const migration = migrations[i]!;
    const expected = i + 2;
    if (versionNumber(migration.version) !== expected) {
      throw new DatabaseVersionError(
        `Migration registry must be strictly ordered and contiguous; expected version ${expected}.`
      );
    }
    if (!migration.name.trim()) {
      throw new DatabaseVersionError(`Migration ${expected} must have a non-empty name.`);
    }
  }
}

function adoptVersionZero(db: SqlDatabase): void {
  db.exec(V1_RAW_SCHEMA);
  const existingColumns = columnNames(db, "saved_items");
  for (const column of ["deleted_at", "starred_at", "sort_key"] as const) {
    if (!existingColumns.has(column)) db.exec(`ALTER TABLE saved_items ADD COLUMN ${column} INTEGER`);
  }

  const hadFts = objectExists(db, "table", "saved_items_fts");
  db.exec(V1_FTS_SCHEMA);
  if (!hadFts) {
    db.exec("INSERT INTO saved_items_fts(saved_items_fts) VALUES('rebuild')");
  }
  validateVersion1(db);
}

function runInitialization(
  db: SqlDatabase,
  currentVersion: number,
  migrations: readonly Migration[]
): MigrationResult {
  validateRegistry(currentVersion, migrations);
  const originalVersion = readDatabaseVersion(db);
  if (originalVersion > currentVersion) {
    throw new DatabaseVersionError(
      `Database version ${originalVersion} is newer than this build supports (${currentVersion}).`
    );
  }

  const tables = applicationTables(db);
  const hasSavedItems = tables.includes("saved_items");
  if (!tables.length) {
    if (originalVersion !== 0) {
      throw new DatabaseVersionError(
        `Database version ${originalVersion} has no application schema; refusing to replace it.`
      );
    }
    try {
      db.transaction(() => {
        createLatestSchema(db);
        if (currentVersion === 1) validateVersion1(db);
        setDatabaseVersion(db, currentVersion);
      });
    } catch (cause) {
      throw new DatabaseMigrationError(0, currentVersion, "create latest schema", cause);
    }
    return {
      fromVersion: 0,
      toVersion: currentVersion,
      applied: [],
      created: true,
      adopted: false,
    };
  }

  if (!hasSavedItems) {
    throw new DatabaseVersionError(
      `Database version ${originalVersion} has application tables but no saved_items table.`
    );
  }

  let version = originalVersion;
  const applied: { version: number; name: string }[] = [];
  let adopted = false;
  if (version === 0) {
    try {
      db.transaction(() => {
        adoptVersionZero(db);
        setDatabaseVersion(db, 1);
      });
    } catch (cause) {
      throw new DatabaseMigrationError(0, 1, V1_ADOPTION_NAME, cause);
    }
    version = 1;
    adopted = true;
    applied.push({ version: 1, name: V1_ADOPTION_NAME });
  } else if (version === 1) {
    validateVersion1(db);
  }

  for (const migration of migrations) {
    if (migration.version <= version) continue;
    const fromVersion = version;
    try {
      db.transaction(() => {
        migration.up(db);
        setDatabaseVersion(db, migration.version);
      });
    } catch (cause) {
      throw new DatabaseMigrationError(fromVersion, migration.version, migration.name, cause);
    }
    version = migration.version;
    applied.push({ version, name: migration.name });
  }

  return {
    fromVersion: originalVersion,
    toVersion: version,
    applied,
    created: false,
    adopted,
  };
}

export function initializeDatabase(db: SqlDatabase): MigrationResult {
  return runInitialization(db, CURRENT_DATABASE_VERSION, MIGRATIONS);
}

/** @internal Test seam for synthetic future histories. Production startup
 *  always calls initializeDatabase and therefore the immutable registry. */
export function initializeDatabaseWithRegistry(
  db: SqlDatabase,
  currentVersion: number,
  migrations: readonly Migration[]
): MigrationResult {
  return runInitialization(db, currentVersion, migrations);
}
