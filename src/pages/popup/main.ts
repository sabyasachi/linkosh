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

  async downloadExport() {
    // The worker writes the export to an OPFS file (this page shares the
    // extension's origin, hence its OPFS) — a runtime message would cap out
    // at 64 MiB, which a grown DB exceeds.
    const { file } = await api.exportDb({});
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(file);
    // Materialize the bytes before deleting the OPFS entry below — a File is
    // lazily backed by the entry, so deleting mid-download would corrupt it.
    const bytes = await (await handle.getFile()).arrayBuffer();
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.sqlite3" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "linkosh.sqlite";
    a.click();
    URL.revokeObjectURL(url);
    await root.removeEntry(file).catch(() => {});
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
