// Promise-shaped DbApi over a direct in-process database — the same shape an
// RPC client presents in the extension, so sync/orchestrator code under test
// sees exactly the surface it sees in production.
import { createDbService, type DbApi } from "../../src/core/db/service.ts";
import type { SqlDatabase } from "../../src/core/db/port.ts";

export type AsyncDbApi = {
  [K in keyof DbApi]: (args: Parameters<DbApi[K]>[0]) => Promise<ReturnType<DbApi[K]>>;
};

export function asyncDbApi(db: SqlDatabase): AsyncDbApi {
  const svc = createDbService(db);
  const out: Record<string, (args: never) => Promise<unknown>> = {};
  for (const [k, fn] of Object.entries(svc)) {
    out[k] = async (args: never) => (fn as (a: never) => unknown)(args);
  }
  return out as AsyncDbApi;
}
