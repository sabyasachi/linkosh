// A deterministic stand-in for the AI worker: same EmbedderApi surface
// (configure / status / embed), no model. Vectors are token-hash bags,
// L2-normalized like the real providers' output, so texts sharing words land
// near each other — enough signal for ranking assertions without any ML.
import type { OrchestratorEmbedder } from "../../src/core/ai/orchestrator.ts";
import type { DownloadProgress } from "../../src/core/types.ts";

export const FAKE_DIM = 64;
export const FAKE_MODEL = "fake:token-hash";

export function embedText(text: string, dim: number = FAKE_DIM): Float32Array {
  const v = new Float32Array(dim);
  for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
    v[h % dim]! += 1;
  }
  let norm = Math.hypot(...v);
  if (!norm) {
    v[0] = 1; // empty text still gets a valid unit vector
    norm = 1;
  }
  for (let i = 0; i < dim; i++) v[i]! /= norm;
  return v;
}

export interface FakeAiCall {
  op: "configure" | "status" | "embed";
  texts?: string[];
}

/** An embedder client the orchestrator can drive. `calls` records every op
 *  for assertions; `state.ready` simulates a model still warming up. */
export function createFakeAi({ ready = true }: { ready?: boolean } = {}) {
  const calls: FakeAiCall[] = [];
  const state: { ready: boolean; model: string; downloading: DownloadProgress | null; error: string | null } = {
    ready,
    model: FAKE_MODEL,
    downloading: null,
    error: null,
  };
  const ai: OrchestratorEmbedder = {
    async configure() {
      calls.push({ op: "configure" });
      return { model: state.model };
    },
    async status() {
      calls.push({ op: "status" });
      return { ready: state.ready, model: state.model, dim: FAKE_DIM, downloading: state.downloading, error: state.error };
    },
    async embed({ texts }) {
      calls.push({ op: "embed", texts });
      if (!state.ready) throw new Error("model not ready");
      return texts.map((t) => embedText(t));
    },
  };
  return { calls, state, ai };
}
