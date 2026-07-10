// Injected into a facebook.com/saved tab (isolated world). See README.md for
// the toString-serialization contract: fully self-contained, args-only
// inputs (types declared locally, no imports).

interface FbConnection {
  edges?: unknown[];
  page_info?: unknown;
}

/** Pull the server-rendered first page (and the fb_dtsg request token) out of
 *  the /saved/ tab's DOM. Facebook only server-renders the all-saves Relay
 *  connection for real navigations, so reading the DOM is the only way to get
 *  page 1. */
export function fbReadSavedPage(): { fbDtsg: string | null; connection: FbConnection | null } {
  // The all-saves Relay connection: edges of "Save" nodes (or the all_saves
  // key itself, so an empty list still parses).
  const findConn = (obj: unknown, key: string, depth: number): FbConnection | null => {
    if (!obj || typeof obj !== "object" || depth > 22) return null;
    const o = obj as {
      edges?: { node?: { __typename?: string } }[];
      page_info?: unknown;
    };
    if (Array.isArray(o.edges) && o.page_info && (o.edges[0]?.node?.__typename === "Save" || key === "all_saves")) {
      return o as FbConnection;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") {
        const found = findConn(v, k, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  let connection: FbConnection | null = null;
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    try {
      connection = findConn(JSON.parse(s.textContent || ""), "", 0);
    } catch {
      // not all inline scripts are plain JSON; skip
    }
    if (connection) break;
  }
  const inline = [...document.scripts].map((s) => s.textContent).join("\n");
  return {
    fbDtsg: inline.match(/DTSGInitialData[^}]*"token":"([^"]+)"/)?.[1] || null,
    connection,
  };
}

/** Discover a persisted-query doc_id by scanning the tab's loaded JS bundles
 *  for the query's _facebookRelayOperation module (exports = the doc_id).
 *  Runs inside the tab so the bundle fetches don't round-trip through the
 *  extension; bundles are served with permissive CORS (Facebook loads them
 *  with crossorigin="anonymous"). */
export async function fbDiscoverDocId(queryName: string): Promise<string | null> {
  const re = new RegExp(`__d\\("${queryName}_facebookRelayOperation"[\\s\\S]{0,200}?exports="(\\d+)"`);
  const urls = [
    ...new Set([
      ...performance
        .getEntriesByType("resource")
        .filter((e) => /\.js/.test(e.name))
        .map((e) => e.name),
      ...[...document.querySelectorAll<HTMLScriptElement>("script[src]")].map((s) => s.src),
    ]),
  ];
  for (let i = 0; i < urls.length; i += 8) {
    const texts = await Promise.all(
      urls.slice(i, i + 8).map((u) =>
        fetch(u).then(
          (r) => r.text(),
          () => ""
        )
      )
    );
    for (const t of texts) {
      const m = t.match(re);
      if (m) return m[1]!;
    }
  }
  return null;
}

/** Same-origin GraphQL POST (persisted query, form-encoded body built by the
 *  provider). Returns status 0 with the error text when the fetch fails. */
export async function fbGraphqlPost(
  body: string,
  friendlyName: string
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch("/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": friendlyName,
      },
      body,
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}
