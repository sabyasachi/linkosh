// The saved_items repo: upsert, list, FTS search (+ LIKE fallback), count,
// clear, knownIds. Rows leave this module as the canonical camelCase
// `SavedItem` — snake_case exists only inside the SQL (via column aliases),
// and `collection`/`stats` are JSON-decoded here so nothing downstream ever
// touches JSON text.
import type { ParsedItem, ProviderId, SavedItem } from "../types.ts";
import type { SqlDatabase, SqlValue } from "./port.ts";
import { ftsQuery } from "../fts.ts";

// Explicit projection for every op whose rows may ride a chrome.runtime
// message (JSON-serialized): the embedding BLOB must never be selected there —
// it would be mangled/inflated by JSON serialization and bloat every response.
export const ITEM_COLUMNS = [
  "id",
  "provider",
  "account",
  "external_id AS externalId",
  "url",
  "title",
  "publication",
  "summary",
  "image",
  "kind",
  "duration",
  "collection",
  "poster_name AS posterName",
  "poster_handle AS posterHandle",
  "poster_bio AS posterBio",
  "stats",
  "bookmarked_at AS bookmarkedAt",
  "published_at AS publishedAt",
  "created_at AS createdAt",
  "deleted_at AS deletedAt",
  "starred_at AS starredAt",
].join(", ");

// Same projection qualified with the saved_items alias, for the FTS join
// (several column names exist in both tables).
const ITEM_COLUMNS_S = ITEM_COLUMNS.split(", ")
  .map((c) => `s.${c}`)
  .join(", ");

/** A saved_items row as SQL returns it: SavedItem except the JSON-text
 *  columns are still strings. */
type ItemRow = Omit<SavedItem, "collection" | "stats" | "similarity"> & {
  collection: string;
  stats: string;
};

function decodeItem(row: ItemRow): SavedItem {
  return {
    ...row,
    collection: JSON.parse(row.collection) as string[],
    stats: JSON.parse(row.stats) as Record<string, string>,
  };
}

export function fetchItems(db: SqlDatabase, sql: string, bind: SqlValue[]): SavedItem[] {
  return db.rows<ItemRow>(sql, bind).map(decodeItem);
}

/** Full item rows for a list of ids, returned in the ids' order. */
export function fetchByIds(db: SqlDatabase, ids: number[]): SavedItem[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const fetched = fetchItems(
    db,
    `SELECT ${ITEM_COLUMNS} FROM saved_items WHERE id IN (${placeholders})`,
    ids
  );
  const byId = new Map(fetched.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r) => r !== undefined);
}

/** Union of the stored collection list and the incoming one, first-seen
 *  casing wins, case-insensitive de-dup. Collections accumulate across pages
 *  and syncs — an item can be in several, discovered one at a time. */
function mergeCollections(storedJson: string | undefined, incoming: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const stored = storedJson ? (JSON.parse(storedJson) as string[]) : [];
  for (const name of [...stored, ...incoming]) {
    const trimmed = String(name).trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return JSON.stringify(out);
}

export interface UpsertArgs {
  provider: ProviderId;
  account: string;
  items: ParsedItem[];
}

export function upsert(db: SqlDatabase, { provider, account, items }: UpsertArgs): {
  inserted: number;
  updated: number;
} {
  const existing = new Set(knownIds(db, { provider }));
  const stmt = db.prepare(`
    INSERT INTO saved_items
      (provider, account, external_id, url, title, publication, summary, image, kind, duration, collection, poster_name, poster_handle, poster_bio, stats, bookmarked_at, published_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    -- deleted_at and starred_at are deliberately absent from this SET list:
    -- an item that is still saved on the service flows back through upsert on
    -- every incremental sync, and refreshing its fields must not undelete or
    -- unstar it.
    ON CONFLICT (provider, account, external_id) DO UPDATE SET
      url = excluded.url,
      title = excluded.title,
      publication = excluded.publication,
      summary = excluded.summary,
      image = excluded.image,
      kind = excluded.kind,
      duration = excluded.duration,
      collection = excluded.collection,
      poster_name = excluded.poster_name,
      poster_handle = excluded.poster_handle,
      poster_bio = excluded.poster_bio,
      stats = excluded.stats,
      bookmarked_at = COALESCE(excluded.bookmarked_at, saved_items.bookmarked_at),
      published_at = COALESCE(excluded.published_at, saved_items.published_at),
      -- Invalidate the embedding when the text it was computed from changes;
      -- NULL puts the row back on the pendingEmbeddings backlog. IS, not =,
      -- so NULL text columns compare as equal instead of unknown.
      embedding = CASE WHEN excluded.title IS saved_items.title
                        AND excluded.publication IS saved_items.publication
                        AND excluded.summary IS saved_items.summary
                  THEN saved_items.embedding ELSE NULL END,
      embedding_model = CASE WHEN excluded.title IS saved_items.title
                              AND excluded.publication IS saved_items.publication
                              AND excluded.summary IS saved_items.summary
                        THEN saved_items.embedding_model ELSE NULL END
  `);
  const now = Date.now();
  let inserted = 0;
  try {
    db.transaction(() => {
      for (const item of items) {
        const prev = db.rows<{ collection: string }>(
          "SELECT collection FROM saved_items WHERE provider = ? AND account = ? AND external_id = ?",
          [provider, account, item.externalId]
        )[0];
        stmt.run([
          provider,
          account,
          item.externalId,
          item.url || "",
          item.title ?? "",
          item.publication ?? "",
          item.summary ?? "",
          item.image ?? "",
          item.kind ?? "",
          // 0 means "absent" for these numeric fields (no playable length; no
          // exposed save/publish time — epoch 0 is never a real timestamp), so
          // coerce it to NULL. Load-bearing for bookmarked_at: the list sorts
          // by COALESCE(bookmarked_at, published_at, 0), and a stored 0 would
          // defeat the fallback and sink the row to epoch 0. Use `|| null`
          // (not `?? null`) so 0 — falsy — collapses to NULL like the old
          // pipeline did.
          item.duration || null,
          mergeCollections(prev?.collection, item.collection ?? []),
          item.posterName ?? "",
          item.posterHandle ?? "",
          item.posterBio ?? "",
          JSON.stringify(item.stats ?? {}),
          item.bookmarkedAt || null,
          item.publishedAt || null,
          now,
        ]);
        if (!existing.has(item.externalId)) {
          inserted++;
          existing.add(item.externalId);
        }
      }
    });
  } finally {
    stmt.finalize();
  }
  return { inserted, updated: items.length - inserted };
}

/** createdBefore (epoch ms, optional) restricts to items inserted up to that
 *  time — used to ignore rows landed by a failed partial sync, whose presence
 *  would otherwise cut the next incremental run short. */
export function knownIds(
  db: SqlDatabase,
  { provider, createdBefore }: { provider: ProviderId; createdBefore?: number }
): string[] {
  return db
    .rows<{ externalId: string }>(
      `SELECT external_id AS externalId FROM saved_items WHERE provider = ?
       ${createdBefore ? "AND created_at <= ?" : ""}`,
      createdBefore ? [provider, createdBefore] : [provider]
    )
    .map((r) => r.externalId);
}

export interface ListArgs {
  /** null/absent means "across all providers" (the UI's "all"). */
  provider?: ProviderId | null;
  /** true lists the trash (soft-deleted rows) instead of live items. */
  deleted?: boolean;
  /** true restricts to starred rows (composes with deleted: a starred item in
   *  the trash shows in the trash, not the starred view). */
  starred?: boolean;
  limit?: number;
  offset?: number;
}

export function list(
  db: SqlDatabase,
  { provider, deleted = false, starred = false, limit = 1000, offset = 0 }: ListArgs
): SavedItem[] {
  // bookmarked_at DESC sorts providers that expose a true save timestamp
  // newest-first; published_at is the content-time fallback. Rows with
  // neither timestamp fall through to created_at DESC (newer syncs first)
  // with id ASC preserving the provider's newest-first order within a single
  // sync batch. The sort is deterministic (id breaks ties), so LIMIT/OFFSET
  // paging is stable.
  return fetchItems(
    db,
    `SELECT ${ITEM_COLUMNS} FROM saved_items
     WHERE deleted_at IS ${deleted ? "NOT NULL" : "NULL"}
       ${starred ? "AND starred_at IS NOT NULL" : ""} ${provider ? "AND provider = ?" : ""}
     ORDER BY COALESCE(bookmarked_at, published_at, 0) DESC, created_at DESC, id ASC LIMIT ? OFFSET ?`,
    provider ? [provider, limit, offset] : [limit, offset]
  );
}

/** Soft-delete (or restore) one item. The row and its embedding stay put —
 *  every user-facing read path filters on deleted_at instead. */
export function setDeleted(
  db: SqlDatabase,
  { id, deleted }: { id: number; deleted: boolean }
): { changed: number } {
  db.run("UPDATE saved_items SET deleted_at = ? WHERE id = ?", [deleted ? Date.now() : null, id]);
  return { changed: db.rows<{ n: number }>("SELECT changes() AS n", [])[0]!.n };
}

/** Star (or unstar) one item. */
export function setStarred(
  db: SqlDatabase,
  { id, starred }: { id: number; starred: boolean }
): { changed: number } {
  db.run("UPDATE saved_items SET starred_at = ? WHERE id = ?", [starred ? Date.now() : null, id]);
  return { changed: db.rows<{ n: number }>("SELECT changes() AS n", [])[0]!.n };
}

export interface SearchArgs {
  provider?: ProviderId | null;
  query: string;
  limit?: number;
}

export function search(db: SqlDatabase, { provider, query, limit = 200 }: SearchArgs): SavedItem[] {
  const match = ftsQuery(query);
  if (!match) return list(db, { provider: provider ?? null });
  try {
    return fetchItems(
      db,
      // Deleted rows are still in the FTS index (the update trigger re-adds
      // them), so live-ness is filtered on the joined saved_items row.
      `SELECT ${ITEM_COLUMNS_S} FROM saved_items_fts f
       JOIN saved_items s ON s.id = f.rowid
       WHERE saved_items_fts MATCH ? AND s.deleted_at IS NULL ${provider ? "AND s.provider = ?" : ""}
       ORDER BY rank LIMIT ?`,
      provider ? [match, provider, limit] : [match, limit]
    );
  } catch {
    // FTS5 syntax edge case: fall back to a plain substring scan.
    const like = `%${query.trim()}%`;
    return fetchItems(
      db,
      `SELECT ${ITEM_COLUMNS} FROM saved_items
       WHERE deleted_at IS NULL AND ${provider ? "provider = ? AND" : ""}
         (title LIKE ? OR publication LIKE ? OR summary LIKE ? OR collection LIKE ? OR poster_name LIKE ? OR poster_handle LIKE ?)
       ORDER BY COALESCE(bookmarked_at, published_at, 0) DESC, created_at DESC, id ASC LIMIT ?`,
      provider
        ? [provider, like, like, like, like, like, like, limit]
        : [like, like, like, like, like, like, limit]
    );
  }
}

/** One row per provider that has items stored (status page input). */
export interface ProviderStatsRow {
  provider: ProviderId;
  items: number;
  /** Newest item's save date — MAX over the same COALESCE the list sorts by
   *  (bookmarked_at, else published_at); null when no row exposes either. */
  lastItemAt: number | null;
}

export function providerStats(db: SqlDatabase): ProviderStatsRow[] {
  return db.rows<ProviderStatsRow>(
    `SELECT provider, COUNT(*) AS items,
            MAX(COALESCE(bookmarked_at, published_at)) AS lastItemAt
     FROM saved_items WHERE deleted_at IS NULL GROUP BY provider`,
    []
  );
}

export function count(
  db: SqlDatabase,
  {
    provider,
    deleted = false,
    starred = false,
  }: { provider?: ProviderId | null; deleted?: boolean; starred?: boolean } = {}
): number {
  return db.rows<{ n: number }>(
    `SELECT COUNT(*) AS n FROM saved_items
     WHERE deleted_at IS ${deleted ? "NOT NULL" : "NULL"}
       ${starred ? "AND starred_at IS NOT NULL" : ""} ${provider ? "AND provider = ?" : ""}`,
    provider ? [provider] : []
  )[0]!.n;
}

/** Drop items (all, or one provider) — soft-deleted rows included. The FTS
 *  triggers keep the index in sync per deleted row; embeddings go with the
 *  rows. raw_data is untouched. */
export function clearItems(
  db: SqlDatabase,
  { provider }: { provider?: ProviderId | null } = {}
): { deleted: number } {
  // Not count(): that now means "live rows", and this DELETE takes trash too.
  const deleted = db.rows<{ n: number }>(
    `SELECT COUNT(*) AS n FROM saved_items ${provider ? "WHERE provider = ?" : ""}`,
    provider ? [provider] : []
  )[0]!.n;
  db.run(`DELETE FROM saved_items ${provider ? "WHERE provider = ?" : ""}`, provider ? [provider] : []);
  return { deleted };
}
