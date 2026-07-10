// Options page: embedding-provider selection + cloud API keys (shared infra —
// the auto-tagging plan reuses the Anthropic key), a live view of the
// embedding backlog, and the developer toggles. Settings live under the typed
// "ai:settings" pref; the background watches that key and pushes a
// reconfigure to the AI worker (the offscreen document can't read
// chrome.storage itself).
import { h, Fragment, render } from "../../vendor/preact/preact.js";
import { useEffect, useRef, useState } from "../../vendor/preact/hooks.js";
import { createClient } from "../../core/rpc/client.ts";
import { runtimeTransport, type RuntimeLike } from "../../core/rpc/transports.ts";
import { createChromePrefs } from "../../ext/chrome-prefs.ts";
import type { BackgroundApi } from "../../ext/background-service.ts";
import type { AiSettings, EmbedProviderId, OrchestratorStatus } from "../../core/types.ts";
import type { PrefsSchema } from "../../core/prefs.ts";
import type { RawStatsRow } from "../../core/db/raw.ts";

const api = createClient<BackgroundApi>(
  runtimeTransport(chrome.runtime as unknown as RuntimeLike, "background")
);
const prefs = createChromePrefs();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Materialize the worker's OPFS export before deleting its temporary file. */
async function downloadExport(): Promise<void> {
  const { file } = await api.exportDb({});
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(file);
  const bytes = await (await handle.getFile()).arrayBuffer();
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.sqlite3" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "linkosh.sqlite";
  a.click();
  URL.revokeObjectURL(url);
  await root.removeEntry(file).catch(() => {});
}

// Origins we need optional host permission for, per cloud provider, so
// extension-context fetches to the API bypass CORS.
const API_ORIGINS: Partial<Record<EmbedProviderId, string>> = {
  openai: "https://api.openai.com/*",
  gemini: "https://generativelanguage.googleapis.com/*",
  voyage: "https://api.voyageai.com/*",
};

type KeyName = "openai" | "gemini" | "voyage" | "anthropic";

const KEY_FIELDS: { name: KeyName; label: string; placeholder: string; hint?: string }[] = [
  { name: "openai", label: "OpenAI API key", placeholder: "sk-…" },
  { name: "gemini", label: "Gemini API key", placeholder: "AIza…" },
  { name: "voyage", label: "Voyage API key", placeholder: "pa-…" },
  {
    name: "anthropic",
    label: "Anthropic API key",
    placeholder: "sk-ant-…",
    hint: "Used for tag labeling only — Anthropic has no embeddings API.",
  },
];

function formatStatus(s: OrchestratorStatus): string {
  const lines = [`Model: ${s.model}`];
  if (s.downloading) {
    // huggingface.co sometimes omits Content-Length → no total → show bytes.
    lines.push(
      s.downloading.total
        ? `Downloading model… ${Math.round((100 * s.downloading.loaded) / s.downloading.total)}%`
        : `Downloading model… ${Math.round(s.downloading.loaded / 1e6)} MB so far`
    );
  } else {
    lines.push(s.modelReady ? "Model ready." : "Model not loaded yet (loads on first use).");
  }
  lines.push(`Embedded: ${s.embedded} of ${s.total} items${s.backlog ? ` — backlog ${s.backlog}` : ""}`);
  if (s.embedding?.running) lines.push(`Embedding now… ${s.embedding.done}/${s.embedding.total}`);
  if (s.error) lines.push(`Error: ${s.error}`);
  return lines.join("\n");
}

function PrefToggle({
  prefKey,
  label,
  hint,
}: {
  prefKey: "openFullPage" | "captureRaw" | "testMode";
  label: string;
  hint: string;
}) {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    void prefs.get(prefKey).then((value) => setChecked(Boolean(value)));
  }, [prefKey]);
  return (
    <>
      <label style="font-weight: 400">
        <input
          type="checkbox"
          style="width: auto; margin-right: 6px"
          checked={checked}
          onChange={(e) => {
            const value = (e.currentTarget as HTMLInputElement).checked;
            setChecked(value);
            void prefs.set(prefKey, value);
          }}
        />
        {label}
      </label>
      <p class="hint">{hint}</p>
    </>
  );
}

function OptionsApp() {
  const [embedProvider, setEmbedProvider] = useState<EmbedProviderId>("local");
  const [keys, setKeys] = useState<Record<KeyName, string>>({ openai: "", gemini: "", voyage: "", anthropic: "" });
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState("Loading…");
  const [deleteStatus, setDeleteStatus] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [devAction, setDevAction] = useState<"sync" | "export" | "ingest" | "clear" | "">("");
  const [devStatus, setDevStatus] = useState("");
  const [rawStats, setRawStats] = useState<RawStatsRow[]>([]);
  const [captureMode, setCaptureMode] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setInterval>>();

  const refreshStatus = async () => {
    try {
      setAiStatus(formatStatus(await api.aiStatus({})));
    } catch (e) {
      setAiStatus(e instanceof Error ? e.message : "Unavailable");
    }
  };

  const refreshRawStats = async () => {
    try {
      const result = await api.rawStats({});
      setRawStats(result.stats);
      setCaptureMode(result.captureRaw);
    } catch {
      // The action status reports concrete failures; periodic refresh is best-effort.
    }
  };

  useEffect(() => {
    const unwatchCaptureMode = prefs.watch("captureRaw", (value) => setCaptureMode(Boolean(value)));
    void (async () => {
      const settings = await prefs.get("ai:settings");
      setEmbedProvider(settings?.embedProvider ?? "local");
      setKeys((prev) => ({ ...prev, ...(settings?.keys ?? {}) }));
      await Promise.all([refreshStatus(), refreshRawStats()]);
    })();
    statusTimer.current = setInterval(() => void refreshStatus(), 2000);
    return () => {
      clearInterval(statusTimer.current);
      unwatchCaptureMode();
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveStatus("");
    try {
      if (embedProvider !== "local" && !keys[embedProvider as KeyName]?.trim()) {
        setSaveStatus("That provider needs an API key.");
        return;
      }
      // Must run inside the click gesture for the permission prompt to show.
      const origin = API_ORIGINS[embedProvider];
      if (origin) {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          setSaveStatus("Permission for the API origin was declined — staying on Local.");
          return;
        }
      }
      const settings: PrefsSchema["ai:settings"] = {
        embedProvider,
        keys: Object.fromEntries(
          Object.entries(keys).map(([name, value]) => [name, value.trim()])
        ) as AiSettings["keys"],
      };
      await prefs.set("ai:settings", settings);
      setSaveStatus("Saved.");
    } finally {
      setSaving(false);
    }
  };

  const deleteItems = async () => {
    if (!confirm("Delete every saved item? Captured raw pages are kept. This can't be undone.")) return;
    setDeleting(true);
    setDeleteStatus("");
    try {
      const res = await api.clearItems({});
      setDeleteStatus(`Deleted ${res.deleted} items.`);
    } catch (e) {
      setDeleteStatus(e instanceof Error ? e.message : "Failed.");
    } finally {
      setDeleting(false);
      void refreshStatus();
    }
  };

  const fullSync = async () => {
    setDevAction("sync");
    setDevStatus("Full sync in progress — re-fetching every service…");
    try {
      const result = await api.syncAll({ full: true });
      const failures = result.reports.filter((report) => report.status !== "ok");
      const outcome = result.captured
        ? `Captured ${result.captured} raw pages.`
        : `Full sync complete: ${result.inserted} new · ${result.total} total.`;
      setDevStatus(
        failures.length
          ? `${outcome} ${failures.length} service${failures.length === 1 ? "" : "s"} stopped with an error.`
          : outcome
      );
    } catch (error) {
      setDevStatus(errorText(error));
    } finally {
      setDevAction("");
      void Promise.all([refreshStatus(), refreshRawStats()]);
    }
  };

  const exportDatabase = async () => {
    setDevAction("export");
    setDevStatus("Preparing database export…");
    try {
      await downloadExport();
      setDevStatus("Database exported.");
    } catch (error) {
      setDevStatus(errorText(error));
    } finally {
      setDevAction("");
    }
  };

  const ingestRaw = async () => {
    setDevAction("ingest");
    setDevStatus("Ingesting raw pages…");
    try {
      const result = await api.rawIngest({});
      setDevStatus(
        `Ingested ${result.ingested} of ${result.pages} raw pages` +
          (result.failed ? ` · ${result.failed} failed` : "") +
          ` · ${result.inserted} new items.`
      );
    } catch (error) {
      setDevStatus(errorText(error));
    } finally {
      setDevAction("");
      void Promise.all([refreshStatus(), refreshRawStats()]);
    }
  };

  const clearRaw = async () => {
    if (!confirm("Delete every captured raw page? Items already ingested stay.")) return;
    setDevAction("clear");
    setDevStatus("");
    try {
      await api.rawClear({});
      setDevStatus("Raw archive cleared.");
    } catch (error) {
      setDevStatus(errorText(error));
    } finally {
      setDevAction("");
      void refreshRawStats();
    }
  };

  const rawCount = (status: RawStatsRow["status"]) =>
    rawStats.filter((row) => row.status === status).reduce((count, row) => count + row.pages, 0);
  const rawPages = rawStats.reduce((count, row) => count + row.pages, 0);
  const pendingRaw = rawCount("pending");
  const failedRaw = rawCount("failed");

  return (
    <>
      <h1>Linkosh — Options</h1>

      <h2>Extension icon</h2>
      <PrefToggle
        prefKey="openFullPage"
        label="Open the full page when I click the extension icon"
        hint="When off, clicking the extension icon opens the compact popup."
      />

      <h2>Semantic search</h2>
      <p class="hint">
        By default embeddings are computed on-device (a small model is downloaded once, then
        everything runs offline). A cloud API key upgrades embedding quality. Keys are stored in
        chrome.storage.local, which is plaintext on disk.
      </p>

      <label for="embed-provider">Embedding provider</label>
      <select
        id="embed-provider"
        value={embedProvider}
        onChange={(e) => setEmbedProvider((e.currentTarget as HTMLSelectElement).value as EmbedProviderId)}
      >
        <option value="local">Local (on-device, default)</option>
        <option value="openai">OpenAI (text-embedding-3-small)</option>
        <option value="gemini">Gemini (gemini-embedding-001)</option>
        <option value="voyage">Voyage (voyage-3.5-lite)</option>
      </select>

      {KEY_FIELDS.map(({ name, label, placeholder, hint }) => (
        <>
          <label for={`key-${name}`}>{label}</label>
          <input
            id={`key-${name}`}
            type="password"
            autocomplete="off"
            placeholder={placeholder}
            value={keys[name]}
            onInput={(e) => {
              const value = (e.currentTarget as HTMLInputElement).value;
              setKeys((prev) => ({ ...prev, [name]: value }));
            }}
          />
          {hint && <div class="hint">{hint}</div>}
        </>
      ))}

      <button id="save" class="primary" disabled={saving} onClick={() => void save()}>
        Save
      </button>
      <span id="save-status">{saveStatus}</span>

      <h2>Embedding status</h2>
      <div id="ai-status">{aiStatus}</div>
      <button
        id="rebuild"
        title="Embed all items that don't have an up-to-date embedding"
        onClick={() => {
          void api.embed({}).catch(() => {});
          void refreshStatus();
        }}
      >
        Rebuild embeddings
      </button>

      <h2>Developer</h2>
      <PrefToggle
        prefKey="captureRaw"
        label="Capture mode: archive raw API responses instead of saving items"
        hint="While on, Sync and Full sync store each response page verbatim in raw_data and leave the item list untouched. Use Ingest raw below or tools/ingest.ts on an export to run the parsing pipeline without re-fetching. Takes effect on the next sync."
      />
      <PrefToggle
        prefKey="testMode"
        label="Test mode: stop each sync after about 100 items"
        hint="For quickly checking a provider works without a heavy fetch from the service (a little more than 100 for providers that walk several lists, e.g. YouTube playlists). Takes effect on the next sync."
      />

      <div class="developer-actions">
        <button
          id="full-sync"
          disabled={Boolean(devAction)}
          title="Re-fetch every service from the beginning"
          onClick={() => void fullSync()}
        >
          Full sync
        </button>
        <button
          id="export"
          disabled={Boolean(devAction)}
          title="Download the database as a .sqlite file"
          onClick={() => void exportDatabase()}
        >
          Export database
        </button>
      </div>
      <p class="hint">
        Full sync refreshes stale titles and snippets across every service. Export downloads the
        complete SQLite database.
      </p>

      <h3>Raw archive</h3>
      <div id="raw-stats">
        {`${captureMode ? "Capture mode on" : "Capture mode off"} · ${rawPages} raw pages` +
          (pendingRaw ? ` · ${pendingRaw} pending` : "") +
          (failedRaw ? ` · ${failedRaw} failed` : "")}
      </div>
      <div class="developer-actions">
        <button
          id="ingest-raw"
          disabled={Boolean(devAction) || pendingRaw + failedRaw === 0}
          onClick={() => void ingestRaw()}
        >
          Ingest raw
        </button>
        <button
          id="clear-raw"
          disabled={Boolean(devAction) || rawPages === 0}
          onClick={() => void clearRaw()}
        >
          Clear raw
        </button>
      </div>
      <div id="dev-status">{devStatus}</div>

      <button id="delete-items" disabled={deleting} onClick={() => void deleteItems()}>
        Delete all saved items
      </button>
      <span id="delete-status">{deleteStatus}</span>
      <p class="hint">
        Removes every row from the item database (embeddings included) and resets each provider's
        sync state, so the next Sync re-fetches from scratch. Captured raw pages are not
        affected.
      </p>
    </>
  );
}

render(h(OptionsApp, null), document.body);
