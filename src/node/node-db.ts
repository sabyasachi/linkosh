// Open databases under Node, as SqlDatabase implementations:
//  - the vendored SQLite WASM build (same build, oo1 API and FTS5 the
//    extension's DB worker uses) for tests — one SQLite code path. Node's
//    fetch can't load file:// URLs, so the wasm bytes are passed in
//    explicitly via wasmBinary.
//  - node:sqlite (DatabaseSync) for disk-backed CLI tools, where mutations
//    must land in the file directly.
// Node-only: nothing extension-side imports this file.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import sqlite3InitModule, { type Sqlite3Static } from "../vendor/sqlite3.mjs";
import { initSchema } from "../core/db/schema.ts";
import { wasmDb, type WasmSqlDatabase } from "../core/db/wasm.ts";
import { runTransaction, type SqlDatabase, type SqlRow, type SqlValue } from "../core/db/port.ts";

const wasmPath = new URL("../vendor/sqlite3.wasm", import.meta.url);
const require = createRequire(import.meta.url);

let sqlite3Promise: Promise<Sqlite3Static> | null = null;

export function loadSqlite3(): Promise<Sqlite3Static> {
  sqlite3Promise ??= (async () => {
    // The bootstrap probes browser-only VFSes (OPFS) and warns loudly when
    // they're unavailable; that's expected under Node, so mute it.
    const warn = console.warn;
    const error = console.error;
    console.warn = console.error = () => {};
    try {
      return await sqlite3InitModule({ wasmBinary: readFileSync(wasmPath) });
    } finally {
      console.warn = warn;
      console.error = error;
    }
  })();
  return sqlite3Promise;
}

type NodeSqliteModule = typeof import("node:sqlite");

let nodeSqlite: NodeSqliteModule | null = null;

function loadNodeSqlite(): NodeSqliteModule {
  if (!nodeSqlite) {
    // Node 24 still marks node:sqlite experimental. Keep the CLI output about
    // ingest/search work, not the driver warning, while preserving all other
    // process warnings.
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
      if (args[0] === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
      return (emitWarning as (w: string | Error, ...a: unknown[]) => void).call(process, warning, ...args);
    }) as typeof process.emitWarning;
    try {
      nodeSqlite = require("node:sqlite") as NodeSqliteModule;
    } finally {
      process.emitWarning = emitWarning;
    }
  }
  return nodeSqlite;
}

/** Fresh in-memory WASM DB with the current schema applied. */
export async function openDb(): Promise<WasmSqlDatabase> {
  const sqlite3 = await loadSqlite3();
  const db = wasmDb(new sqlite3.oo1.DB(":memory:"));
  initSchema(db);
  return db;
}

function nodeSqliteDb(db: DatabaseSync): SqlDatabase {
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, bind = []) {
      db.prepare(sql).run(...(bind as never[]));
    },
    rows<T extends object = SqlRow>(sql: string, bind: SqlValue[] = []): T[] {
      // node:sqlite returns rows with a null prototype; normalize to plain objects.
      return db
        .prepare(sql)
        .all(...(bind as never[]))
        .map((row) => Object.fromEntries(Object.entries(row as object)) as T);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(bind = []) {
          stmt.run(...(bind as never[]));
        },
        finalize() {
          // node:sqlite finalizes statements when they are garbage-collected.
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

/** Disk-backed DB using Node's native sqlite driver. Mutations are written
 *  directly to `file`; no deserialize/export copy is involved. */
export function openDbFile(
  file: string,
  { init = true, readOnly = false }: { init?: boolean; readOnly?: boolean } = {}
): SqlDatabase {
  const { DatabaseSync } = loadNodeSqlite();
  const db = nodeSqliteDb(new DatabaseSync(file, readOnly ? { readOnly: true } : {}));
  if (init) initSchema(db);
  return db;
}

/** In-memory WASM DB loaded from a .sqlite file's bytes (e.g. an extension
 *  export). The schema is NOT applied — the bytes carry their own. */
export async function openDbFromBytes(rawBytes: Uint8Array): Promise<WasmSqlDatabase> {
  // A Node Buffer is a Uint8Array subclass, but sqlite3's allocFromTypedArray
  // dispatches on the concrete typed-array class — normalize first.
  const bytes = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const sqlite3 = await loadSqlite3();
  const oo1 = new sqlite3.oo1.DB();
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    oo1.pointer,
    "main",
    p,
    bytes.length,
    bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  );
  if (rc) throw new Error(`sqlite3_deserialize failed: rc=${rc}`);
  return wasmDb(oo1);
}

/** Serialize a WASM DB back to bytes (mirror of the worker's export op). */
export async function exportBytes(db: WasmSqlDatabase): Promise<Uint8Array> {
  const sqlite3 = await loadSqlite3();
  return sqlite3.capi.sqlite3_js_db_export(db.oo1.pointer);
}
