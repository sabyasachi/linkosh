// Client<A> over any Transport: a Proxy that turns property access into
// typed remote calls — client.search({...}) → transport.call("search", {...}).
import type { Client, Transport } from "./protocol.ts";

export function createClient<A extends object>(transport: Transport): Client<A> {
  return new Proxy({} as Client<A>, {
    get(_target, op) {
      if (typeof op !== "string") return undefined;
      return (args: unknown) => transport.call(op, args ?? {});
    },
  });
}
