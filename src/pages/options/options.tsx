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

const api = createClient<BackgroundApi>(
  runtimeTransport(chrome.runtime as unknown as RuntimeLike, "background")
);
const prefs = createChromePrefs();

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

function DevToggle({ prefKey, label, hint }: { prefKey: "captureRaw" | "testMode"; label: string; hint: string }) {
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
  const statusTimer = useRef<ReturnType<typeof setInterval>>();

  const refreshStatus = async () => {
    try {
      setAiStatus(formatStatus(await api.aiStatus({})));
    } catch (e) {
      setAiStatus(e instanceof Error ? e.message : "Unavailable");
    }
  };

  useEffect(() => {
    void (async () => {
      const settings = await prefs.get("ai:settings");
      setEmbedProvider(settings?.embedProvider ?? "local");
      setKeys((prev) => ({ ...prev, ...(settings?.keys ?? {}) }));
      await refreshStatus();
    })();
    statusTimer.current = setInterval(() => void refreshStatus(), 2000);
    return () => clearInterval(statusTimer.current);
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

  return (
    <>
      <h1>Linkosh — Options</h1>

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
      <DevToggle
        prefKey="captureRaw"
        label="Capture mode: archive raw API responses instead of saving items"
        hint="While on, Refresh/⟳ Full store each response page verbatim in the raw_data table and leave the item list untouched — use “Ingest raw” (in the popup) or tools/ingest.ts (on an export) to run the parsing pipeline over the archive. For developing the pipeline without re-fetching from the services. Takes effect on the next sync."
      />
      <DevToggle
        prefKey="testMode"
        label="Test mode: stop each sync after about 100 items"
        hint="For quickly checking a provider works without a heavy fetch from the service (a little more than 100 for providers that walk several lists, e.g. YouTube playlists). Takes effect on the next sync."
      />

      <button id="delete-items" disabled={deleting} onClick={() => void deleteItems()}>
        Delete all saved items
      </button>
      <span id="delete-status">{deleteStatus}</span>
      <p class="hint">
        Removes every row from the item database (embeddings included) and resets each provider's
        sync state, so the next Refresh re-fetches from scratch. Captured raw pages are not
        affected.
      </p>
    </>
  );
}

render(h(OptionsApp, null), document.body);
