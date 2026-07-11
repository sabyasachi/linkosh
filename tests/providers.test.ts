// Provider pagination and self-repair loops against a scripted ProviderEnv —
// the fetch/tab/self-repair logic that was untestable before the env port
// existed. Runs end-to-end through the real sync layer, parsers and an
// in-memory DB; only the environment (cookies, tabs, injected execution,
// HTTP) is faked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "./helpers/open-db.ts";
import { asyncDbApi } from "./helpers/async-db.ts";
import { count } from "../src/core/db/items.ts";
import { createSync } from "../src/core/sync.ts";
import type { Provider, ProviderId, ProviderMeta } from "../src/core/types.ts";
import type { ProviderEnv } from "../src/ext/providers/env.ts";
import { createProvider as createTwitter, featureFixes } from "../src/ext/providers/twitter.ts";
import { createProvider as createFacebook } from "../src/ext/providers/facebook.ts";
import { createProvider as createHackernews } from "../src/ext/providers/hackernews.ts";
import { createProvider as createInstagram } from "../src/ext/providers/instagram.ts";
import { xApiGet } from "../src/injected/twitter.ts";
import { igApiGet } from "../src/injected/instagram.ts";
import { fbDiscoverDocId, fbGraphqlPost, fbReadSavedPage } from "../src/injected/facebook.ts";
import type { SqlDatabase } from "../src/core/db/port.ts";

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

type InjectedCall = { fn: unknown; args: unknown[] };

/** A scripted env: cookies by name, injected execution routed to a handler,
 *  instant sleeps, in-memory cache. */
function fakeEnv({
  cookies = {},
  onExec = () => {
    throw new Error("unexpected execInTab");
  },
}: {
  cookies?: Record<string, string>;
  onExec?: (call: InjectedCall) => unknown;
} = {}) {
  const cacheStore = new Map<string, string>();
  const execCalls: InjectedCall[] = [];
  const sleeps: number[] = [];
  const env: ProviderEnv = {
    getCookie: async (_url, name) => cookies[name] ?? null,
    withTab: async (_target, fn) => fn(1),
    async execInTab(_tabId, fn, args) {
      const call = { fn, args: args as unknown[] };
      execCalls.push(call);
      return (await onExec(call)) as never;
    },
    cache: {
      get: async (key) => cacheStore.get(key),
      set: async (key, value) => void cacheStore.set(key, value),
      remove: async (key) => void cacheStore.delete(key),
    },
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { env, cacheStore, execCalls, sleeps };
}

async function runSync(provider: Provider, db: SqlDatabase) {
  const meta = new Map<ProviderId, ProviderMeta>();
  const sync = createSync({
    providers: { [provider.id]: provider },
    db: asyncDbApi(db),
    getMeta: async (id) => meta.get(id) ?? null,
    setMeta: async (id, m) => void meta.set(id, m),
  });
  return sync.syncProvider(provider.id);
}

// ---------------------------------------------------------------------------
// twitter
// ---------------------------------------------------------------------------

const TWITTER_COOKIES = { auth_token: "a", ct0: "csrf" };

function twitterExec(handler: (path: string) => { status: number; body: string }) {
  return ({ fn, args }: InjectedCall) => {
    assert.equal(fn, xApiGet); // providers must go through the injected module
    return handler(args[0] as string);
  };
}

test("twitter: stale queryId 404s through to the next candidate; stop rule ends paging", async () => {
  const db = await openDb();
  const requested: string[] = [];
  const { env } = fakeEnv({
    cookies: TWITTER_COOKIES,
    onExec: twitterExec((path) => {
      requested.push(path);
      if (path.startsWith("/i/api/1.1/account/settings.json")) {
        return { status: 200, body: JSON.stringify({ screen_name: "jane" }) };
      }
      if (path.includes("/QUjXply7fA7fk05FRyajEg/")) return { status: 404, body: "{}" }; // stale
      if (path.includes("/tmd4ifV8RHltzn8ymGg1aw/")) {
        return { status: 200, body: fixture("twitter/bookmarks-page.json") };
      }
      throw new Error(`unexpected path ${path}`);
    }),
  });

  const res = await runSync(createTwitter(env), db);
  assert.equal(res.status, "ok");
  assert.equal(res.inserted, 2);
  assert.equal(count(db, { provider: "twitter" }), 2);
  // Page 2 served the same fixture: every item already seen → stop, page 3
  // never requested.
  const bookmarkCalls = requested.filter((p) => p.includes("/Bookmarks?"));
  assert.equal(bookmarkCalls.length, 3); // stale 404 + page 1 + page 2 (all-seen)
  db.close();
});

test("twitter: feature-flag drift self-repairs from the server's own errors", async () => {
  const db = await openDb();
  const featureMaps: Record<string, boolean>[] = [];
  const { env } = fakeEnv({
    cookies: TWITTER_COOKIES,
    onExec: twitterExec((path) => {
      if (path.startsWith("/i/api/1.1/account/settings.json")) {
        return { status: 200, body: JSON.stringify({ screen_name: "jane" }) };
      }
      const features = JSON.parse(
        new URLSearchParams(path.split("?")[1]).get("features")!
      ) as Record<string, boolean>;
      featureMaps.push(features);
      if (!("brand_new_flag" in features)) {
        return {
          status: 200,
          body: JSON.stringify({
            errors: [
              { message: "The following features cannot be null: brand_new_flag" },
              { message: "unknown features: premium_content_api_read_enabled" },
            ],
          }),
        };
      }
      return { status: 200, body: fixture("twitter/bookmarks-page.json") };
    }),
  });

  const res = await runSync(createTwitter(env), db);
  assert.equal(res.status, "ok");
  assert.equal(res.inserted, 2);
  const repaired = featureMaps.at(-1)!;
  assert.equal(repaired.brand_new_flag, false); // added from "cannot be null"
  assert.ok(!("premium_content_api_read_enabled" in repaired)); // removed from "unknown features"
  db.close();
});

test("twitter: missing cookies report failed + needsLogin (never a throw)", async () => {
  const db = await openDb();
  const { env } = fakeEnv({ cookies: {} });
  const res = await runSync(createTwitter(env), db);
  assert.equal(res.status, "failed");
  assert.ok(res.status === "failed" && res.needsLogin);
  db.close();
});

test("featureFixes parses both drift error shapes", () => {
  assert.deepEqual(
    featureFixes({
      errors: [
        { message: "The following features cannot be null: foo, bar" },
        { message: "unknown features: baz" },
      ],
    }),
    { add: ["foo", "bar"], remove: ["baz"] }
  );
  assert.deepEqual(featureFixes(null), { add: [], remove: [] });
});

// ---------------------------------------------------------------------------
// facebook
// ---------------------------------------------------------------------------

const FB_COOKIES = { c_user: "100001", xs: "x" };
const FB_CONNECTION = () => JSON.parse(fixture("facebook/connection-page.json")) as object;
const FB_LAST_PAGE = {
  edges: [],
  page_info: { end_cursor: null, has_next_page: false },
};

test("facebook: discovers and caches the pagination doc_id", async () => {
  const db = await openDb();
  const graphqlBodies: string[] = [];
  const { env, cacheStore } = fakeEnv({
    cookies: FB_COOKIES,
    onExec: ({ fn, args }) => {
      if (fn === fbReadSavedPage) return { fbDtsg: "TOKEN", connection: FB_CONNECTION() };
      if (fn === fbDiscoverDocId) return "999111";
      if (fn === fbGraphqlPost) {
        graphqlBodies.push(args[0] as string);
        return { status: 200, body: JSON.stringify({ data: { saves: FB_LAST_PAGE } }) };
      }
      throw new Error("unexpected injected fn");
    },
  });

  const res = await runSync(createFacebook(env), db);
  assert.equal(res.status, "ok");
  assert.equal(res.inserted, 2); // fixture page 1; page 2 is empty
  assert.equal(cacheStore.get("facebook:paginationDocId"), "999111");
  const params = new URLSearchParams(graphqlBodies[0]!);
  assert.equal(params.get("doc_id"), "999111");
  assert.equal(params.get("fb_dtsg"), "TOKEN");
  assert.equal(params.get("av"), "100001");
  db.close();
});

test("facebook: a stale cached doc_id is rediscovered once and replaced", async () => {
  const db = await openDb();
  const docIdsTried: string[] = [];
  const { env, cacheStore } = fakeEnv({
    cookies: FB_COOKIES,
    onExec: ({ fn, args }) => {
      if (fn === fbReadSavedPage) return { fbDtsg: "TOKEN", connection: FB_CONNECTION() };
      if (fn === fbDiscoverDocId) return "fresh-42";
      if (fn === fbGraphqlPost) {
        const docId = new URLSearchParams(args[0] as string).get("doc_id")!;
        docIdsTried.push(docId);
        if (docId === "stale-1") {
          return { status: 200, body: JSON.stringify({ errors: [{ message: "unsupported doc_id" }] }) };
        }
        return { status: 200, body: JSON.stringify({ data: { saves: FB_LAST_PAGE } }) };
      }
      throw new Error("unexpected injected fn");
    },
  });
  cacheStore.set("facebook:paginationDocId", "stale-1");

  const res = await runSync(createFacebook(env), db);
  assert.equal(res.status, "ok");
  assert.deepEqual(docIdsTried, ["stale-1", "fresh-42"]);
  assert.equal(cacheStore.get("facebook:paginationDocId"), "fresh-42");
  db.close();
});

test("facebook: doc_id discovery failure after page 1 is a partial sync", async () => {
  const db = await openDb();
  const { env } = fakeEnv({
    cookies: FB_COOKIES,
    onExec: ({ fn }) => {
      if (fn === fbReadSavedPage) return { fbDtsg: "TOKEN", connection: FB_CONNECTION() };
      if (fn === fbDiscoverDocId) return null; // renamed query: discovery fails
      throw new Error("unexpected injected fn");
    },
  });

  const res = await runSync(createFacebook(env), db);
  assert.equal(res.status, "partial"); // page 1 landed before the failure
  assert.equal(res.inserted, 2);
  assert.ok(res.status === "partial" && /doc_id/.test(res.error));
  db.close();
});

// ---------------------------------------------------------------------------
// hackernews (direct fetch — global fetch is faked)
// ---------------------------------------------------------------------------

test("hackernews: walks stories then comments, following served More links", async (t) => {
  const db = await openDb();
  const paths: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = (async (input: string | URL) => {
    const path = String(input).replace("https://news.ycombinator.com", "");
    paths.push(path);
    const body = path.includes("comments=t")
      ? fixture("hackernews/upvoted-comments.html")
      : path.includes("next=")
        ? "<html><body>no more rows</body></html>" // page 2: nothing left
        : fixture("hackernews/upvoted-stories.html");
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  const { env } = fakeEnv({ cookies: { user: "alice&hmac" } });
  const res = await runSync(createHackernews(env), db);
  assert.equal(res.status, "ok");
  assert.equal(res.inserted, 3); // 2 stories + 1 comment
  assert.deepEqual(paths, [
    "/upvoted?id=alice", // stories page 1
    "/upvoted?id=alice&next=22222", // followed the fixture's More link
    "/upvoted?id=alice&comments=t", // comments list (no More link → done)
  ]);
  db.close();
});

test("hackernews: a rate-limit page surfaces as a readable ProviderError", async (t) => {
  const db = await openDb();
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = (async () =>
    new Response("<html>we're not able to serve your requests this quickly</html>", {
      status: 200,
    })) as typeof fetch;

  const { env } = fakeEnv({ cookies: { user: "alice&hmac" } });
  const res = await runSync(createHackernews(env), db);
  assert.equal(res.status, "failed");
  assert.ok(res.status === "failed" && /rate limiting/.test(res.error));
  db.close();
});

// ---------------------------------------------------------------------------
// instagram (injected in MAIN world; transient-throttle retry/backoff)
// ---------------------------------------------------------------------------

const IG_COOKIES = { sessionid: "s", csrftoken: "csrf", ds_user_id: "123" };

/** Script igApiGet responses by URL path. `feed` receives the request path
 *  (so a test can assert the resume cursor) and gets a per-call sequence so a
 *  page can 572 a few times before succeeding. */
function instagramExec(handlers: {
  feed: (path: string) => { status: number; body: string };
}) {
  return ({ fn, args }: InjectedCall) => {
    assert.equal(fn, igApiGet); // provider must go through the injected module
    const path = args[0] as string;
    if (path.startsWith("/api/v1/accounts/current_user/")) {
      return { status: 200, body: JSON.stringify({ user: { username: "jane" } }) };
    }
    if (path.startsWith("/api/v1/collections/list/")) {
      return { status: 200, body: JSON.stringify({ items: [], more_available: false }) };
    }
    if (path.startsWith("/api/v1/feed/saved/posts/")) return handlers.feed(path);
    throw new Error(`unexpected path ${path}`);
  };
}

const IG_TERMINAL = JSON.stringify({ items: [], more_available: false });

test("instagram: repairs a drifted current-account lookup via ds_user_id", async () => {
  const db = await openDb();
  const requested: string[] = [];
  let feedCall = 0;
  const { env } = fakeEnv({
    cookies: IG_COOKIES,
    onExec: ({ fn, args }) => {
      assert.equal(fn, igApiGet);
      const path = args[0] as string;
      requested.push(path);
      if (path === "/api/v1/accounts/current_user/") {
        return { status: 404, body: "{}" }; // observed lookup no longer produced a username
      }
      if (path === "/api/v1/users/123/info/") {
        return { status: 200, body: JSON.stringify({ user: { username: "jane" } }) };
      }
      if (path.startsWith("/api/v1/collections/list/")) {
        return { status: 200, body: JSON.stringify({ items: [], more_available: false }) };
      }
      if (path.startsWith("/api/v1/feed/saved/posts/")) {
        feedCall++;
        return {
          status: 200,
          body: feedCall === 1 ? fixture("instagram/saved-feed-page.json") : IG_TERMINAL,
        };
      }
      throw new Error(`unexpected path ${path}`);
    },
  });

  const res = await runSync(createInstagram(env), db);
  assert.equal(res.status, "ok");
  assert.deepEqual(
    db.rows<{ account: string }>("SELECT DISTINCT account FROM saved_items WHERE provider = 'instagram'"),
    [{ account: "jane" }]
  );
  assert.ok(requested.includes("/api/v1/users/123/info/"));
  db.close();
});

test("instagram: injects in MAIN world and rides through a 572 throttle", async () => {
  const db = await openDb();
  const page1 = fixture("instagram/saved-feed-page.json"); // 2 saveable items, more_available, next_max_id
  let feedCall = 0;
  const worlds: (string | undefined)[] = [];
  const base = fakeEnv({ cookies: IG_COOKIES, onExec: instagramExec({
    feed: () => {
      feedCall++;
      if (feedCall === 1) return { status: 200, body: page1 }; // first page lands
      // second page: throttled twice, then succeeds on the third attempt
      if (feedCall < 4) return { status: 572, body: "" };
      return { status: 200, body: IG_TERMINAL };
    },
  }) });
  // Capture the world each injected call requested.
  const env = { ...base.env, execInTab: ((tabId, fn, args, opts) => {
    worlds.push(opts?.world);
    return base.env.execInTab(tabId, fn, args, opts);
  }) as ProviderEnv["execInTab"] };

  const res = await runSync(createInstagram(env), db);
  assert.equal(res.status, "ok");
  assert.equal(res.inserted, 2);
  assert.equal(count(db, { provider: "instagram" }), 2);
  // Every injected call ran in the MAIN world (the whole point of the fix).
  assert.ok(worlds.every((w) => w === "MAIN"));
  // The two 572s triggered exactly the first two backoffs before success.
  assert.deepEqual(base.sleeps.filter((ms) => ms >= 8000), [8000, 15000]);
  // Reached the end of the feed → the resume checkpoint is cleared.
  assert.equal(await base.env.cache.get("instagram:resumeMaxId"), undefined);
  db.close();
});

test("instagram: a throttle that never clears ends partial and checkpoints the cursor", async () => {
  const db = await openDb();
  const page1 = fixture("instagram/saved-feed-page.json"); // next_max_id: MAXID-2
  let feedCall = 0;
  const { env, sleeps, cacheStore } = fakeEnv({ cookies: IG_COOKIES, onExec: instagramExec({
    feed: () => {
      feedCall++;
      return feedCall === 1 ? { status: 200, body: page1 } : { status: 572, body: "" };
    },
  }) });

  const res = await runSync(createInstagram(env), db);
  assert.equal(res.status, "partial"); // page 1 landed before the wall
  assert.equal(res.inserted, 2);
  assert.ok(res.status === "partial" && /throttling/.test(res.error));
  // Page 2 exhausted all three backoffs before giving up.
  assert.deepEqual(sleeps.filter((ms) => ms >= 8000), [8000, 15000, 25000]);
  // The next-page cursor is checkpointed so the next Refresh resumes there.
  assert.equal(cacheStore.get("instagram:resumeMaxId"), "MAXID-2");
  db.close();
});

test("instagram: the next Refresh resumes from the checkpointed cursor", async () => {
  const db = await openDb();
  const page1 = fixture("instagram/saved-feed-page.json"); // next_max_id: MAXID-2
  const feedPaths: string[] = [];
  let feedCall = 0;
  // Shared env (and its cache) across two runs; the provider is created once.
  const { env, cacheStore } = fakeEnv({ cookies: IG_COOKIES, onExec: instagramExec({
    feed: (path) => {
      feedPaths.push(path);
      feedCall++;
      // Run 1: page 0 lands, page 1 is throttled to exhaustion (→ partial,
      // checkpoint MAXID-2). Run 2: the resumed request completes the feed.
      if (feedCall === 1) return { status: 200, body: page1 };
      if (feedCall <= 5) return { status: 572, body: "" }; // page-1 attempts in run 1
      return { status: 200, body: IG_TERMINAL };
    },
  }) });
  const provider = createInstagram(env);

  const first = await runSync(provider, db);
  assert.equal(first.status, "partial");
  assert.equal(cacheStore.get("instagram:resumeMaxId"), "MAXID-2");

  feedPaths.length = 0;
  const second = await runSync(provider, db);
  assert.equal(second.status, "ok");
  // The resumed run's FIRST feed request already carries the checkpoint cursor
  // — it did not restart from the top of the feed.
  assert.match(feedPaths[0]!, /max_id=MAXID-2/);
  // Backfill complete → checkpoint cleared.
  assert.equal(cacheStore.get("instagram:resumeMaxId"), undefined);
  db.close();
});
