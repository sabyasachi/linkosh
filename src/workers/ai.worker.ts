// Dedicated worker that runs the embedding model (transformers.js, pinned
// v3.8.1 in vendor/ — see embedders.ts). Separate from db.worker.ts on
// purpose: inference costs tens of ms per item and seconds per batch, and an
// onnxruntime crash/OOM must not take the SQLite worker down. Serves
// EmbedderApi over the shared worker RPC transport.
import { resolveProvider, type EmbeddingProvider } from "./embedders.ts";
import { serveWorker, type WorkerScopeLike } from "../core/rpc/transports.ts";
import type { EmbedderApi } from "../core/ai/api.ts";
import type { Handlers } from "../core/rpc/protocol.ts";
import type { DownloadProgress } from "../core/types.ts";

let provider: EmbeddingProvider = resolveProvider(null); // local by default until configured
let initPromise: Promise<void> | null = null; // in-flight init(), reset when the provider changes
let ready = false; // init() completed for the current provider
let downloading: DownloadProgress | null = null; // while model files download
let initError: string | null = null;

function ensureInit(): Promise<void> {
  initPromise ??= provider
    .init((progress) => (downloading = progress))
    .then(
      () => {
        ready = true;
        downloading = null;
      },
      (e: unknown) => {
        initError = e instanceof Error ? e.message : String(e);
        downloading = null;
        initPromise = null; // allow a retry on the next embed
        throw e;
      }
    );
  return initPromise;
}

const handlers: Handlers<EmbedderApi> = {
  configure({ settings }) {
    const next = resolveProvider(settings);
    // Same local model: keep the loaded pipeline. Cloud providers are always
    // swapped even on an unchanged id — the API key may have changed, and
    // their init() is a no-op so the reset costs nothing.
    if (next.id === provider.id && next.id.startsWith("local:")) return { model: provider.id };
    provider = next;
    initPromise = null;
    ready = false;
    downloading = null;
    initError = null;
    return { model: provider.id };
  },

  status() {
    return {
      ready,
      model: provider.id,
      dim: provider.dim,
      downloading,
      error: initError,
    };
  },

  async embed({ texts }) {
    try {
      await ensureInit();
      const vectors = await provider.embed(texts);
      initError = null;
      return vectors;
    } catch (e: unknown) {
      // init() failures are recorded by ensureInit; cloud providers initialize
      // trivially and fail here instead (bad key, quota, permission, input,
      // network). Keep either kind visible through aiStatus until a successful
      // embed or provider reconfiguration clears it.
      initError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  },
};

serveWorker<EmbedderApi>(self as unknown as WorkerScopeLike, handlers);
