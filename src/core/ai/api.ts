// The two AI-side API surfaces:
//  - EmbedderApi: served by the AI worker (model runtime) over postMessage.
//  - AiApi: served by the orchestrator (hosted in the offscreen document)
//    over chrome.runtime — the high-level commands background/UI send.
// Vectors (Float32Array) appear only on EmbedderApi.embed, which rides
// postMessage (structured clone) — never chrome.runtime.
import type { AiSettings, EmbedderStatus, OrchestratorStatus, ProviderId, SearchMode, SearchResult } from "../types.ts";

/** Retrieval-trained models (bge) embed search queries and documents
 *  differently (a query-side instruction prefix); symmetric models ignore
 *  the distinction. Defaults to "document" — the safe choice for row text. */
export type EmbedKind = "query" | "document";

export interface EmbedderApi {
  /** Swap/initialize the embedding provider. Returns the active model id. */
  configure(args: { settings: AiSettings | null }): { model: string };
  status(args: Record<string, never>): EmbedderStatus;
  embed(args: { texts: string[]; kind?: EmbedKind }): Float32Array[];
}

export interface AiApi {
  search(args: {
    query: string;
    provider?: ProviderId | null;
    limit?: number;
    mode?: SearchMode;
  }): SearchResult;
  status(args: Record<string, never>): OrchestratorStatus;
  /** Kick (or join) the embedding backlog drain; resolves when drained. */
  embedBacklog(args: Record<string, never>): void;
  configure(args: { settings: AiSettings | null }): void;
}
