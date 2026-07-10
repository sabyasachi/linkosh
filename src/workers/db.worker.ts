// Dedicated worker that owns the SQLite database. Runs inside the offscreen
// document (service workers can neither spawn workers nor use the synchronous
// OPFS file handles SQLite needs). The DB file lives in the extension's
// Origin Private File System and survives browser restarts.
//
// All schema and query logic lives in core/db (which also runs under Node for
// tests and tools); this file only owns what is extension-specific: opening
// the OPFS-backed file, the `export` op, and serving DbWorkerApi over
// postMessage.
import sqlite3InitModule, { type Sqlite3Static } from "../vendor/sqlite3.mjs";
import { initSchema } from "../core/db/schema.ts";
import { wasmDb, type WasmSqlDatabase } from "../core/db/wasm.ts";
import { createDbService, type DbWorkerApi } from "../core/db/service.ts";
import { ingestPending, reingest } from "../core/ingest.ts";
import { serveWorker, type WorkerScopeLike } from "../core/rpc/transports.ts";
import type { Handlers } from "../core/rpc/protocol.ts";

interface DbHost {
  sqlite3: Sqlite3Static;
  db: WasmSqlDatabase;
  handlers: Handlers<DbWorkerApi>;
}

const ready: Promise<DbHost> = (async () => {
  const sqlite3 = await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "linkosh" });
  // The filename is versioned: the pre-TypeScript predecessor used a
  // different schema with no migration path, so a fresh name guarantees
  // CREATE TABLE IF NOT EXISTS never meets stale DDL.
  const db = wasmDb(new poolUtil.OpfsSAHPoolDb("/linkosh-v1.sqlite"));
  initSchema(db);

  // Serialized copy of the whole DB file, written to a plain OPFS file. The
  // popup shares the extension origin (and thus the OPFS), so it reads the
  // file directly — chrome.runtime messages cap out at 64 MiB, which a
  // grown DB (base64-inflated, on top) can easily exceed.
  async function exportDb(): Promise<{ file: string; size: number }> {
    const bytes = sqlite3.capi.sqlite3_js_db_export(db.oo1.pointer);
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("linkosh-export.sqlite", { create: true });
    const writable = await handle.createWritable(); // truncates any previous export
    await writable.write(bytes);
    await writable.close();
    return { file: "linkosh-export.sqlite", size: bytes.length };
  }

  const handlers: Handlers<DbWorkerApi> = {
    ...createDbService(db),
    export: () => exportDb(),
    // Replay the raw_data archive through the shared parse+upsert pipeline
    // (core/ingest.ts — the same module tools/ingest.ts runs under Node).
    // Registered here, next to the DB, so page bodies never make a second
    // trip over chrome.runtime.
    rawIngest: (args) => ingestPending(db, args),
    rawReingest: (args) => reingest(db, args),
  };

  // Debugging handles: inspect the DB live from DevTools by selecting this
  // worker in the console context dropdown, e.g.:
  //   __sql("SELECT provider, account, title FROM saved_items LIMIT 5")
  const debugScope = self as unknown as Record<string, unknown>;
  debugScope.__db = db;
  debugScope.__sql = (sql: string, bind: never[] = []) => db.rows(sql, bind);

  return { sqlite3, db, handlers };
})();

// Every op waits for the DB to open; unknown ops fail inside the handler.
serveWorker<DbWorkerApi>(
  self as unknown as WorkerScopeLike,
  new Proxy({} as Handlers<DbWorkerApi>, {
    get(_target, op: string) {
      return async (args: never) => {
        const { handlers } = await ready;
        const handler = (handlers as Record<string, (args: never) => unknown>)[op];
        if (!handler) throw new Error(`Unknown DB op: ${op}`);
        return handler(args);
      };
    },
  })
);
