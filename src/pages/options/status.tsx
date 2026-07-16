// Service status page (linked from the options page): one row per registered
// provider — user enablement, a cookie-based login probe, saved-item count,
// newest item's save date and the last successful sync. All data comes from
// the background's providerStatus op; this page only renders it.
import { h, Fragment, render } from "../../vendor/preact/preact.js";
import { useEffect, useState } from "../../vendor/preact/hooks.js";
import { createClient } from "../../core/rpc/client.ts";
import { runtimeTransport, type RuntimeLike } from "../../core/rpc/transports.ts";
import { formatSynced } from "../../core/format.ts";
import type { BackgroundApi, ProviderStatusRow } from "../../ext/background-service.ts";

const api = createClient<BackgroundApi>(
  runtimeTransport(chrome.runtime as unknown as RuntimeLike, "background")
);

function formatLastItem(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function Login({ loggedIn }: { loggedIn: boolean | null }) {
  // null = the probe is unavailable or failed — unknown, not signed out.
  if (loggedIn === null) return <span class="muted">—</span>;
  return loggedIn ? (
    <span class="login-ok">● Signed in</span>
  ) : (
    <span class="login-out">● Signed out</span>
  );
}

function StatusApp() {
  const [rows, setRows] = useState<ProviderStatusRow[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setRows(await api.providerStatus({}));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <h1>Linkosh — Service status</h1>
      <p class="hint">
        The login check looks for each service's session cookie — it tells you a session is
        present, not that it is still valid; an expired one shows up as an error on the next sync.
        Enable or disable services on the <a href="options.html">options page</a>.
      </p>

      {error && <p class="status-error">{error}</p>}

      {rows && (
        <table class="status-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Login</th>
              <th class="num">Saved items</th>
              <th>Last item</th>
              <th>Last synced</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr class={row.enabled ? "" : "disabled"}>
                <td>
                  {row.label}
                  {!row.enabled && <span class="muted"> (disabled)</span>}
                </td>
                <td>
                  <Login loggedIn={row.loggedIn} />
                </td>
                <td class="num">{row.items}</td>
                <td>{formatLastItem(row.lastItemAt)}</td>
                <td>{formatSynced(row.syncedAt ?? undefined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!rows && !error && <p class="hint">Loading…</p>}

      <button disabled={refreshing} onClick={() => void refresh()}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </>
  );
}

render(h(StatusApp, null), document.body);
