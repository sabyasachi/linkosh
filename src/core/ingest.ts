// raw:ingest — replay archived raw_data pages through the same parse + upsert
// pipeline a normal sync uses (core/parse + items.upsert), so pipeline
// changes can be iterated offline and applied without re-fetching from the
// services. Pure module — runs in the extension's DB worker (rawIngest op)
// and under Node (tools/ingest.ts, tests) unchanged.
import type { IngestReport, ProviderId, RawDataRow } from "./types.ts";
import type { SqlDatabase } from "./db/port.ts";
import { upsert } from "./db/items.ts";
import { rawAll, rawFailed, rawMark, rawPending } from "./db/raw.ts";
import { parsePage } from "./parse/index.ts";

/** Parse one raw_data row and upsert its items. Throws on a parse failure —
 *  callers mark the row 'failed' so the body survives as a debuggable,
 *  re-runnable fixture. Aux pages (collections, playlists) yield no items
 *  and upsert nothing. */
export function ingestRow(
  db: SqlDatabase,
  row: RawDataRow
): { inserted: number; updated: number; items: number } {
  const parsed = parsePage(row.provider, {
    kind: row.kind,
    body: row.body,
    ...(row.context !== null ? { context: row.context } : {}),
    fetchedAt: row.fetchedAt,
  });
  let inserted = 0;
  let updated = 0;
  if (parsed.items.length) {
    const res = upsert(db, { provider: row.provider, account: row.account, items: parsed.items });
    inserted = res.inserted;
    updated = res.updated;
  }
  return { inserted, updated, items: parsed.items.length };
}

function ingestRows(db: SqlDatabase, rowList: RawDataRow[]): IngestReport {
  const result: IngestReport = {
    pages: rowList.length,
    ingested: 0,
    failed: 0,
    inserted: 0,
    updated: 0,
    errors: [],
  };
  for (const row of rowList) {
    try {
      const res = ingestRow(db, row);
      rawMark(db, { id: row.id, status: "ingested" });
      result.ingested++;
      result.inserted += res.inserted;
      result.updated += res.updated;
    } catch (e) {
      // One bad page shouldn't sink the batch: mark it failed (keeping the
      // body) and carry on. Fix the parser, re-run, and it gets picked up —
      // ingestPending includes previously-failed rows for exactly that.
      const error = e instanceof Error ? e.message : String(e);
      rawMark(db, { id: row.id, status: "failed", error });
      result.failed++;
      result.errors.push({ id: row.id, provider: row.provider, error });
    }
  }
  return result;
}

/** Ingest every not-yet-ingested row (pending and previously failed),
 *  oldest-first so replay preserves fetch order. */
export function ingestPending(db: SqlDatabase, { provider }: { provider?: ProviderId | null } = {}): IngestReport {
  const pending = rawPending(db, { provider: provider ?? null });
  const failed = rawFailed(db, { provider: provider ?? null });
  return ingestRows(db, [...pending, ...failed].sort((a, b) => a.id - b.id));
}

/** Re-run the pipeline over the whole archive, ingested rows included — the
 *  "the pipeline changed" path. Upsert is idempotent, and rows whose
 *  title/publication/summary text changes are automatically re-queued for
 *  embedding by the upsert's invalidation CASE. */
export function reingest(db: SqlDatabase, { provider }: { provider?: ProviderId | null } = {}): IngestReport {
  return ingestRows(db, rawAll(db, { provider: provider ?? null }));
}
