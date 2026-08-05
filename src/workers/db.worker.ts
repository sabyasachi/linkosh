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
import { DatabaseOpenError } from "../core/errors.ts";
import { initializeDatabase } from "../core/db/migrations.ts";
import { wasmDb, type WasmSqlDatabase } from "../core/db/wasm.ts";
import { createDbService, gateDbWorkerHandlers, type DbWorkerApi } from "../core/db/service.ts";
import { ingestPending, reingest } from "../core/ingest.ts";
import { serveWorker, type WorkerScopeLike } from "../core/rpc/transports.ts";
import type { Handlers } from "../core/rpc/protocol.ts";

interface OpenedDbHost {
  sqlite3: Sqlite3Static;
  db: WasmSqlDatabase;
  export: Handlers<DbWorkerApi>["export"];
}

const opened: Promise<OpenedDbHost> = (async () => {
  const sqlite3 = await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "linkosh" });
  // The filename is versioned: the pre-TypeScript predecessor used a
  // different schema with no migration path, so a fresh name guarantees
  // CREATE TABLE IF NOT EXISTS never meets stale DDL.
  const db = wasmDb(new poolUtil.OpfsSAHPoolDb("/linkosh-v1.sqlite"));

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

  return { sqlite3, db, export: () => exportDb() };
})().catch((cause: unknown) => {
  console.error("Database open failed", cause);
  throw new DatabaseOpenError(undefined, cause);
});

const migrated: Promise<Handlers<DbWorkerApi>> = opened.then(({ db, export: exportHandler }) => {
  try {
    const result = initializeDatabase(db);
    if (result.created || result.applied.length) {
      const steps = result.applied.map((step) => `${step.version} ${step.name}`).join(", ");
      console.info(
        `Database ${result.fromVersion} → ${result.toVersion}` +
          (steps ? ` (${steps})` : " (created latest schema)")
      );
    }
  } catch (error) {
    console.error("Database initialization failed", error);
    throw error;
  }

  const handlers: Handlers<DbWorkerApi> = {
    ...createDbService(db),
    export: exportHandler,
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

  return handlers;
});

// Export needs only a successfully opened handle. Every other operation fails
// closed until schema validation/migration has completed.
serveWorker<DbWorkerApi>(
  self as unknown as WorkerScopeLike,
  gateDbWorkerHandlers(opened.then(({ export: exportHandler }) => ({ export: exportHandler })), migrated)
);
