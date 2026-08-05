# Versioned SQLite schema and data migrations

Status: implemented.

## Outcome

Linkosh can upgrade an existing local SQLite database across skipped extension releases without
losing saved items or user-owned state. Database startup has three valid outcomes:

1. create the latest schema for a new installation;
2. migrate an older supported schema to the latest version, in order and transactionally; or
3. stop before unsafe access, report a useful error, and keep export available when SQLite itself
   opened successfully.

The database version is independent of the extension/package version. Most extension releases will
not change it. A release increments the database version only when persisted structure or data must
change.

## Current state and compatibility boundary

[schema.ts](../../src/core/db/schema.ts) contains the canonical `saved_items`, `raw_data`, FTS,
index, and trigger definitions. Its `initSchema` creates missing objects and conditionally adds
`deleted_at`, `starred_at`, and `sort_key` to `saved_items`. That is safe for the additive cases it
knows about, and [db-ops.test.ts](../../tests/db-ops.test.ts) verifies idempotency, but it is not a
general migration mechanism:

- `CREATE TABLE IF NOT EXISTS` does not reconcile existing DDL.
- There is no persisted schema version or ordered history.
- Code cannot distinguish an older DB from one produced by newer code.
- Renames, constraints, table rebuilds, FTS definition changes, and DML transformations have no
  controlled upgrade path.

All currently deployed TypeScript-era databases have `PRAGMA user_version = 0`. Some may predate
one or more of the additive-column repairs, so version-0 adoption must tolerate those known shapes.

The active OPFS filename remains `linkosh-v1.sqlite`. Its `v1` suffix marks the one-time boundary
from the abandoned pre-TypeScript database generation; it is not the current schema version and
must not be changed as `user_version` advances.

## Design

### Version model

Use SQLite's application-owned `PRAGMA user_version` as the sole persisted schema version:

- `0` means an unversioned database created before this framework.
- `1` is the frozen compatibility baseline established when the framework lands.
- Later persisted changes advance by exactly one integer.
- Released migration numbers and bodies are immutable.
- `CURRENT_DATABASE_VERSION` is the highest version understood by the code.
- The valid range is `0` through `2_147_483_647`, the non-negative half of SQLite's signed 32-bit
  database-header field range.
- A newer stored version is rejected without executing schema DDL or DML; automatic down
  migrations are not supported.

`PRAGMA user_version = N` cannot bind `N`. The setter must accept only a validated integer constant
from the migration registry before interpolating it. No provider data, preference, or other runtime
value may reach that statement.

Do not introduce a migration-history table unless a concrete future requirement needs metadata
that cannot be reconstructed from the immutable registry.

### Canonical latest schema and frozen version-1 adoption are separate

[schema.ts](../../src/core/db/schema.ts) remains the canonical latest schema used for a brand-new
database. New installations create that end state directly rather than replaying migration history.

Existing unversioned databases take a different path: an independently defined, permanently frozen
version-1 adoption routine in the new
[migrations.ts](../../src/core/db/migrations.ts). It must not import or alias the evolving `SCHEMA`
or `FTS_SCHEMA` string. Type-only imports are fine.

The independence is load-bearing. `CREATE TABLE IF NOT EXISTS saved_items` does nothing to an
existing table, but a future table, index, or trigger added to live `SCHEMA` could otherwise leak
into version-0 adoption. A later numbered migration could then fail because its object already
exists, or the version-0 path could silently skip intended transformation logic.

Keep the frozen adoption SQL narrowly scoped instead of duplicating more latest-schema DDL than
needed:

- the version-1 `raw_data` table and index definitions;
- the version-1 FTS table and three maintenance triggers; and
- the known additive-column repairs for `deleted_at`, `starred_at`, and `sort_key`.

A user jumping directly from unversioned code to database version 4 must first be adopted to
version 1 and then run migrations 2, 3, and 4 in order.

Every future persisted change must update both:

1. canonical latest-schema DDL for new databases; and
2. exactly one new numbered migration for existing databases.

Normalized fresh-vs-upgraded schema equivalence tests enforce this relationship. Do not add a raw
SQL-string fingerprint: it is sensitive to formatting/comments and duplicates the stronger
behavioral equivalence test.

### Core API

Create [migrations.ts](../../src/core/db/migrations.ts) with an API shaped like:

```ts
export const CURRENT_DATABASE_VERSION = 1;

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

export function readDatabaseVersion(db: SqlDatabase): number;
export function initializeDatabase(db: SqlDatabase): MigrationResult;
```

The production registry is initially empty because version 1 is the adoption baseline:

```ts
const MIGRATIONS: readonly Migration[] = [
  // The first future persisted change targets version 2.
];
```

Registry validation and the ordered runner should accept a registry argument internally so tests
can execute synthetic multi-version histories. Do not export a speculative `planMigrations` API.
Expose planning later only if the high-risk snapshot layer needs it.

The runner validates that registry entries are strictly ordered, unique, and cover every integer
from 2 through `CURRENT_DATABASE_VERSION`.

### Startup algorithm

`initializeDatabase` performs:

1. Read `PRAGMA user_version`; reject missing, multiple, fractional, negative, or values above
   `2_147_483_647`.
2. If the stored version is newer than `CURRENT_DATABASE_VERSION`, throw before schema access.
3. Detect `saved_items` in `sqlite_schema`. SQLite internal tables do not count as an application
   schema.
4. If there is no application schema and the version is `0`, create canonical latest-schema DDL in
   one transaction, validate it, set `user_version = CURRENT_DATABASE_VERSION`, and return
   `created: true`. Do not replay historical migrations.
5. If there is no application schema but the version is nonzero, fail as inconsistent rather than
   silently replacing possible user data.
6. If application tables exist and the version is `0`, run frozen version-1 adoption and set
   `user_version = 1` in the same transaction.
7. Select every numbered migration above the resulting stored version and run them in ascending
   order.
8. Return the original/final versions and applied migration summary. Log only versions and
   migration names, never row contents.

### Version-0 adoption details

The adoption transaction preserves today's tolerant behavior while freezing it at version 1:

1. Create the frozen version-1 `raw_data` table/index if missing.
2. Inspect `pragma_table_info('saved_items')` and append any missing `deleted_at`, `starred_at`, and
   `sort_key` columns.
3. Inspect whether `saved_items_fts` exists.
4. If FTS is absent, create the frozen version-1 FTS table/triggers and run the FTS5
   external-content rebuild command so existing `saved_items` rows become searchable.
5. If FTS already exists, create only missing version-1 maintenance triggers and do not rebuild a
   valid index merely to assign a version.
6. Validate required version-1 tables, columns, index, FTS table, and triggers.
7. Set `PRAGMA user_version = 1` as the transaction's final statement.

The adoption constants are an independent copy in `migrations.ts`, with a comment that they must
never be replaced by imports from live schema constants. The historical SQL fixtures in tests must
also be independently defined rather than importing either production schema string.

If evidence reveals another deployed version-0 shape, add a narrowly tested repair to adoption.
Once version 1 ships, later product changes never alter adoption; they append numbered migrations.

### Transaction and failure semantics

Run one transaction per target version. A migration calls `up`, performs its validation, and sets
`user_version` as the final statement before commit. On error, DDL, DML, validation, and the version
update for that target all roll back.

One transaction per version provides a durable restart point. If version 2 commits and version 3
fails, reopening retries version 3 rather than repeating version 2. Migration functions must not
open nested transactions; SQLite already rejects a nested `BEGIN`, and the outer transaction rolls
back.

Add stable, user-readable errors:

- `DatabaseVersionError` for invalid, inconsistent, or newer versions;
- `DatabaseMigrationError` identifying source version, target version, and migration name.

The current RPC serializer already preserves a generic error's `name` and `message`. Messages must
not include SQL values or saved content. The worker logs the original failure with version/name for
diagnosis.

### Opened vs migrated worker readiness

Refactor [db.worker.ts](../../src/workers/db.worker.ts) during the initial implementation:

- `opened` resolves after SQLite, the SAH-pool VFS, and the DB handle are available.
- `migrated` awaits `opened`, calls `initializeDatabase`, and only then constructs list/search/sync,
  raw-ingest, embedding, and debug handlers.
- `export` depends only on `opened`, so a DB that opened but failed version validation/migration can
  still be serialized and downloaded.
- All schema-dependent operations await `migrated` and therefore fail closed.

The operation proxy must route `export` through `opened` without first awaiting `migrated`; merely
splitting the promises while retaining one shared handler object would leave export stranded.

The UI should recognize database initialization/version errors and say that normal operations are
unavailable, with a path to **Options → Developer → Export**. This recovery path covers version or
migration failures after SQLite opens. If SQLite/VFS cannot open a corrupt or truncated file,
`opened` itself rejects and export may be impossible; the message must distinguish that condition
and must never silently clear/recreate storage.

Automatic pre-migration snapshots are a separate, deferred defense against a logically incorrect
destructive migration that commits successfully.

### Node file behavior

Every writable database opener uses the same core runner, but callers must opt into mutation
explicitly:

- `openDb()` creates/initializes a fresh in-memory WASM DB.
- `openDbFromBytes()` remains a byte-faithful, non-migrating inspection helper as documented today.
- Replace ambiguous `openDbFile(file, { init })` with an explicit schema mode such as
  `openDbFile(file, { schema: "migrate" | "inspect", readOnly })`; require the option at file-backed
  call sites rather than relying on a mutation default.
- Comparison and fixture-extraction tools use `schema: "inspect"` and remain read-only.
- The UX server uses `schema: "migrate"` when deliberately opening an exported DB for live use.
- The ingest CLI uses `schema: "migrate"`, prints any version transition before ingesting, and
  documents that the target is modified. Its existing `--out` and `--dry-run` paths remain the safe
  ways to preserve an input copy.

The future high-risk migration gate below may require the ingest CLI to create a sibling backup or
require an additional confirmation flag. Version-1 adoption is additive and does not need that
snapshot machinery.

## Implementation phases

Each phase ends with `npm test` passing. Runtime changes and their tests stay in the same commit if
work is committed incrementally.

### Phase 1 — Core runner, frozen adoption, and WASM tests

Files:

- [schema.ts](../../src/core/db/schema.ts)
- new [migrations.ts](../../src/core/db/migrations.ts)
- [errors.ts](../../src/core/errors.ts), if DB-specific error classes live with shared errors
- new `tests/db-migrations.test.ts`, with existing DB-operation tests left focused

Implement:

- Separate canonical latest-schema creation from frozen version-1 adoption.
- Move the current conditional-column repairs into adoption.
- Add bounded version reading/writing, application-schema detection, registry validation, ordered
  execution, one-transaction-per-version behavior, common version-1 validation, result summaries,
  and database errors.
- Make the registry runner injectable internally for synthetic histories while production
  initialization always uses the immutable production registry.

Required WASM tests:

1. Fresh DB creates the latest schema and stores version 1.
2. A current-shape version-0 DB is adopted without changing stored row values or search results.
3. Legacy variants independently omit `deleted_at`, `starred_at`, and `sort_key`, including one
   shape missing all three.
4. Missing `raw_data`/index objects are repaired without replacing `saved_items`.
5. Missing FTS objects are recreated, rebuilt from existing rows, and return expected search
   results; an existing valid FTS index is not needlessly rebuilt.
6. Reopening a current DB applies nothing and changes neither schema nor data.
7. Invalid/too-new versions and nonzero-without-schema fail without mutation.
8. Registry validation rejects duplicates, gaps, and unordered versions.
9. Synthetic `N → N+2` migration runs both steps once and in order.
10. A synthetic step that performs DDL/DML and then throws rolls back that target version; a prior
    committed version remains committed, and retry runs from that point.
11. Version-0 adoption preserves saved-item identity, nullable timestamps, collection/stats JSON,
    raw page bodies/status, embedding bytes/model, and FTS behavior. Compare binary/structured
    values directly; do not invent a synthetic data transformation merely for this test.
12. Fresh and adopted/upgraded schemas are observably equivalent using the normalized comparison
    below.

Schema equivalence deliberately ignores physical column order and original `CREATE TABLE` text.
An adopted table keeps its historical DDL string and appends repaired columns physically, neither of
which is an application contract. Compare:

- order-insensitive sets of `{name, type, notnull, dflt_value, pk}` from `pragma_table_info`;
- application table/index/trigger presence and index column membership by name;
- required FTS objects; and
- behavioral inserts, updates, deletes, plain-text search, and column-filter search.

Do not compare `cid`, root pages, raw `sqlite_schema.sql`, or SQLite internal FTS object names.

### Phase 2 — Worker, Node adapter, CLI, and recovery surface

Files:

- [db.worker.ts](../../src/workers/db.worker.ts)
- [node-db.ts](../../src/node/node-db.ts)
- [service.ts](../../src/core/db/service.ts), only if export/status typing changes
- [background-service.ts](../../src/ext/background-service.ts), if recovery status needs relaying
- [app.tsx](../../src/pages/popup/app.tsx) and/or
  [options.tsx](../../src/pages/options/options.tsx) for initialization failure guidance
- [ingest.ts](../../src/node/tools/ingest.ts)
- [ux-server.ts](../../src/node/tools/ux-server.ts)
- read-only file tools using `openDbFile`

Implement:

- Replace all writable `initSchema` calls with `initializeDatabase`.
- Split worker `opened` and `migrated` readiness and route export through `opened`.
- Keep normal handlers unavailable until migration succeeds.
- Make every file-backed caller choose `migrate` or `inspect` explicitly.
- Preserve `openDbFromBytes` as non-migrating.
- Print migration summaries in writable Node tools without printing row data.
- Render a distinct initialization/version failure with export guidance when export is available.

Required integration tests:

- A temporary disk-backed `node:sqlite` file covers fresh initialization, version-0 adoption,
  synthetic ordered migration, and transactional rollback of DDL/DML plus `user_version`.
- The writable file opener migrates only in explicit migrate mode; inspect/read-only mode never
  changes bytes or `user_version`.
- Ingest/UX-server call-site behavior is pinned at the appropriate seam so future defaults cannot
  silently reintroduce arbitrary-file migration.
- Worker routing proves export depends only on successful open while a representative normal op
  depends on successful migration. If the worker is too coupled for a Node unit test, extract the
  small readiness/router seam and test that pure logic.

The test suite already has a repository precedent for `mkdtempSync`/`tmpdir` in the ingest tool;
use a unique temporary directory and guaranteed cleanup. Do not commit binary SQLite fixtures when
small programmatic historical schemas suffice.

### Phase 3 — Contributor guideline and release verification

Add [database-migrations.md](../database-migrations.md) as the maintained contributor guide after
the actual API names settle, and update the database/schema section of the repository guidance.
Move authoring process into that guide instead of duplicating it here.

The guide must cover:

- immutable, contiguous versions and the canonical-schema-plus-migration rule;
- why frozen v1 adoption must never alias live schema constants;
- additive DDL and deterministic bound DML;
- table-rebuild order with explicit column lists and invariants;
- FTS trigger recreation and external-content rebuilds;
- preservation of `deleted_at`, `starred_at`, raw archives, identities, and other user-owned state;
- lazy recipe/version invalidation for derived embeddings instead of unnecessary DML;
- expand/backfill/contract as the design path for a large migration;
- fresh-vs-upgraded equivalence and prior/skipped-version fixtures;
- explicit Node file migration behavior; and
- the high-risk migration gate below.

Automated gate:

```sh
npm test
npm run build
```

Live extension verification with a disposable profile or backed-up real DB:

1. Create normal items, a starred item, a soft-deleted item, embeddings, and capture-mode raw rows
   under the previous build.
2. Export the pre-upgrade DB and record version, counts, and representative values.
3. Upgrade without clearing origin storage and confirm the worker reports exactly one `0 → 1`
   adoption.
4. Verify popup/full-page list, FTS/hybrid/semantic search, starred/deleted views, similar items, raw
   ingest, and export.
5. Reload the extension/restart Chrome and confirm initialization is a no-op.
6. Open the post-upgrade export with Node tooling and verify its version.
7. Exercise an injected migration failure in a development build: normal DB ops fail, while Options
   can still export the rolled-back/intermediate DB.

Test downgrade protection only against a copied DB under Node; do not point older live code at the
user's only OPFS database.

## Deferred gate for the first high-risk migration

The initial framework contains only additive version-0 adoption. Before releasing the first table
rebuild, column removal, destructive DML transformation, or backfill large enough to threaten
startup responsiveness, write a focused design and implement the required safeguards:

- classify pending migration risk before mutation;
- export the original WASM DB to a completed plain OPFS recovery snapshot before a high-risk step;
- abort before mutation if a required snapshot cannot be written;
- retain at most one confirmed recovery snapshot without overwriting the active SAH-pool DB;
- expose snapshot download through the already separated `opened` recovery path;
- define equivalent backup/confirmation behavior for writable Node files;
- benchmark a representative large scrubbed export on an agreed reference device;
- set a concrete startup-time threshold for that migration; and
- use a separately designed resumable expand/backfill/contract flow if it exceeds the threshold.

Transaction rollback protects execution failures. The snapshot protects against a logically wrong
transformation that validates and commits. Do not add unused `risk` fields, snapshot retention code,
or a generic resumable-backfill engine until a concrete migration requires them.

## Acceptance criteria

The initial migration framework is complete when:

- existing unversioned OPFS databases are adopted in place with representative values preserved;
- a missing FTS index is rebuilt from existing saved items;
- fresh databases are stamped with the current database version;
- frozen version-1 adoption is independent of canonical latest-schema constants and test fixtures;
- synthetic skipped versions run sequentially and each committed step advances `user_version`
  atomically;
- failed steps roll back and retry from the last committed version;
- invalid/newer/inconsistent databases are rejected without mutation;
- normalized fresh and upgraded schemas plus repository/FTS behavior are equivalent;
- both shipped WASM and disk-backed Node paths are covered;
- all writable file callers opt into migration explicitly;
- normal worker operations fail closed after migration failure while export remains available after
  a successful SQLite open;
- users receive distinct migration/open failure guidance; and
- a maintained contributor guide and tests enforce the workflow where mechanically possible.

The first high-risk migration has the additional acceptance gate defined above.

## Non-goals

- Migrating the abandoned pre-TypeScript database that intentionally used a different OPFS file.
- Automatic downgrade/down migrations.
- Synchronizing schema versions across devices; the SQLite file is local to one extension origin.
- Automatic recovery when SQLite/VFS cannot open a corrupt database.
- Prebuilding snapshot retention, risk classification, or resumable backfills before a concrete
  migration needs them.
- Treating provider payload, parser, preference, or embedding-recipe changes as DB migrations when
  persisted compatibility is unchanged.
