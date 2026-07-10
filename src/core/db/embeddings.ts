// Embedding storage: vectors live inline in saved_items as raw little-endian
// Float32 BLOBs plus the model id that produced them. These ops are called by
// the AI orchestrator over postMessage (which structured-clones typed
// arrays) — vectors never ride chrome.runtime.
import type { SqlDatabase } from "./port.ts";

/** Decode an embedding BLOB (Uint8Array from sqlite) into a Float32Array view. */
export function toVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export interface PendingEmbeddingRow {
  id: number;
  url: string;
  title: string | null;
  publication: string | null;
  summary: string | null;
}

/** Rows still needing an embedding for the current model. `IS NOT` (not `!=`)
 *  so rows with a NULL embedding_model match too. Newest first so fresh syncs
 *  become semantically searchable first. */
export function pendingEmbeddings(
  db: SqlDatabase,
  { model, limit = 64 }: { model: string; limit?: number }
): PendingEmbeddingRow[] {
  return db.rows<PendingEmbeddingRow>(
    `SELECT id, url, title, publication, summary FROM saved_items
     WHERE embedding IS NULL OR embedding_model IS NOT ?
     ORDER BY id DESC LIMIT ?`,
    [model, limit]
  );
}

export function storeEmbeddings(
  db: SqlDatabase,
  { model, rows: batch }: { model: string; rows: { id: number; vector: Float32Array }[] }
): { stored: number } {
  const stmt = db.prepare("UPDATE saved_items SET embedding = ?, embedding_model = ? WHERE id = ?");
  try {
    db.transaction(() => {
      for (const { id, vector } of batch) {
        // sqlite binds Uint8Array as BLOB.
        stmt.run([new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id]);
      }
    });
  } finally {
    stmt.finalize();
  }
  return { stored: batch.length };
}

export function embeddingStats(db: SqlDatabase, { model }: { model: string }): { total: number; embedded: number } {
  const row = db.rows<{ total: number; embedded: number | null }>(
    `SELECT COUNT(*) AS total,
            SUM(embedding IS NOT NULL AND embedding_model IS ?) AS embedded
     FROM saved_items`,
    [model]
  )[0]!;
  return { total: row.total, embedded: row.embedded ?? 0 };
}
