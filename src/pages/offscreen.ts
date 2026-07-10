// The offscreen document: bridges chrome.runtime RPC from the background
// service worker to the dedicated workers it hosts (MV3 service workers
// can't spawn workers) — the SQLite worker (target "db") and, via the
// orchestrator, the embedding worker (target "ai"). Vector traffic stays on
// postMessage between the workers and this document — chrome.runtime
// messages are JSON-serialized and would mangle typed arrays.
import { createClient } from "../core/rpc/client.ts";
import {
  runtimeTransport,
  serveRuntime,
  workerTransport,
  type RuntimeLike,
  type WorkerLike,
} from "../core/rpc/transports.ts";
import type { Handlers, Transport } from "../core/rpc/protocol.ts";
import { createOrchestrator } from "../core/ai/orchestrator.ts";
import type { AiApi, EmbedderApi } from "../core/ai/api.ts";
import type { DbWorkerApi } from "../core/db/service.ts";
import type { BackgroundApi } from "../ext/background-service.ts";

const runtime = chrome.runtime as unknown as RuntimeLike;

// The ?opfs-disable&opfs-wl-disable flags stop sqlite3.mjs from auto-probing
// its SharedArrayBuffer-based OPFS VFSes, which can't work in an extension
// (no cross-origin isolation) and only produce noisy errors on the
// chrome://extensions page. We use the SAH-pool VFS instead (see
// workers/db.worker.ts).
const dbTransport = workerTransport(
  new Worker(chrome.runtime.getURL("workers/db.worker.js") + "?opfs-disable&opfs-wl-disable", {
    type: "module",
  }) as unknown as WorkerLike
);
const aiTransport = workerTransport(
  new Worker(chrome.runtime.getURL("workers/ai.worker.js"), { type: "module" }) as unknown as WorkerLike
);

/** Forward every op of an API to a transport (the target-"db" passthrough). */
function relay<A extends object>(transport: Transport): Handlers<A> {
  return new Proxy({} as Handlers<A>, {
    get: (_target, op) => (args: unknown) => transport.call(String(op), args),
  });
}

serveRuntime<DbWorkerApi>(runtime, "db", relay<DbWorkerApi>(dbTransport));

const orchestrator = createOrchestrator({
  db: createClient<DbWorkerApi>(dbTransport),
  ai: createClient<EmbedderApi>(aiTransport),
  // Settings live in chrome.storage, which this document can't read — relay
  // through the background service.
  getSettings: () => createClient<BackgroundApi>(runtimeTransport(runtime, "background")).getAiSettings({}),
});

serveRuntime<AiApi>(runtime, "ai", orchestrator);
