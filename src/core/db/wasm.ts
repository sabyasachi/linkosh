// SqlDatabase adapter over the vendored SQLite WASM oo1 API. Pure ES — the
// vendor import below is type-only and fully erased at emit, so this module
// runs anywhere (DB worker, Node tests) the caller can supply an oo1 handle.
import type { Oo1Db } from "../../vendor/sqlite3.mjs";
import { runTransaction, type SqlDatabase, type SqlRow, type SqlValue } from "./port.ts";

/** The oo1 handle stays reachable for engine-level calls the port doesn't
 *  model: sqlite3_js_db_export (worker export op, dev-harness download) and
 *  sqlite3_deserialize (opening exported bytes). */
export interface WasmSqlDatabase extends SqlDatabase {
  oo1: Oo1Db;
}

export function wasmDb(db: Oo1Db): WasmSqlDatabase {
  return {
    oo1: db,
    exec(sql) {
      db.exec(sql);
    },
    run(sql, bind = []) {
      db.exec({ sql, bind });
    },
    rows<T extends object = SqlRow>(sql: string, bind: SqlValue[] = []): T[] {
      const result = db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as T[];
      // oo1 builds rows with a non-standard prototype; normalize to plain
      // objects so deepEqual/structuredClone behave (node:sqlite adapter too).
      return result.map((row) => Object.fromEntries(Object.entries(row)) as T);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(bind = []) {
          stmt.bind(bind).stepReset();
        },
        finalize() {
          stmt.finalize();
        },
      };
    },
    transaction(fn) {
      return runTransaction(this, fn);
    },
    close() {
      db.close();
    },
  };
}
