// Embedding providers. Currently one: local transformers.js, fully on-device.
// The EmbeddingProvider interface + resolveProvider(settings) seam is where
// cloud providers (OpenAI/Gemini/Voyage, removed 2026-07 — see git history)
// plug back in: implement the interface, branch on settings.embedProvider
// here, and re-add the options-page key fields + manifest
// optional_host_permissions. Every provider must return L2-normalized
// Float32Array vectors so cosine similarity == dot product everywhere
// downstream (core/db/search.ts relies on this).
import { pipeline, env, type FeatureExtractionPipeline } from "../vendor/transformers.min.js";
import type { AiSettings, DownloadProgress } from "../core/types.ts";
import type { EmbedKind } from "../core/ai/api.ts";
import { ROWTEXT_VERSION } from "../core/ai/orchestrator.ts";

export interface EmbeddingProvider {
  id: string;
  dim: number;
  init(onProgress?: (p: DownloadProgress) => void): Promise<void>;
  /** `kind` matters only to retrieval-trained models (bge prefixes queries);
   *  symmetric providers ignore it. */
  embed(texts: string[], kind?: EmbedKind): Promise<Float32Array[]>;
}

// transformers.js setup for MV3: the ORT wasm runtime must load from the
// extension bundle (remote code is forbidden), while model *weights* (data,
// not code) are fetched from huggingface.co on first use and persisted via
// the Cache API (env.useBrowserCache defaults to true) — offline after that.
// import.meta.url (not chrome.runtime.getURL — the chrome APIs don't exist
// inside dedicated workers) resolves to chrome-extension://<id>/vendor/ort/.
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;

const MISSING_CONTENT_LENGTH_WARNING =
  "Unable to determine content-length from response headers. Will expand buffer when needed.";

/** Transformers.js warns when Hugging Face serves model weights with chunked
 *  transfer encoding. Its downloader handles that case correctly by growing
 *  the buffer, but Chrome records console.warn calls as extension issues. The
 *  warning is emitted only when a progress callback is installed, which we
 *  need for options-page status, so suppress this one known-benign message at
 *  our integration boundary and leave every other vendor warning untouched. */
async function loadLocalPipeline(
  onProgress?: (p: DownloadProgress) => void
): Promise<FeatureExtractionPipeline> {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === MISSING_CONTENT_LENGTH_WARNING) return;
    originalWarn.apply(console, args);
  };
  try {
    return await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p) => {
        if (p.status === "progress" && onProgress) {
          onProgress({ loaded: p.loaded ?? 0, total: p.total ?? 0 });
        }
      },
    });
  } finally {
    console.warn = originalWarn;
  }
}

/** bge's retrieval training expects search queries wrapped in this exact
 *  instruction (documents stay bare); skipping it forfeits most of the model's
 *  keyword→document advantage (per the BAAI model card, verified in the
 *  2026-07-16 offline eval). */
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export function createLocalProvider(): EmbeddingProvider {
  let extractor: FeatureExtractionPipeline | null = null;
  return {
    // The +rN suffix is the rowText recipe version, not a model change — see
    // ROWTEXT_VERSION.
    id: `local:bge-small-en-v1.5-q8+${ROWTEXT_VERSION}`,
    dim: 384,
    async init(onProgress) {
      // Extension pages are not cross-origin isolated → no SharedArrayBuffer
      // → single-threaded WASM. q8 bge-small runs ~5–20 ms per short row text.
      extractor ??= await loadLocalPipeline(onProgress);
    },
    async embed(texts, kind) {
      const input = kind === "query" ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts;
      // bge models pool from the CLS token — "mean" would silently degrade
      // the vectors while still looking plausible.
      const output = await extractor!(input, { pooling: "cls", normalize: true });
      // output is a Tensor of shape [texts.length, 384]; slice it into rows.
      const { data, dims } = output;
      const [n, dim] = dims as [number, number];
      const vectors: Float32Array[] = [];
      for (let i = 0; i < n; i++) {
        vectors.push(new Float32Array(data.buffer, data.byteOffset + i * dim * 4, dim).slice());
      }
      return vectors;
    },
  };
}

/** Pick the provider from ai:settings. Only "local" exists today, so any
 *  stored value (including settings written before the cloud providers were
 *  removed) resolves to the local model. */
export function resolveProvider(settings: AiSettings | null): EmbeddingProvider {
  void settings;
  return createLocalProvider();
}
