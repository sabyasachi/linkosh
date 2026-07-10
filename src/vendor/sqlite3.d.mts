// Hand-written declarations for the vendored SQLite WASM build (sqlite3.mjs).
// Typed to the surface this codebase actually uses — the oo1 API consumed by
// the SqlDatabase adapters, the SAH-pool VFS install, and the capi/wasm
// helpers used by export/deserialize. Not a complete API description.
// The vendored build itself is never edited (see CLAUDE.md).

/** Bind values accepted by the oo1 API for our usage. */
export type Oo1BindValue = string | number | bigint | null | Uint8Array;

export interface Oo1ExecOptions {
  sql: string;
  bind?: Oo1BindValue[];
  rowMode?: "object" | "array" | "stmt";
  returnValue?: "resultRows" | "this" | "saveSql";
  resultRows?: unknown[];
}

export interface Oo1Statement {
  bind(values: Oo1BindValue[]): this;
  step(): boolean;
  stepReset(): this;
  reset(): this;
  get(asType: Record<string, unknown>): Record<string, unknown>;
  finalize(): void;
}

export declare class Oo1Db {
  constructor(filename?: string, flags?: string);
  /** Numeric WASM pointer to the underlying sqlite3* handle. */
  pointer: number;
  exec(sql: string): this;
  exec(opts: Oo1ExecOptions): unknown;
  prepare(sql: string): Oo1Statement;
  close(): void;
}

export interface SAHPoolUtil {
  /** oo1.DB subclass bound to the OPFS SAH-pool VFS. */
  OpfsSAHPoolDb: new (filename: string) => Oo1Db;
  wipeFiles(): Promise<void>;
}

export interface Sqlite3Static {
  oo1: { DB: typeof Oo1Db };
  capi: {
    /** Freshly allocated, plain-ArrayBuffer-backed copy of the DB file. */
    sqlite3_js_db_export(dbPointer: number): Uint8Array<ArrayBuffer>;
    sqlite3_deserialize(
      dbPointer: number,
      schema: string,
      data: number,
      size: number,
      bufferSize: number,
      flags: number
    ): number;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
  };
  wasm: {
    allocFromTypedArray(bytes: Uint8Array): number;
  };
  installOpfsSAHPoolVfs(opts: { name: string }): Promise<SAHPoolUtil>;
}

export interface Sqlite3InitOptions {
  /** Node can't fetch file:// URLs — pass the .wasm bytes explicitly. */
  wasmBinary?: Uint8Array | ArrayBuffer;
  print?: (...args: unknown[]) => void;
  printErr?: (...args: unknown[]) => void;
}

declare function sqlite3InitModule(opts?: Sqlite3InitOptions): Promise<Sqlite3Static>;
export default sqlite3InitModule;
