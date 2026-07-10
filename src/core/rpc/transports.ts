// Transport implementations. Host objects (Worker, chrome.runtime, worker
// global scope) are typed *structurally* so this module stays in core with no
// DOM/chrome/WebWorker lib dependency: pages pass a real Worker, workers pass
// `self`, extension contexts pass `chrome.runtime`, and tests pass fakes.
import { reviveError } from "../errors.ts";
import { dispatch } from "./server.ts";
import type { Handlers, Transport, WireResponse } from "./protocol.ts";

function unwrap(response: WireResponse): unknown {
  if (!response.ok) throw reviveError(response.error);
  return response.result;
}

// ---------------------------------------------------------------------------
// In-process (tests, dev harness, and any same-context wiring)
// ---------------------------------------------------------------------------

/** Calls the impl directly but still routes through dispatch + error
 *  serialization, so the full wire behavior is exercised. */
export function directTransport<A extends object>(impl: Handlers<A>): Transport {
  return {
    async call(op, args) {
      return unwrap(await dispatch(impl, op, args));
    },
  };
}

// ---------------------------------------------------------------------------
// Dedicated workers (postMessage; structured clone — vectors ride this hop)
// ---------------------------------------------------------------------------

interface WorkerWireRequest {
  id: number;
  op: string;
  args: unknown;
}

type WorkerWireResponse = { id: number } & WireResponse;

/** The slice of Worker this transport needs (DOM lib not required). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export function workerTransport(worker: WorkerLike): Transport {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  worker.onmessage = (event) => {
    const { id, ...response } = event.data as WorkerWireResponse;
    const promise = pending.get(id);
    if (!promise) return;
    pending.delete(id);
    try {
      promise.resolve(unwrap(response as WireResponse));
    } catch (e) {
      promise.reject(e as Error);
    }
  };

  // Whole-worker failure (script error, OOM): every in-flight call fails.
  worker.onerror = (event) => {
    const error = new Error(event.message || "worker error");
    for (const promise of pending.values()) promise.reject(error);
    pending.clear();
  };

  return {
    call(op, args) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, args } satisfies WorkerWireRequest);
      });
    },
  };
}

/** The slice of DedicatedWorkerGlobalScope serveWorker needs. */
export interface WorkerScopeLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export function serveWorker<A extends object>(scope: WorkerScopeLike, impl: Handlers<A>): void {
  scope.onmessage = async (event) => {
    const { id, op, args } = event.data as WorkerWireRequest;
    const response = await dispatch(impl, op, args);
    scope.postMessage({ id, ...response } satisfies WorkerWireResponse);
  };
}

// ---------------------------------------------------------------------------
// chrome.runtime (JSON-serialized — typed arrays must never ride this hop)
// ---------------------------------------------------------------------------

interface RuntimeWireRequest {
  /** Which service this message addresses — several serveRuntime endpoints
   *  coexist across extension contexts (background, offscreen db/ai relay). */
  target: string;
  op: string;
  args: unknown;
}

/** The slice of chrome.runtime these transports need. */
export interface RuntimeLike {
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void
      ) => boolean | undefined
    ): void;
  };
}

export function runtimeTransport(runtime: RuntimeLike, target: string): Transport {
  return {
    async call(op, args) {
      const response = (await runtime.sendMessage({
        target,
        op,
        args,
      } satisfies RuntimeWireRequest)) as WireResponse | undefined;
      // No listener (e.g. the offscreen document was torn down) surfaces as
      // an undefined response rather than a rejection.
      if (!response) throw new Error(`No listener for target "${target}" (op: ${op})`);
      return unwrap(response);
    },
  };
}

export function serveRuntime<A extends object>(runtime: RuntimeLike, target: string, impl: Handlers<A>): void {
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const request = message as Partial<RuntimeWireRequest> | undefined;
    if (!request || request.target !== target) return undefined; // someone else's message
    void dispatch(impl, request.op ?? "", request.args).then(sendResponse);
    return true; // keep the channel open for the async response
  });
}
