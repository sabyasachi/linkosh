// Injected into a youtube.com tab in the MAIN world — the request needs
// window.ytcfg for the client context and document.cookie for auth. See
// README.md for the toString-serialization contract: fully self-contained,
// args-only inputs (types declared locally, no imports).

interface YtCfgData {
  INNERTUBE_CONTEXT?: object;
  INNERTUBE_API_KEY?: string;
  SESSION_INDEX?: number | string;
}

/** Authenticated InnerTube POST (SAPISIDHASH derived in-page). Returns
 *  status 0 with the error text when the fetch itself fails. */
export async function ytInnerTubePost(
  endpoint: string,
  payload: object
): Promise<{ status: number; body: string }> {
  try {
    const cfg: YtCfgData = (window as { ytcfg?: { data_?: YtCfgData } }).ytcfg?.data_ ?? {};
    const context = cfg.INNERTUBE_CONTEXT ?? {
      client: { clientName: "WEB", clientVersion: "2.20260101.00.00" },
    };
    const sapisid =
      document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ||
      document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1] ||
      "";
    const ts = Math.floor(Date.now() / 1000);
    const digest = await crypto.subtle.digest(
      "SHA-1",
      new TextEncoder().encode(`${ts} ${sapisid} ${location.origin}`)
    );
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = cfg.INNERTUBE_API_KEY;
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false${key ? `&key=${key}` : ""}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        authorization: `SAPISIDHASH ${ts}_${hash}`,
        "x-origin": location.origin,
        "x-goog-authuser": String(cfg.SESSION_INDEX ?? "0"),
      },
      body: JSON.stringify({ context, ...payload }),
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}
