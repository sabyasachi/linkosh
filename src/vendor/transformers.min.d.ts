// Hand-written declarations for the vendored transformers.js build
// (transformers.min.js, v3.8.1). Typed to the surface this codebase uses:
// the feature-extraction pipeline and the env knobs required for MV3
// (bundled ORT runtime, remote weights). Not a complete API description.
// The vendored build itself is never edited (see CLAUDE.md).

export interface TransformersEnv {
  /** false ⇒ model ids resolve to huggingface.co, never local paths. */
  allowLocalModels: boolean;
  /** Weights persist via the Cache API (defaults true) — offline after first use. */
  useBrowserCache: boolean;
  backends: {
    onnx: {
      wasm: {
        /** Base URL the ORT .mjs/.wasm runtime is fetched from. */
        wasmPaths: string;
      };
    };
  };
}

export declare const env: TransformersEnv;

export interface ProgressInfo {
  status: string;
  loaded?: number;
  total?: number;
}

export interface Tensor {
  data: Float32Array;
  dims: number[];
}

export interface FeatureExtractionPipeline {
  (texts: string[], opts: { pooling: "mean" | "cls"; normalize: boolean }): Promise<Tensor>;
}

export interface PipelineOptions {
  dtype?: string;
  device?: string;
  progress_callback?: (p: ProgressInfo) => void;
}

export declare function pipeline(
  task: "feature-extraction",
  model: string,
  opts?: PipelineOptions
): Promise<FeatureExtractionPipeline>;
