// Server side of the protocol: dispatch one wire request against a Handlers
// implementation, catching everything into the uniform envelope.
import { serializeError } from "../errors.ts";
import type { Handlers, WireResponse } from "./protocol.ts";

export async function dispatch<A extends object>(
  impl: Handlers<A>,
  op: string,
  args: unknown
): Promise<WireResponse> {
  try {
    const handler = (impl as Record<string, (args: unknown) => unknown>)[op];
    if (typeof handler !== "function") throw new Error(`Unknown op: ${op}`);
    return { ok: true, result: await handler(args ?? {}) };
  } catch (e) {
    return { ok: false, error: serializeError(e) };
  }
}
