// Error types + the wire (de)serialization the RPC layer uses to carry them
// across chrome.runtime / postMessage hops without losing their meaning.

/** User-readable provider failure. `needsLogin` marks failures a re-auth on
 *  the service would fix — the UI turns those into a "log in" hint. */
export class ProviderError extends Error {
  needsLogin: boolean;

  constructor(message: string, opts: { needsLogin?: boolean } = {}) {
    super(message);
    this.name = "ProviderError";
    this.needsLogin = opts.needsLogin ?? false;
  }
}

/** JSON-safe form of an error crossing an RPC hop. */
export interface SerializedError {
  name: string;
  message: string;
  needsLogin?: boolean;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof ProviderError) {
    return { name: e.name, message: e.message, needsLogin: e.needsLogin };
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message };
  }
  return { name: "Error", message: String(e) };
}

/** Revive a wire error into a throwable with its meaning intact. */
export function reviveError(s: SerializedError): Error {
  if (s.name === "ProviderError") {
    return new ProviderError(s.message, { needsLogin: s.needsLogin ?? false });
  }
  const e = new Error(s.message);
  e.name = s.name;
  return e;
}
