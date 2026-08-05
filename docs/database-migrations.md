# Database migrations

Linkosh persists its application schema version in SQLite's `PRAGMA user_version`. The database
version is independent of the extension/package version. `0` is the deployed unversioned
TypeScript-era shape, `1` is the frozen adoption baseline, and every later persisted change advances
the version by exactly one.

The runtime entry point is `initializeDatabase` in `src/core/db/migrations.ts`. Startup either
creates the latest schema directly for an empty database, adopts version 0 and applies every skipped
migration in order, or rejects unsafe access without changing the database. The DB worker keeps
export available after a successful SQLite open even when initialization fails.

## Adding a migration

Every persisted schema or data change must update both sides of the compatibility contract:

1. Edit the canonical latest-schema DDL in `src/core/db/schema.ts`. Fresh databases are created from
   this end state and do not replay history.
2. Increment `CURRENT_DATABASE_VERSION` by one and append exactly one `Migration` with that target
   number to the immutable, contiguous registry in `src/core/db/migrations.ts`.
3. Add fixtures for the immediately previous version and at least one skipped-version path. Assert
   normalized fresh-vs-upgraded schema equivalence and repository/FTS behavior.
4. Run `npm test` and `npm run build`, then perform the live upgrade checklist below.

Never edit the number, name, ordering, or body of a released migration. Never reuse a version.
`PRAGMA user_version = N` cannot bind `N`; only the validated registry target may reach that SQL.

The version-1 adoption SQL is an independent frozen copy. It must never import, interpolate, or
alias the evolving `SCHEMA` or `FTS_SCHEMA` constants. Historical test fixtures must likewise define
their own DDL. This isolation ensures a database jumping from version 0 to (for example) version 4
is adopted to exactly version 1 before migrations 2, 3, and 4 run.

## Authoring rules

- Prefer additive DDL. Bind DML values and make transformations deterministic and bounded. A
  migration runs synchronously during startup and must not fetch, read preferences, or depend on
  provider payloads.
- One target version runs in one transaction. Do not open a nested transaction. Perform DDL/DML,
  validate the target invariants, then let the runner set `user_version` as the final statement.
- Preserve user-owned state explicitly: stable item identity, `deleted_at`, `starred_at`, nullable
  timestamps, collection/stats JSON, raw page bodies and statuses, embeddings, and model ids.
- Embeddings are derived data. Prefer lazy recipe/model invalidation through the existing model id
  and `+rN` recipe convention; do not rewrite every embedding merely because the row-text recipe
  changes.
- For an external-content FTS change, drop/recreate all three maintenance triggers in a safe order,
  recreate the FTS table as required, and issue the FTS5 `rebuild` command after the content table is
  in its target shape. Test insert, update, delete, plain text, and column-filter queries.
- For a table rebuild: create the replacement table, copy with explicit source and destination
  column lists, validate row counts/keys/nullability and preserved values, replace the old table,
  recreate named indexes/triggers/FTS objects, and validate again. Never use `SELECT *` for the copy.
- Large changes should use expand/backfill/contract. If the work cannot fit a proven startup-time
  budget, design a separately resumable backfill rather than holding one long startup transaction.

Schema-equivalence tests compare order-insensitive column properties (`name`, `type`, `notnull`,
`dflt_value`, `pk`), named application objects, index membership, required FTS objects, and behavior.
They intentionally ignore physical column order, `cid`, root pages, raw `sqlite_schema.sql`, and
SQLite's internal FTS tables.

## Node file safety

`openDb()` initializes a fresh in-memory WASM database. `openDbFromBytes()` is a byte-faithful,
non-migrating inspection helper. Every `openDbFile()` caller must explicitly choose:

- `{ schema: "inspect", readOnly: true }` for comparison, extraction, and other inspection; or
- `{ schema: "migrate" }` when the caller deliberately permits in-place changes.

The UX server uses migrate mode for `--db`. The ingest CLI also migrates its target and prints the
version transition before ingestion; use `--out` or `--dry-run` to preserve the input file.

## High-risk migration gate

Before the first table rebuild, column removal, destructive DML transformation, or backfill large
enough to threaten startup responsiveness, write a focused design and add safeguards before the
migration ships:

- classify the step's risk before mutation;
- complete a plain OPFS recovery snapshot before a high-risk worker migration and abort if it fails;
- retain at most one confirmed snapshot, expose it through the open-only recovery/export path, and
  define equivalent backup or confirmation behavior for writable Node files;
- benchmark a representative scrubbed export on an agreed device and set a concrete startup limit;
  and
- use a resumable expand/backfill/contract design if that limit is exceeded.

Transaction rollback protects execution failures; the snapshot protects against a logically wrong
transformation that validates and commits. Do not add speculative risk fields or snapshot machinery
before a concrete high-risk migration needs them.

## Release verification

Using a disposable profile or a backed-up real database:

1. Under the previous build, create ordinary, starred, and soft-deleted items, embeddings, and raw
   capture rows. Export the database and record its version/counts and representative values.
2. Upgrade without clearing origin storage. Confirm the worker logs only versions and migration
   names and reports the expected transition exactly once.
3. Verify popup/full-page lists; FTS, hybrid, semantic, and similar-item search; starred/deleted
   views; raw ingest; and export.
4. Restart Chrome and confirm initialization is a no-op. Open the post-upgrade export with Node
   inspection tooling and verify `user_version`.
5. In a development build, inject a migration failure. Normal operations must fail closed while
   Options → Developer → Export remains usable. Test downgrade rejection only on a copied database.

