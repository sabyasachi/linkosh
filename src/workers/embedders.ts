// Embedding providers. One local (transformers.js, fully on-device) and a few
// cloud APIs unlocked by an API key on the options page. Every provider
// returns L2-normalized Float32Array vectors so cosine similarity == dot
// product everywhere downstream (core/db/search.ts relies on this).
//
// Note: Anthropic has no embeddings API — the Anthropic key on the options
// page exists only for the auto-tagging plan's tag labeling, not for this
// file.
import { pipeline, env, type FeatureExtractionPipeline } from "../vendor/transformers.min.js";
import type { AiSettings, DownloadProgress } from "../core/types.ts";

export interface EmbeddingProvider {
  id: string;
  dim: number;
  init(onProgress?: (p: DownloadProgress) => void): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
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
    return await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
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

export function createLocalProvider(): EmbeddingProvider {
  let extractor: FeatureExtractionPipeline | null = null;
  return {
    id: "local:minilm-l6-v2-q8",
    dim: 384,
    async init(onProgress) {
      // Extension pages are not cross-origin isolated → no SharedArrayBuffer
      // → single-threaded WASM. q8 MiniLM runs ~5–20 ms per short row text.
      extractor ??= await loadLocalPipeline(onProgress);
    },
    async embed(texts) {
      const output = await extractor!(texts, { pooling: "mean", normalize: true });
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

/** Cloud vectors are normalized client-side; some APIs (OpenAI) already
 *  normalize, but doing it unconditionally keeps the invariant local. */
function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Embedding API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Run `texts` through `request(batch)` in slices of `size`, concatenating. */
async function inBatches(
  texts: string[],
  size: number,
  request: (batch: string[]) => Promise<Float32Array[]>
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += size) {
    vectors.push(...(await request(texts.slice(i, i + size))));
  }
  return vectors;
}

export function createOpenAIProvider({ apiKey }: { apiKey: string }): EmbeddingProvider {
  const model = "text-embedding-3-small"; // cheapest mainstream, strong quality
  return {
    id: `openai:${model}`,
    dim: 1536,
    async init() {},
    embed: (texts) =>
      inBatches(texts, 100, async (batch) => {
        const res = (await postJson(
          "https://api.openai.com/v1/embeddings",
          { Authorization: `Bearer ${apiKey}` },
          { model, input: batch }
        )) as { data: { embedding: number[] }[] };
        return res.data.map((d) => normalize(Float32Array.from(d.embedding)));
      }),
  };
}

export function createGeminiProvider({ apiKey }: { apiKey: string }): EmbeddingProvider {
  const model = "gemini-embedding-001";
  const dim = 768;
  return {
    id: `gemini:${model}-${dim}`,
    dim,
    async init() {},
    embed: (texts) =>
      inBatches(texts, 100, async (batch) => {
        const res = (await postJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
          { "x-goog-api-key": apiKey },
          {
            requests: batch.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              output_dimensionality: dim,
            })),
          }
        )) as { embeddings: { values: number[] }[] };
        return res.embeddings.map((e) => normalize(Float32Array.from(e.values)));
      }),
  };
}

export function createVoyageProvider({ apiKey }: { apiKey: string }): EmbeddingProvider {
  const model = "voyage-3.5-lite";
  return {
    id: `voyage:${model}`,
    dim: 1024,
    async init() {},
    embed: (texts) =>
      inBatches(texts, 100, async (batch) => {
        const res = (await postJson(
          "https://api.voyageai.com/v1/embeddings",
          { Authorization: `Bearer ${apiKey}` },
          { model, input: batch }
        )) as { data: { embedding: number[] }[] };
        return res.data.map((d) => normalize(Float32Array.from(d.embedding)));
      }),
  };
}

/** Pick the provider from ai:settings ({ embedProvider, keys }): cloud when a
 *  key exists for the selected provider, local otherwise (and by default). */
export function resolveProvider(settings: AiSettings | null): EmbeddingProvider {
  const { embedProvider, keys = {} } = settings ?? {};
  if (embedProvider === "openai" && keys.openai) return createOpenAIProvider({ apiKey: keys.openai });
  if (embedProvider === "gemini" && keys.gemini) return createGeminiProvider({ apiKey: keys.gemini });
  if (embedProvider === "voyage" && keys.voyage) return createVoyageProvider({ apiKey: keys.voyage });
  return createLocalProvider();
}
