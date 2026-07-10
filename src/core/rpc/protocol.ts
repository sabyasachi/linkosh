// The one RPC vocabulary every hop speaks (chrome.runtime, worker
// postMessage, dev HTTP, in-process). An API is any interface whose methods
// take a single args object; Client<A> is its promise-shaped remote view;
// Handlers<A> is what a server implements. The wire envelope is uniform:
// { ok: true, result } | { ok: false, error } — errors are serialized
// structurally and revived as throwables (ProviderError keeps needsLogin).
//
// Client/Handlers are conditional mapped types (not a Record constraint) so
// plain interfaces — DbApi, AiApi, BackgroundApi — qualify without index
// signatures.
import type { SerializedError } from "../errors.ts";

export type WireResponse = { ok: true; result: unknown } | { ok: false; error: SerializedError };

/** One remote call. Implementations throw revived errors on { ok: false }. */
export interface Transport {
  call(op: string, args: unknown): Promise<unknown>;
}

export type Client<A> = {
  [K in keyof A]: A[K] extends (args: infer P) => infer R ? (args: P) => Promise<Awaited<R>> : never;
};

export type Handlers<A> = {
  [K in keyof A]: A[K] extends (args: infer P) => infer R
    ? (args: P) => Awaited<R> | Promise<Awaited<R>>
    : never;
};
