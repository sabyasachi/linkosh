// The MV3 service worker — pure composition root. Builds the ProviderEnv,
// the seven providers, the RPC clients to the offscreen-hosted workers, and
// serves BackgroundApi to the UI. All behavior lives in
// ext/background-service.ts (shared with the Node dev harness) and core/.
import { createClient } from "../core/rpc/client.ts";
import { runtimeTransport, serveRuntime, type RuntimeLike } from "../core/rpc/transports.ts";
import type { Transport } from "../core/rpc/protocol.ts";
import type { DbWorkerApi } from "../core/db/service.ts";
import type { AiApi } from "../core/ai/api.ts";
import type { Provider, ProviderId } from "../core/types.ts";
import { createBackgroundService, type BackgroundApi } from "./background-service.ts";
import { createChromePrefs } from "./chrome-prefs.ts";
import { createChromeProviderEnv } from "./providers/env.ts";
import * as linkedin from "./providers/linkedin.ts";
import * as instagram from "./providers/instagram.ts";
import * as youtube from "./providers/youtube.ts";
import * as hackernews from "./providers/hackernews.ts";
import * as twitter from "./providers/twitter.ts";
import * as facebook from "./providers/facebook.ts";
import * as substack from "./providers/substack.ts";

const runtime = chrome.runtime as unknown as RuntimeLike;

// ---------- offscreen document (hosts the DB + AI workers) ----------

let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "pages/offscreen.html",
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification:
        "Hosts the SQLite (WASM) database worker; service workers cannot spawn " +
        "dedicated workers or use synchronous OPFS file handles.",
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

/** runtimeTransport that spins the offscreen document up before each call. */
function offscreenTransport(target: "db" | "ai"): Transport {
  const inner = runtimeTransport(runtime, target);
  return {
    async call(op, args) {
      await ensureOffscreen();
      return inner.call(op, args);
    },
  };
}

// ---------- wiring ----------

const env = createChromeProviderEnv();

// Add new services here as they land (parser in core/parse, fetcher in
// ext/providers — see CLAUDE.md).
const PROVIDERS: Partial<Record<ProviderId, Provider>> = {};
for (const mod of [linkedin, instagram, youtube, hackernews, twitter, facebook, substack]) {
  const provider = mod.createProvider(env);
  PROVIDERS[provider.id] = provider;
}

const service = createBackgroundService({
  providers: PROVIDERS,
  db: createClient<DbWorkerApi>(offscreenTransport("db")),
  ai: createClient<AiApi>(offscreenTransport("ai")),
  prefs: createChromePrefs(),
});

serveRuntime<BackgroundApi>(runtime, "background", service);

// Drain any embedding backlog left over from a browser restart or a crash
// mid-backlog (the loop is idempotent — see core/ai/orchestrator.ts). The
// offscreen document survives SW restarts, so repeated wakes mostly no-op.
void service.embed({});
