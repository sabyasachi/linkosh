// Test-side alias for the shared Node DB helpers (src/node/node-db.ts),
// which tools/ also use. Tests run against the vendored SQLite WASM build —
// the same engine, oo1 API and FTS5 the extension's DB worker uses.
export { loadSqlite3, openDb, openDbFromBytes, exportBytes } from "../../src/node/node-db.ts";
