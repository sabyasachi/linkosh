// The Runtime seam: everything the shared UI tree needs from its host.
// Three implementations — chrome popup/page (main.ts), and the Node dev
// harness (dev.ts over HTTP) — mount the identical <App/>.
import type { Client } from "../../core/rpc/protocol.ts";
import type { Prefs } from "../../core/prefs.ts";
import type { BackgroundApi } from "../../ext/background-service.ts";

export interface Runtime {
  api: Client<BackgroundApi>;
  prefs: Prefs;
  /** Open the full-page view; present only where an expand control makes
   *  sense (the popup). */
  openPage?: () => void;
}
