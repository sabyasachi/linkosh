# Versioned SQLite schema and data migrations

Status: proposed (not implemented).

## Outcome

Linkosh should be able to upgrade an existing local SQLite database across any number of skipped
extension releases without losing saved items or user-owned state. Database startup should either:

1. create the latest schema for a new installation;
2. migrate an older supported schema to the latest version, in order and transactionally; or
3. stop before making changes and report a useful error when the database is newer than the code or
   a migration cannot complete.

The database version is independent of the extension/package version. Most extension releases will
not change it. A release increments the database version only when persisted structure or persisted
data must change.

## Current state and compatibility boundary

[schema.ts](../../src/core/db/schema.ts) currently contains the canonical `saved_items`, `raw_data`,
FTS, index, and trigger definitions. `initSchema` runs whenever either database adapter opens a
database. It creates missing objects and conditionally adds `deleted_at`, `starred_at`, and
`sort_key` to `saved_items`.

That behavior is safe for the additive changes it knows about, and
[db-ops.test.ts](../../tests/db-ops.test.ts) verifies that those column additions are idempotent. It
is not a general migration mechanism:

- SQLite `CREATE TABLE IF NOT EXISTS` does not reconcile an existing table with changed DDL.
- There is no persisted schema version or ordered history.
- A column rename, constraint change, table rebuild, FTS definition change, or data transformation
  has no safe execution path.
- Code cannot distinguish an older database from a database produced by a newer extension.
- The current OPFS filename, `linkosh-v1.sqlite`, separated the TypeScript rewrite from its
  predecessor. Changing that filename for routine releases would strand the user's existing data
  and is not an acceptable migration strategy.

All databases deployed by the current code have `PRAGMA user_version = 0`, including databases that
predate one or more of the additive-column repairs. The first implementation must adopt those files
without assuming that every version-0 file has exactly the same set of columns.

## Design decisions

### Use `PRAGMA user_version`

Use SQLite's application-owned `PRAGMA user_version` integer as the sole persisted schema version.
Do not add a Linkosh migration table unless a future requirement needs per-migration metadata that
cannot be reconstructed from code.

Version rules:

- Version `0` means an unversioned database created by Linkosh before this framework.
- Version `1` is the baseline representing the schema that exists when this framework lands.
- Every later schema change advances by exactly one integer.
- Released migration numbers and bodies are immutable.
- `CURRENT_DATABASE_VERSION` is the highest version understood by the code, not the extension
  version.
- Gaps and duplicate migration versions are programming errors caught by tests and at startup.

`PRAGMA user_version` cannot be parameter-bound, so only validated integer constants from the
migration registry may be interpolated into that statement. No provider response, preference, or
other runtime value may reach it.

### Keep a canonical latest schema and an ordered upgrade path

The latest `SCHEMA` and `FTS_SCHEMA` remain the source used for a brand-new database. They describe
the desired end state and avoid replaying years of history on new installations.

The migration registry describes how to reach that end state from every previously released
version. Any release that changes persisted structure must update both:

1. the canonical latest-schema DDL, for new databases; and
2. one new migration, for existing databases.

Tests must prove that fresh creation and sequential migration produce equivalent observable
schemas.

### Run migrations before exposing database handlers

The DB worker already opens the OPFS database and calls `initSchema` before constructing its
handlers. Keep that ordering: no list, sync, search, ingest, or embedding operation can race a
migration. Node tools must use the same core runner when they open a writable database.

Read-only inspection tools must remain read-only. In particular, tools that currently pass
`{ init: false, readOnly: true }` must inspect the stored version without migrating it.

### One transaction per version

Each migration runs in its own `SqlDatabase.transaction` and updates `user_version` as the final
statement inside that same transaction. SQLite DDL is transactional, so a thrown DDL, DML,
validation, or version-update error rolls back that entire version.

One transaction per version, rather than one transaction for the whole history, gives a clear and
durable restart point. If upgrading from version 2 to 5 fails in migration 4, version 3 remains
committed and reopening retries migration 4. Migration functions must not open nested transactions.

### Forward migrations only

Do not implement automatic down migrations. Rolling an extension back over a newer database is not
generally safe because old code may misinterpret new data. If `storedVersion >
CURRENT_DATABASE_VERSION`, fail before any schema statement with a message explaining that the
database was created by a newer Linkosh version.

### Separate schema compatibility from derived-data recipes

Do not add a database migration when data can be recomputed safely and lazily:

- Embedding text/model changes continue to advance `embedding_model` or its `+rN` recipe suffix;
  the orchestrator requeues mismatched rows.
- Search indexes that can be rebuilt from `saved_items` should be recreated/rebuilt by a focused
  migration rather than transforming the source rows unnecessarily.
- Ephemeral preferences and sync metadata remain governed by their own storage contracts.

## Proposed core API

Create [migrations.ts](../../src/core/db/migrations.ts) and keep current-schema DDL in
[schema.ts](../../src/core/db/schema.ts). The exact names may be adjusted during implementation,
but the boundary should look like this:

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
}

export function readDatabaseVersion(db: SqlDatabase): number;
export function planMigrations(db: SqlDatabase): MigrationPlan;
export function initializeDatabase(db: SqlDatabase): MigrationResult;
```

`initializeDatabase` replaces `initSchema` as the public startup operation. Keeping a deprecated
alias temporarily is unnecessary unless it makes an intermediate commit easier; no released API
depends on this internal function.

The registry starts empty after the version-1 baseline:

```ts
const MIGRATIONS: readonly Migration[] = [
  // The first future persisted change is version 2.
];
```

When version 2 is introduced, its registry entry is appended and
`CURRENT_DATABASE_VERSION` becomes `2`. The runner validates at module initialization or on first
use that entries are strictly ordered, unique, and cover every integer from 2 through the current
version.

### Startup algorithm

`initializeDatabase` follows this sequence:

1. Read and validate `PRAGMA user_version` as one non-negative safe integer.
2. If the stored version is newer than the code, throw `DatabaseVersionError` without executing
   DDL or DML.
3. Detect whether a Linkosh application schema exists. Checking for `saved_items` in
   `sqlite_schema` is sufficient; SQLite internal tables do not count.
4. If no application schema exists and the version is `0`, create the canonical latest schema in
   one transaction, run structural validation, set `user_version = CURRENT_DATABASE_VERSION`, and
   return `created: true`. Do not replay historical migrations. A nonzero version without an
   application schema is inconsistent and must fail rather than being silently recreated.
5. If application tables exist and the version is `0`, execute the baseline-adoption transaction
   described below and set the version to `1`.
6. Select every migration whose target version is greater than the stored version, in ascending
   order.
7. For each migration, start a transaction, call `up`, run common validation, set `user_version` to
   that migration's target, and commit.
8. Return the original version, final version, whether the DB was newly created, and the migrations
   applied. The worker may log this summary for diagnosis; it must not log row contents.

Check the too-new condition immediately after reading the version and before baseline/schema
creation. An unexpected version must never be “fixed” by `CREATE IF NOT EXISTS`.

### Adopting existing version-0 databases

Version 1 is a compatibility baseline, not a claim that all deployed version-0 files are identical.
The adoption transaction should deliberately preserve today's tolerant behavior:

1. Execute a frozen version-1 baseline definition so a missing `raw_data` table/index can be
   created.
2. Inspect `pragma_table_info('saved_items')` and add any missing legacy additive columns:
   `deleted_at`, `starred_at`, and `sort_key`.
3. Create the frozen version-1 FTS table and triggers when absent.
4. Validate required tables and columns.
5. Set `PRAGMA user_version = 1`.

This code is isolated as `adoptUnversionedDatabase`, documented as permanent compatibility code,
and covered with multiple legacy shapes. Once released, it must not be repurposed for later
changes. Future changes belong only in numbered migrations.

The baseline DDL/repair list must also be frozen. It may initially reuse constants whose contents
are identical to version 1, but future edits to canonical latest-schema DDL must not cause a
version-0 database to skip migrations 2 and later. A user who jumps directly from unversioned code
to version 4 must be adopted to version 1 and then run migrations 2, 3, and 4 in order.

Do not rebuild a valid existing FTS index during baseline adoption merely to assign the version.
If inspection reveals that a known deployed legacy FTS shape requires repair, encode and test that
specific repair in the adoption function.

### Error model

Add errors with stable names and user-readable messages:

- `DatabaseVersionError` for negative/invalid versions and databases newer than the code.
- `DatabaseMigrationError` wrapping a failure with the source version, target version, and migration
  name.

The existing RPC serializer preserves a generic error's `name` and `message`, which is sufficient
for the initial UI. Keep SQL and saved-item content out of user-facing messages. Log the original
error locally in the DB worker for debugging, including migration number/name but not bound row
values.

The worker must remain failed closed when initialization fails: it must not construct normal DB
handlers against a partially upgraded schema. Transaction rollback means reopening with corrected
code can retry from the last committed version.

## Migration authoring rules

### Additive DDL

For a nullable column or a column with a valid constant default:

1. add it to canonical `SCHEMA`;
2. add one numbered `ALTER TABLE ... ADD COLUMN` migration;
3. backfill it in the same migration if existing rows require a value; and
4. update repositories/types only in the same release that contains the migration.

Do not use a “column exists” check in normal numbered migrations. The stored version is the source
of truth, and an unexpected shape should fail validation rather than silently claim success. Shape
checks remain appropriate only in version-0 adoption, where deployed schemas are known to vary.

### DML/backfills

- Express transformations as deterministic SQL where practical.
- Bind data values. Interpolate only fixed identifiers or validated migration constants.
- Preserve user-owned state (`deleted_at`, `starred_at`, collections, raw archives, and stable
  external identities) unless the product requirement explicitly changes its meaning.
- Define how `NULL`, empty strings, malformed legacy JSON, and duplicate values are handled before
  implementing the update.
- Validate affected-row invariants inside the transaction. A migration that transforms every saved
  item should normally verify total row count and uniqueness of `(provider, account, external_id)`.
- Never fetch from providers, load an embedding model, or depend on network/browser state.

For a backfill too large to fit the extension's acceptable startup budget, use an
expand/backfill/contract sequence across releases instead of one long blocking migration:

1. **Expand:** add nullable storage and make code tolerate both representations.
2. **Backfill:** process bounded, resumable batches with an explicit durable completion marker while
   continuing to support the old representation.
3. **Contract:** only in a later release, switch the schema/read path and remove obsolete storage.

The first implementation need not build a generic resumable-backfill engine. It must document this
escape hatch and require a separate design for any migration whose representative large-DB test
exceeds the agreed startup budget.

### Table rebuilds and destructive DDL

Use SQLite's table-rebuild pattern for type, constraint, primary-key, or unsupported structural
changes:

1. create `<table>_new` with the target definition;
2. copy rows with an explicit target column list and explicit transformations;
3. validate row counts, uniqueness, required non-null values, and JSON/domain invariants;
4. drop dependent triggers/indexes as required;
5. drop the old table;
6. rename the new table to the canonical name; and
7. recreate indexes, triggers, and FTS dependencies.

All steps stay in the migration transaction. Never use `SELECT *` during a rebuild. Never depend on
the physical column order. Repositories continue to alias snake_case SQL columns to camelCase domain
fields.

Before the first destructive/table-rebuild migration is released, implement the recovery snapshot
phase below. Transaction rollback covers execution failures; the snapshot also protects against a
logically incorrect transformation that commits successfully.

### FTS changes

Changing the `fts5(...)` column list is a structural migration even though the index is derived.
The migration must:

1. drop the three FTS maintenance triggers;
2. drop and recreate `saved_items_fts` with the new canonical definition;
3. recreate the triggers; and
4. populate it from `saved_items` using FTS5's external-content rebuild command.

Validate representative plain-text and column-filter searches after the migration. Do not modify
the source `saved_items` rows solely to make the index current.

### Renames and removals

- Prefer an expand/contract release sequence when old and new extension code may encounter the same
  exported database.
- Treat a rename as a semantic change even when the SQLite runtime supports `RENAME COLUMN`; inspect
  triggers, FTS definitions, indexes, and every repository query.
- Drop a column only after all current code and tools have stopped selecting/writing it and the
  migration test proves unrelated fields survive.
- Do not rename the OPFS database file for an ordinary schema migration.

## Implementation phases

Each phase ends with `npm test` passing. Keep runtime changes and their tests in the same commit if
the work is committed incrementally.

### Phase 1 — Versioned core runner and version-0 adoption

Files:

- [schema.ts](../../src/core/db/schema.ts)
- new [migrations.ts](../../src/core/db/migrations.ts)
- [db-ops.test.ts](../../tests/db-ops.test.ts), or a focused new
  `tests/db-migrations.test.ts`

Work:

- Move legacy conditional-column repair out of general latest-schema creation and into the explicit
  version-0 adoption function.
- Freeze the version-1 baseline/adoption DDL separately from the canonical latest schema so later
  releases cannot accidentally make an unversioned database skip numbered migrations.
- Add `CURRENT_DATABASE_VERSION`, version reading/setting, application-schema detection, registry
  validation, planning, fresh creation, adoption, sequential execution, common validation, and the
  result type.
- Keep `SCHEMA`/`FTS_SCHEMA` available to the runner, but expose `initializeDatabase` as the only
  normal initialization entry point.
- Query versions using `db.rows<{ user_version: number }>('PRAGMA user_version')`; reject missing,
  multiple, fractional, negative, or unsafe values rather than coercing them.
- Set versions using a small helper that accepts only a validated integer and calls `db.exec`.
- Validate at minimum that required application tables, expected columns, indexes, and FTS triggers
  exist after fresh creation/adoption. Keep migration-specific semantic assertions in each
  migration rather than growing one global validator indefinitely.
- Return a structured summary so worker/Node callers and tests can distinguish creation, no-op, and
  migration.

Keep schema/migration code in `src/core`: it must not import DOM, Chrome, Node, or WASM-specific
APIs.

### Phase 2 — Wire every writable database opener through the runner

Files:

- [db.worker.ts](../../src/workers/db.worker.ts)
- [node-db.ts](../../src/node/node-db.ts)
- [ux-server.ts](../../src/node/tools/ux-server.ts), if its startup copy needs adjustment
- [ingest.ts](../../src/node/tools/ingest.ts), indirectly through `openDbFile`
- read-only tools only if their intent needs a clearer API

Work:

- Replace `initSchema` calls in the worker, in-memory test opener, and writable Node file opener with
  `initializeDatabase`.
- In the worker, perform initialization before `createDbService`, raw-ingest handlers, debug handles,
  or RPC readiness. Log only a concise line such as `database 1 -> 3 (2 migrations)` when work was
  applied.
- Preserve `openDbFile(file, { init: false, readOnly: true })` behavior for comparison and fixture
  extraction tools. Rename the `init` option to `migrate` if doing so materially improves clarity,
  updating all call sites in the same phase.
- Decide explicitly whether `openDbFromBytes` remains a byte-faithful, non-migrating inspection
  helper. The current contract says schema is not applied; retain that contract and add a separate
  helper/call to migrate exported bytes in tests when needed.
- Verify that both the WASM adapter and `node:sqlite` adapter execute transactional DDL and roll back
  `user_version` with the rest of a failed migration.

### Phase 3 — Migration fixtures and equivalence tests

Prefer small programmatically created databases over committing opaque binary fixtures. SQL setup
helpers should create only released historical shapes and insert minimal representative rows.

Required cases:

1. **Fresh database:** creates the latest schema and stores version 1.
2. **Current unversioned database:** adoption changes only `user_version` and leaves rows/search
   behavior intact.
3. **Older unversioned variants:** independently omit `deleted_at`, `starred_at`, and `sort_key`, and
   test at least one shape omitting all three.
4. **Partial legacy objects:** missing `raw_data` or its index is repaired without replacing
   `saved_items`.
5. **Idempotency:** a second initialization applies nothing and does not alter schema/data.
6. **Future version:** setting `user_version` above current throws and leaves both version and schema
   untouched.
7. **Registry integrity:** duplicate, unordered, and skipped versions are rejected in a testable
   registry-validation helper.
8. **Sequential skip upgrade:** introduce test-only migrations or exercise the real registry after
   version 2 exists to prove `N -> N+2` runs both steps in order.
9. **Failure rollback:** a test migration performs DDL and DML and then throws; its table/data/version
   changes all roll back. Retrying with a corrected migration succeeds once.
10. **Fresh-vs-upgraded equivalence:** compare application table columns/defaults/nullability,
    indexes, triggers, and FTS behavior, ignoring SQLite-generated root pages and internal object
    names that are not contractual.
11. **Data preservation:** saved item identity, `deleted_at`, `starred_at`, `sort_key`, collection and
    stats JSON, raw page bodies/status, and embedding bytes/model survive a representative migration.
12. **Both engines:** core version/adoption/rollback cases run against the vendored WASM build; at
    least one disk-backed integration test covers `node:sqlite` because CLI tools use that adapter.

Extend existing tests rather than adding a framework. Continue using `node:test` and the shared
database port.

### Phase 4 — Pre-migration recovery snapshot for high-risk changes

This phase is required before releasing the first table rebuild, destructive DML transformation, or
column removal. It may land with the base framework if implementation cost is small, but it should
not delay version-1 adoption when there is no destructive migration.

Worker behavior:

- Before the first high-risk migration mutates the OPFS database, use the already-loaded SQLite WASM
  export API to serialize the original DB to a plain OPFS recovery file.
- Name it with source and target versions, for example
  `linkosh-pre-migration-v2-to-v3.sqlite`; never overwrite the active SAH-pool database.
- Finish and close the recovery-file write before starting migration SQL.
- If the snapshot cannot be completed, abort a high-risk migration before mutation and report that
  additional storage may be required.
- Retain at most one confirmed recovery snapshot to prevent unbounded quota growth. Replace/delete
  an older snapshot only after the new snapshot has been completely written.
- Add a recovery export path that remains usable when normal DB initialization fails. The popup or
  options page should be able to download the snapshot/current rolled-back DB without invoking
  schema-dependent list/search handlers.

Represent risk explicitly in the migration descriptor (for example `risk: 'additive' |
'transforming'`) or in a worker-visible migration plan. The core migration runner remains
engine-agnostic and does not perform OPFS I/O.

For Node file tooling, users normally work on an exported copy. If `openDbFile` is allowed to apply a
high-risk migration to an arbitrary path, create a sibling backup before opening it for mutation or
require an explicit opt-out flag. Do not hide that behavior inside the core database port.

Tests should cover snapshot-before-mutation ordering, snapshot write failure, retention, and export
availability after an injected migration failure. Browser/OPFS persistence still requires the live
smoke test below.

### Phase 5 — Durable contributor guideline and release checklist

After the code establishes the real API, add [database-migrations.md](../database-migrations.md) as
the concise maintained contributor guide and update the schema section of the repository guidance.
Link to code/tests instead of duplicating implementation details from this plan.

The guide should provide a copyable checklist:

1. Choose the next integer and a descriptive immutable name.
2. Update canonical latest-schema DDL.
3. Add exactly one ordered migration.
4. Specify transformations, invalid legacy-data handling, invariants, and risk classification.
5. Update repositories/domain types in the same release.
6. Add previous-version, skipped-version, rollback, preservation, and fresh-equivalence tests.
7. Benchmark against a representative large exported database.
8. Run automated gates and the live extension smoke test.
9. Export/open the migrated DB with Node tooling and inspect its stored version.
10. Record the DB version change in release notes; never edit the migration after release.

## Verification and release gates

### Automated

Run:

```sh
npm test
npm run build
```

`npm test` remains the primary gate because it typechecks every container and executes schema tests
against the shipped SQLite WASM build. The disk-backed Node migration integration test must also be
part of this command.

For each real future migration, additionally run it against:

- a minimal database at the immediately previous version;
- a database several supported versions behind;
- a representative large, scrubbed export copy; and
- malformed-but-anticipated legacy values identified in the migration design.

Record elapsed time and resulting file-size growth for the large copy. A migration that can make
extension startup appear hung needs either UI progress/recovery treatment or the staged backfill
design described above.

### Live extension smoke test

Using a disposable Chrome profile or a backed-up real database:

1. Load the previous extension build and create representative data: normal saved items, a starred
   item, a soft-deleted item, embeddings, and capture-mode raw rows.
2. Export the pre-upgrade database and record `PRAGMA user_version`, counts, and representative
   values.
3. Upgrade/reload the new unpacked extension without clearing origin storage.
4. Confirm the worker logs the expected source/target versions exactly once.
5. Reopen popup and full page; verify list, FTS, semantic/hybrid search, starred/deleted views,
   similar items, raw ingest, and export.
6. Restart Chrome/reload the extension and confirm initialization is now a no-op.
7. Open the exported post-upgrade database with the Node tools and verify the current version.
8. For a high-risk migration, verify the pre-migration snapshot can be downloaded and opened.

Also test downgrade protection by opening a copied newer-version DB with older code under Node. It
must fail before modifying the copy; do not point an older live extension at the user's only OPFS
database merely to test this path.

## Example of a future migration change

Suppose version 2 adds a nullable `archived_reason` field to `saved_items`.

The release should contain all of the following:

```ts
export const CURRENT_DATABASE_VERSION = 2;

const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: "add-saved-item-archived-reason",
    up(db) {
      db.exec("ALTER TABLE saved_items ADD COLUMN archived_reason TEXT");
    },
  },
];
```

- `archived_reason TEXT` is also added to the canonical `CREATE TABLE saved_items` statement.
- The repository selects/updates it only after initialization can guarantee version 2.
- Tests migrate a version-1 row, verify its value is `NULL`, compare the result with a fresh
  version-2 schema, verify a second open is a no-op, and verify rollback with an injected failing
  migration.

This example is illustrative only; do not add an unused column to implement the framework.

## Acceptance criteria

The migration framework is complete when:

- existing unversioned OPFS databases are adopted in place with all saved data preserved;
- new databases are stamped with the current database version;
- every writable opener uses one shared core migration runner;
- skipped versions migrate sequentially and each committed step advances `user_version` atomically;
- failed migrations roll back and retry from the last committed version;
- newer databases are rejected without mutation;
- fresh and upgraded schemas are demonstrably equivalent;
- both WASM and Node database paths are covered;
- contributors have an enforced, documented workflow for DDL and DML changes; and
- destructive migrations cannot ship before an automatic, user-recoverable snapshot path exists.

## Non-goals

- Migrating the abandoned pre-TypeScript database that intentionally used a different OPFS
  filename.
- Automatic downgrade/down migrations.
- Synchronizing schema versions across devices; the SQLite file is local to one extension origin.
- A generic online/resumable backfill framework before a concrete large-data migration requires it.
- Treating provider payload changes, parser changes, preferences, or embedding recipe changes as
  database schema migrations when persisted compatibility is unchanged.
