// The SqlDatabase port — the seam between all DB logic (schema, repos,
// search) and the two engines that implement it: the vendored SQLite WASM
// oo1 API (extension worker + tests) and node:sqlite (file-backed CLI tools).
// Everything above this interface is engine-agnostic and Node-testable.

export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  /** Bind, execute one step, reset — the batched-write workhorse. */
  run(bind?: SqlValue[]): void;
  finalize(): void;
}

export interface SqlDatabase {
  /** Execute one or more statements, no bind, no results (DDL, BEGIN…). */
  exec(sql: string): void;
  /** Execute a single bound statement, discarding any results. */
  run(sql: string, bind?: SqlValue[]): void;
  /** Execute a single bound query, returning object rows. The cast to T is
   *  the caller's assertion — column aliases in the SQL define the shape. */
  rows<T extends object = SqlRow>(sql: string, bind?: SqlValue[]): T[];
  prepare(sql: string): SqlStatement;
  /** BEGIN/COMMIT with ROLLBACK on throw. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Shared transaction wrapper for adapters whose engine has no native one. */
export function runTransaction<T>(db: Pick<SqlDatabase, "exec">, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
