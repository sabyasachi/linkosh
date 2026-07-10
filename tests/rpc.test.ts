// The RPC layer end-to-end over every transport shape, using fakes for the
// host objects (worker pair, chrome.runtime bus).
import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/core/rpc/client.ts";
import type { Client } from "../src/core/rpc/protocol.ts";
import {
  directTransport,
  runtimeTransport,
  serveRuntime,
  serveWorker,
  workerTransport,
  type RuntimeLike,
  type WorkerLike,
  type WorkerScopeLike,
} from "../src/core/rpc/transports.ts";
import { ProviderError } from "../src/core/errors.ts";

interface TestApi {
  add(args: { a: number; b: number }): number;
  boom(args: Record<string, never>): never;
  login(args: Record<string, never>): never;
  echoVector(args: { v: Float32Array }): Float32Array;
}

const impl = {
  add: ({ a, b }: { a: number; b: number }) => a + b,
  boom: () => {
    throw new TypeError("kaput");
  },
  login: () => {
    throw new ProviderError("Not logged in to X", { needsLogin: true });
  },
  echoVector: ({ v }: { v: Float32Array }) => v,
};

async function assertClientBehavior(client: Client<TestApi>) {
  assert.equal(await client.add({ a: 2, b: 3 }), 5);

  await assert.rejects(client.boom({}), (e: Error) => {
    assert.equal(e.name, "TypeError");
    assert.equal(e.message, "kaput");
    return true;
  });

  // ProviderError revives as ProviderError with needsLogin intact.
  await assert.rejects(client.login({}), (e: Error) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.needsLogin, true);
    return true;
  });

  // Unknown op is a server-side error, not a hang.
  const loose = client as unknown as Record<string, (args: object) => Promise<unknown>>;
  await assert.rejects(loose.nosuch!({}), /Unknown op: nosuch/);
}

test("direct transport: typed round-trip, error revival, unknown op", async () => {
  await assertClientBehavior(createClient<TestApi>(directTransport<TestApi>(impl)));
});

/** An in-memory worker pair: what `new Worker()` + `self` give the real code. */
function fakeWorkerPair(): { worker: WorkerLike; scope: WorkerScopeLike } {
  const worker: WorkerLike = {
    postMessage(message) {
      queueMicrotask(() => scope.onmessage?.({ data: message }));
    },
    onmessage: null,
    onerror: null,
  };
  const scope: WorkerScopeLike = {
    postMessage(message) {
      queueMicrotask(() => worker.onmessage?.({ data: message }));
    },
    onmessage: null,
  };
  return { worker, scope };
}

test("worker transport: id-correlated round-trip over postMessage", async () => {
  const { worker, scope } = fakeWorkerPair();
  serveWorker<TestApi>(scope, impl);
  const client = createClient<TestApi>(workerTransport(worker));
  await assertClientBehavior(client);

  // Interleaved calls resolve to their own responses (id correlation).
  const [x, y] = await Promise.all([client.add({ a: 1, b: 1 }), client.add({ a: 10, b: 10 })]);
  assert.equal(x, 2);
  assert.equal(y, 20);

  // Typed arrays survive (structured clone in the real worker; pass-through here).
  const v = new Float32Array([1, 2, 3]);
  assert.deepEqual([...(await client.echoVector({ v }))], [1, 2, 3]);
});

test("worker transport: worker-level error rejects all in-flight calls", async () => {
  const worker: WorkerLike = { postMessage() {}, onmessage: null, onerror: null }; // never responds
  const client = createClient<TestApi>(workerTransport(worker));
  const inFlight = [client.add({ a: 1, b: 2 }), client.add({ a: 3, b: 4 })];
  worker.onerror?.({ message: "worker crashed" });
  for (const p of inFlight) await assert.rejects(p, /worker crashed/);
});

/** An in-memory chrome.runtime bus: listeners in "other contexts", sender's
 *  own listener never sees its own message (like the real API). */
function fakeRuntimeBus(): RuntimeLike {
  type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined;
  const listeners: Listener[] = [];
  return {
    async sendMessage(message) {
      return new Promise((resolve) => {
        let responded = false;
        for (const listener of listeners) {
          const keepOpen = listener(message, {}, (response) => {
            if (!responded) {
              responded = true;
              resolve(response);
            }
          });
          if (keepOpen) return; // async response pending
        }
        if (!responded) resolve(undefined); // nobody claimed it
      });
    },
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
  };
}

test("runtime transport: target routing, coexisting endpoints, no-listener error", async () => {
  const bus = fakeRuntimeBus();
  serveRuntime<TestApi>(bus, "background", impl);
  serveRuntime<{ ping(args: Record<string, never>): string }>(bus, "db", { ping: () => "db-pong" });

  const background = createClient<TestApi>(runtimeTransport(bus, "background"));
  await assertClientBehavior(background);

  // A second endpoint on the same bus answers only its own target.
  const db = createClient<{ ping(args: Record<string, never>): string }>(runtimeTransport(bus, "db"));
  assert.equal(await db.ping({}), "db-pong");

  // A target nobody serves fails loudly instead of hanging.
  const ghost = createClient<TestApi>(runtimeTransport(bus, "ghost"));
  await assert.rejects(ghost.add({ a: 1, b: 2 }), /No listener for target "ghost"/);
});
