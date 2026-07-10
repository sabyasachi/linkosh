// The raw_data repo — the capture-mode archive (see schema.ts). Rows leave
// as camelCase `RawDataRow` with context/externalIds JSON-decoded.
import type { Json, PageKind, ProviderId, RawDataRow, RawPage, RawStatus } from "../types.ts";
import type { SqlDatabase } from "./port.ts";

const RAW_COLUMNS = [
  "id",
  "provider",
  "account",
  "kind",
  "url",
  "page",
  "context",
  "body",
  "external_ids AS externalIds",
  "fetched_at AS fetchedAt",
  "status",
  "ingested_at AS ingestedAt",
  "error",
].join(", ");

type RawRow = Omit<RawDataRow, "context" | "externalIds"> & {
  context: string | null;
  externalIds: string;
};

function decodeRaw(row: RawRow): RawDataRow {
  return {
    ...row,
    context: row.context === null ? null : (JSON.parse(row.context) as Json),
    externalIds: JSON.parse(row.externalIds) as string[],
  };
}

export interface RawStoreArgs {
  provider: ProviderId;
  account: string;
  page: RawPage;
  /** Item ids parsed at crawl time — feeds rawKnownIds without re-parsing. */
  externalIds: string[];
  fetchedAt: number;
}

export function rawStore(db: SqlDatabase, { provider, account, page, externalIds, fetchedAt }: RawStoreArgs): { stored: number } {
  db.run(
    `INSERT INTO raw_data (provider, account, kind, url, page, context, body, external_ids, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      provider,
      account,
      page.kind,
      page.url,
      page.page,
      page.context === undefined ? null : JSON.stringify(page.context),
      page.body,
      JSON.stringify(externalIds),
      fetchedAt,
    ]
  );
  return { stored: 1 };
}

export interface RawSelectArgs {
  provider?: ProviderId | null;
  limit?: number;
}

function selectByStatus(db: SqlDatabase, status: RawStatus, { provider, limit = 10000 }: RawSelectArgs): RawDataRow[] {
  return db
    .rows<RawRow>(
      `SELECT ${RAW_COLUMNS} FROM raw_data
       WHERE status = ? ${provider ? "AND provider = ?" : ""}
       ORDER BY id ASC LIMIT ?`,
      provider ? [status, provider, limit] : [status, limit]
    )
    .map(decodeRaw);
}

/** Un-ingested rows, oldest first so replay preserves fetch order. */
export function rawPending(db: SqlDatabase, args: RawSelectArgs = {}): RawDataRow[] {
  return selectByStatus(db, "pending", args);
}

/** Rows whose last ingest attempt threw — kept for a fixed parser to retry. */
export function rawFailed(db: SqlDatabase, args: RawSelectArgs = {}): RawDataRow[] {
  return selectByStatus(db, "failed", args);
}

/** Every row regardless of status — the "pipeline changed, re-run it" path. */
export function rawAll(db: SqlDatabase, { provider, limit = 100000 }: RawSelectArgs = {}): RawDataRow[] {
  return db
    .rows<RawRow>(
      `SELECT ${RAW_COLUMNS} FROM raw_data
       ${provider ? "WHERE provider = ?" : ""} ORDER BY id ASC LIMIT ?`,
      provider ? [provider, limit] : [limit]
    )
    .map(decodeRaw);
}

export function rawMark(
  db: SqlDatabase,
  { id, status, error = null }: { id: number; status: RawStatus; error?: string | null }
): { id: number; status: RawStatus } {
  db.run("UPDATE raw_data SET status = ?, ingested_at = ?, error = ? WHERE id = ?", [
    status,
    status === "ingested" ? Date.now() : null,
    error,
    id,
  ]);
  return { id, status };
}

/** External ids parsed at crawl time from pages fetched up to the cutoff —
 *  the capture-mode counterpart of knownIds. All statuses count: an ingested
 *  row's items may have landed in saved_items *after* the cutoff (ingest runs
 *  later), so the raw row's fetch time is the right clock. */
export function rawKnownIds(
  db: SqlDatabase,
  { provider, fetchedBefore }: { provider: ProviderId; fetchedBefore?: number }
): string[] {
  const found = db.rows<{ externalIds: string }>(
    `SELECT external_ids AS externalIds FROM raw_data WHERE provider = ?
     ${fetchedBefore ? "AND fetched_at <= ?" : ""}`,
    fetchedBefore ? [provider, fetchedBefore] : [provider]
  );
  return found.flatMap((r) => JSON.parse(r.externalIds) as string[]);
}

export function rawClear(db: SqlDatabase, { provider }: { provider?: ProviderId | null } = {}): { cleared: true } {
  db.run(`DELETE FROM raw_data ${provider ? "WHERE provider = ?" : ""}`, provider ? [provider] : []);
  return { cleared: true };
}

export interface RawStatsRow {
  provider: ProviderId;
  status: RawStatus;
  pages: number;
  bytes: number;
}

export function rawStats(db: SqlDatabase): RawStatsRow[] {
  return db.rows<RawStatsRow>(
    `SELECT provider, status, COUNT(*) AS pages, SUM(LENGTH(body)) AS bytes
     FROM raw_data GROUP BY provider, status ORDER BY provider, status`
  );
}

/** Parse dialect of a stored row, for tools that re-dispatch to parsers. */
export function isPageKind(kind: string): kind is PageKind {
  return ["items", "stories", "comments", "collections", "playlists", "connection"].includes(kind);
}
