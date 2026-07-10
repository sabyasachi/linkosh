#!/usr/bin/env node
// Dev-only web harness for the popup/page search UX: serves the built assets
// from dist/src and answers BackgroundApi over HTTP RPC from a Node-backed
// SQLite database — the very same createBackgroundService the extension's
// service worker runs, minus live sync (extension-only) and with a
// deterministic token-hash embedder standing in for the model.
//
// Usage (build first — the page loads compiled JS from dist/src):
//   npm run build && npm run ux
//   node src/node/tools/ux-server.ts --db linkosh-export.sqlite
//   node src/node/tools/ux-server.ts --port 5174
//
// With no --db it seeds a tiny in-memory database from parser fixtures so the
// page is immediately usable. With --db, reads and writes go directly to that
// sqlite file.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportBytes, openDb, openDbFile } from "../node-db.ts";
import { createDbService, type DbWorkerApi } from "../../core/db/service.ts";
import { ingestPending, reingest } from "../../core/ingest.ts";
import { rawStore } from "../../core/db/raw.ts";
import { createOrchestrator, type OrchestratorEmbedder } from "../../core/ai/orchestrator.ts";
import { createMemoryPrefs } from "../../core/prefs.ts";
import { createClient } from "../../core/rpc/client.ts";
import { dispatch } from "../../core/rpc/server.ts";
import { directTransport } from "../../core/rpc/transports.ts";
import type { Handlers } from "../../core/rpc/protocol.ts";
import type { SqlDatabase } from "../../core/db/port.ts";
import { createBackgroundService, type BackgroundApi } from "../../ext/background-service.ts";

const root = normalize(join(fileURLToPath(import.meta.url), "../../../.."));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

// ---------- deterministic dev embedder (token-hash bags, L2-normalized) ----

const FAKE_MODEL = "dev:token-hash";
const FAKE_DIM = 64;

function embedText(text: string): Float32Array {
  const v = new Float32Array(FAKE_DIM);
  for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
    v[h % FAKE_DIM]! += 1;
  }
  let norm = Math.hypot(...v);
  if (!norm) {
    v[0] = 1;
    norm = 1;
  }
  for (let i = 0; i < FAKE_DIM; i++) v[i]! /= norm;
  return v;
}

const devEmbedder: OrchestratorEmbedder = {
  async configure() {
    return { model: FAKE_MODEL };
  },
  async status() {
    return { ready: true, model: FAKE_MODEL, dim: FAKE_DIM, downloading: null, error: null };
  },
  async embed({ texts }) {
    return texts.map(embedText);
  },
};

// ---------- the service (exported for tests) ----------

/** The extension's BackgroundApi over a direct in-process DB: real service,
 *  real orchestrator, fake embedder, no live sync (providers are extension-
 *  only — sync/syncAll explain that instead of failing obscurely). */
export function createDevService(db: SqlDatabase): Handlers<BackgroundApi> {
  const workerApi: Handlers<DbWorkerApi> = {
    ...createDbService(db),
    export: () => ({ file: "linkosh-dev.sqlite", size: 0 }), // download rides /api/export instead
    rawIngest: (args) => ingestPending(db, args),
    rawReingest: (args) => reingest(db, args),
  };
  const dbClient = createClient<DbWorkerApi>(directTransport<DbWorkerApi>(workerApi));
  const orchestrator = createOrchestrator({ db: dbClient, ai: devEmbedder, getSettings: async () => null });
  void orchestrator.embedBacklog({}).catch(() => {});

  const service = createBackgroundService({
    providers: {},
    db: dbClient,
    ai: orchestrator,
    prefs: createMemoryPrefs(),
  });
  const syncUnavailable = () => {
    throw new Error("Live sync is extension-only here. Use an exported .sqlite DB or captured raw_data.");
  };
  return {
    ...service,
    sync: syncUnavailable,
    syncAll: syncUnavailable,
    // No live providers here, but the UI still needs the labels for its
    // dropdown and the All-view provider tags.
    listProviders: () => [
      { id: "linkedin", label: "LinkedIn" },
      { id: "instagram", label: "Instagram" },
      { id: "youtube", label: "YouTube" },
      { id: "hackernews", label: "Hacker News" },
      { id: "twitter", label: "X" },
      { id: "facebook", label: "Facebook" },
      { id: "substack", label: "Substack" },
    ],
  };
}

// ---------- fixture seed ----------

function fixture(path: string): string {
  return readFileSync(join(root, "tests/fixtures", path), "utf8");
}

export function seedFixtures(db: SqlDatabase): void {
  const pages = [
    {
      provider: "hackernews" as const,
      account: "alice",
      kind: "stories" as const,
      url: "https://news.ycombinator.com/upvoted?id=alice",
      context: { url: "https://news.ycombinator.com/upvoted?id=alice" },
      body: fixture("hackernews/upvoted-stories.html"),
      externalIds: ["11111", "22222"],
    },
    {
      provider: "instagram" as const,
      account: "janedoe",
      kind: "items" as const,
      url: "/api/v1/feed/saved/posts/",
      context: { collections: { 111: "Recipes", 222: "Travel" } },
      body: fixture("instagram/saved-feed-page.json"),
      externalIds: ["310000000000001", "310000000000002"],
    },
    {
      provider: "youtube" as const,
      account: "you",
      kind: "items" as const,
      url: "https://www.youtube.com/playlist?list=WL",
      context: { playlistId: "WL", collection: "Watch later" },
      body: fixture("youtube/playlist-page.json"),
      externalIds: ["abc123", "short1"],
    },
    {
      provider: "substack" as const,
      account: "you",
      kind: "items" as const,
      url: "https://substack.com/home/saved",
      body: fixture("substack/saved-page.json"),
      externalIds: ["post:9001", "note:7001"],
    },
  ];
  pages.forEach(({ provider, account, externalIds, ...page }, i) =>
    rawStore(db, { provider, account, page: { ...page, page: i }, externalIds, fetchedAt: Date.now() })
  );
  ingestPending(db);
}

// ---------- HTTP plumbing ----------

async function readJson(req: AsyncIterable<Buffer>): Promise<{ op?: string; args?: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as { op?: string; args?: unknown }) : {};
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const dbFile = opt("--db");
  const port = Number(opt("--port") ?? process.env.PORT ?? 5173);

  let wasmDb: Awaited<ReturnType<typeof openDb>> | null = null;
  const db: SqlDatabase = dbFile ? openDbFile(dbFile) : (wasmDb = await openDb());
  if (!dbFile) seedFixtures(db);
  const service = createDevService(db);
  const staticRoot = join(root, "dist", "src");

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "POST" && req.url === "/api/rpc") {
          const { op = "", args: opArgs } = await readJson(req);
          const wire = await dispatch(service, op, opArgs);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify(wire));
        }
        if (req.method === "GET" && req.url === "/api/export") {
          res.writeHead(200, {
            "content-type": "application/vnd.sqlite3",
            "content-disposition": 'attachment; filename="linkosh-dev.sqlite"',
          });
          return res.end(dbFile ? readFileSync(dbFile) : Buffer.from(await exportBytes(wasmDb!)));
        }
        if (req.method === "GET") {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname === "/") {
            // Redirect (not rewrite): dev.html's relative asset URLs must
            // resolve against its real directory.
            res.writeHead(302, { location: "/pages/popup/dev.html" });
            return res.end();
          }
          const pathname = decodeURIComponent(url.pathname);
          const path = normalize(join(staticRoot, pathname));
          if (relative(staticRoot, path).startsWith("..")) {
            res.writeHead(404);
            return res.end("not found");
          }
          try {
            const bytes = readFileSync(path);
            res.writeHead(200, {
              "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
            });
            return res.end(bytes);
          } catch {
            res.writeHead(404);
            return res.end("not found");
          }
        }
        res.writeHead(405);
        res.end("method not allowed");
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Linkosh UX server: http://127.0.0.1:${port}/`);
    console.log(dbFile ? `Using disk DB ${dbFile}.` : "Loaded fixture-seeded in-memory DB.");
    console.log("Serving built assets from dist/src — run `npm run build` after UI edits.");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
