// Dev-harness entry: mounts the shared <App/> against the Node ux-server —
// BackgroundApi over HTTP RPC, prefs on localStorage, export via the
// /api/export download. No chrome APIs anywhere on this path.
import { h, render } from "../../vendor/preact/preact.js";
import { createClient } from "../../core/rpc/client.ts";
import { reviveError } from "../../core/errors.ts";
import type { Transport, WireResponse } from "../../core/rpc/protocol.ts";
import type { AllPrefs, Prefs } from "../../core/prefs.ts";
import type { BackgroundApi } from "../../ext/background-service.ts";
import { App } from "./app.tsx";
import type { Runtime } from "./runtime.ts";

const httpTransport: Transport = {
  async call(op, args) {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
    });
    const wire = (await res.json()) as WireResponse;
    if (!wire.ok) throw reviveError(wire.error);
    return wire.result;
  },
};

/** localStorage-backed Prefs — enough for the harness (watch is a no-op:
 *  nothing else writes prefs in this context). */
const localPrefs: Prefs = {
  async get(key) {
    const raw = localStorage.getItem(`linkosh:${key}`);
    return raw === null ? undefined : (JSON.parse(raw) as AllPrefs[typeof key]);
  },
  async set(key, value) {
    localStorage.setItem(`linkosh:${key}`, JSON.stringify(value));
  },
  async remove(key) {
    localStorage.removeItem(`linkosh:${key}`);
  },
  watch() {
    return () => {};
  },
};

const runtime: Runtime = {
  api: createClient<BackgroundApi>(httpTransport),
  prefs: localPrefs,
};

render(h(App, { runtime }), document.body);
