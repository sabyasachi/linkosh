// Chrome entry for BOTH popup.html and page.html: builds the chrome Runtime
// (RPC to the background over chrome.runtime, prefs on chrome.storage, OPFS
// export download) and mounts the shared Preact tree. The popup additionally
// gets the ⛶ expand control (openPage).
import { h, render } from "../../vendor/preact/preact.js";
import { createClient } from "../../core/rpc/client.ts";
import { runtimeTransport, type RuntimeLike } from "../../core/rpc/transports.ts";
import type { BackgroundApi } from "../../ext/background-service.ts";
import { createChromePrefs } from "../../ext/chrome-prefs.ts";
import { App } from "./app.tsx";
import type { Runtime } from "./runtime.ts";

const api = createClient<BackgroundApi>(
  runtimeTransport(chrome.runtime as unknown as RuntimeLike, "background")
);

const isPopup = document.body.classList.contains("popup");

const runtime: Runtime = {
  api,
  prefs: createChromePrefs(),
  openOptions() {
    void chrome.runtime.openOptionsPage();
  },
  ...(isPopup
    ? {
        openPage() {
          void chrome.tabs.create({ url: chrome.runtime.getURL("pages/popup/page.html") });
          window.close();
        },
      }
    : {}),
};

render(h(App, { runtime }), document.body);
