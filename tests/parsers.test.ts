import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePage, PARSERS } from "../src/core/parse/index.ts";
import { parseStats as parseYouTubeStats } from "../src/core/parse/youtube.ts";
import type { ProviderId } from "../src/core/types.ts";

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

test("linkedin: entities become poster-faceted items, pagination token extracted", () => {
  const { items, cursor, hasNext } = parsePage("linkedin", {
    body: fixture("linkedin/saved-posts-page.json"),
  });
  assert.equal(items.length, 1); // the non-EntityResultViewModel entry is skipped
  const item = items[0]!;
  assert.equal(item.externalId, "urn:li:fsd_entityResultViewModel:1");
  assert.equal(item.title, ""); // poster-not-in-title convention
  assert.equal(item.posterName, "Jane Doe");
  assert.equal(item.posterHandle, "");
  assert.equal(item.posterBio, "Staff Engineer at Example");
  assert.equal(item.publication, undefined);
  assert.equal(item.summary, "Thoughts on distributed systems…");
  assert.equal(item.image, "https://media.licdn.com/dms/image/abc/100w.jpg"); // ~100px artifact wins
  assert.equal(cursor, "TOKEN-1");
  assert.equal(hasNext, true);
});

test("hackernews stories: title/site/points parsed, discussion URLs, epoch age", () => {
  const { items, cursor, hasNext } = parsePage("hackernews", {
    kind: "stories",
    body: fixture("hackernews/upvoted-stories.html"),
    context: { url: "https://news.ycombinator.com/upvoted?id=alice" },
  });
  assert.equal(items.length, 2);
  const [story, ask] = [items[0]!, items[1]!];
  assert.equal(story.externalId, "11111");
  assert.equal(story.title, "Story One & friends"); // tags stripped, entities decoded
  assert.equal(story.posterHandle, "alice");
  assert.equal(story.publication, "example.com");
  assert.equal(story.summary, "");
  assert.deepEqual(story.stats, { points: "1234 points", comments: "456 comments" });
  assert.equal(story.url, "https://news.ycombinator.com/item?id=11111");
  assert.equal(story.publishedAt, 1783344537000); // epoch-suffixed age wins
  assert.equal(story.kind, "story");
  assert.deepEqual(story.collection, ["upvoted"]);
  // Ask HN: relative link resolved against the origin, ISO-only age parsed as UTC
  assert.equal(ask.url, "https://news.ycombinator.com/item?id=22222");
  assert.equal(ask.publishedAt, Date.parse("2026-07-05T10:00:00Z"));
  // More link followed relative to the page's own URL
  assert.equal(cursor, "https://news.ycombinator.com/upvoted?id=alice&next=22222");
  assert.equal(hasNext, true);
});

test("hackernews comments: body flattened, story context in publication, title attribute wins", () => {
  const { items, cursor, hasNext } = parsePage("hackernews", {
    kind: "comments",
    body: fixture("hackernews/upvoted-comments.html"),
  });
  assert.equal(items.length, 1);
  const c = items[0]!;
  assert.equal(c.externalId, "33333");
  assert.equal(c.title, "");
  assert.equal(c.posterHandle, "carol");
  assert.equal(c.publication, "on: The Full Story Title, Untruncated"); // title attr over truncated text
  assert.equal(c.summary, "First line & more\nSecond paragraph with a link");
  assert.equal(c.kind, "comment");
  assert.equal(c.publishedAt, 1783150000000);
  assert.equal(cursor, null); // no morelink on this page
  assert.equal(hasNext, false);
});

test("instagram items: kinds, collection names from context, thumbnail choice", () => {
  const { items, cursor, hasNext } = parsePage("instagram", {
    kind: "items",
    body: fixture("instagram/saved-feed-page.json"),
    context: { collections: { 111: "Recipes", 222: "Travel" } },
  });
  assert.equal(items.length, 2); // the pk-less entry is skipped
  const [reel, carousel] = [items[0]!, items[1]!];
  assert.equal(reel.externalId, "310000000000001");
  assert.equal(reel.title, "");
  assert.equal(reel.posterName, "Jane Doe");
  assert.equal(reel.posterHandle, "janedoe");
  assert.equal(reel.summary, "A recipe reel caption"); // trimmed
  assert.equal(reel.kind, "reel"); // product_type clips beats media_type
  assert.equal(reel.url, "https://www.instagram.com/reel/C1abcDEfgh/");
  assert.ok(reel.publishedAt! > 0);
  assert.equal(reel.duration, 13); // 12.6 rounded
  assert.deepEqual(reel.collection, ["Recipes", "Travel"]); // unknown id 999 dropped
  assert.equal(reel.image, "https://cdn.example/100.jpg"); // ~100px candidate wins
  assert.equal(carousel.kind, "carousel");
  assert.equal(carousel.image, "https://cdn.example/carousel.jpg"); // first slide's image
  assert.equal(cursor, "MAXID-2");
  assert.equal(hasNext, true);
});

test("instagram collections page: id → name map, no items", () => {
  const { items, collections, hasNext } = parsePage("instagram", {
    kind: "collections",
    body: fixture("instagram/collections-page.json"),
  });
  assert.deepEqual(items, []);
  assert.deepEqual(collections, { 111: "Recipes", 222: "Travel" });
  assert.equal(hasNext, false);
});

test("twitter: t.co expansion, media kind, wrapped tweets, bottom cursor", () => {
  const { items, cursor, hasNext } = parsePage("twitter", {
    body: fixture("twitter/bookmarks-page.json"),
  });
  assert.equal(items.length, 2);
  const [video, plain] = [items[0]!, items[1]!];
  assert.equal(video.externalId, "111");
  assert.equal(video.title, "");
  assert.equal(video.posterName, "Jane Doe");
  assert.equal(video.posterHandle, "jane");
  // t.co link expanded, trailing t.co media link stripped
  assert.equal(video.summary, "Check this out https://example.com/article");
  assert.equal(video.kind, "video");
  assert.equal(video.duration, 63); // 63400 ms
  assert.ok(video.publishedAt! > 0);
  assert.equal(video.url, "https://x.com/jane/status/111");
  assert.equal(video.image, "https://pbs.twimg.com/media/1.jpg?name=small");
  // TweetWithVisibilityResults wrapper unwrapped; legacy user fields accepted
  assert.equal(plain.externalId, "222");
  assert.equal(plain.posterName, "Bob");
  assert.equal(plain.posterHandle, "bob");
  assert.equal(plain.kind, "tweet");
  assert.equal(plain.image, "https://pbs.twimg.com/avatar-bob.jpg"); // avatar fallback
  assert.equal(cursor, "cursor-bottom-1");
  assert.equal(hasNext, true);
});

test("youtube playlist page: per-playlist ids, short detection, unplayable stubs skipped", () => {
  const fetchedAt = Date.parse("2026-07-08T12:00:00Z");
  const { items, cursor, hasNext } = parsePage("youtube", {
    kind: "items",
    body: fixture("youtube/playlist-page.json"),
    context: { playlistId: "WL", collection: "Watch later" },
    fetchedAt,
  });
  assert.equal(items.length, 2); // isPlayable:false stub skipped
  const [video, short] = [items[0]!, items[1]!];
  assert.equal(video.externalId, "abc123"); // video-scoped id
  assert.equal(video.title, "A Long Video");
  assert.equal(video.posterName, "Some Channel");
  assert.equal(video.posterHandle, "");
  assert.equal(video.summary, "");
  assert.deepEqual(video.stats, {
    views: "1.2M views",
    age: "2 years ago",
  });
  assert.equal(video.publishedAt, Date.parse("2024-07-08T00:00:00.000Z"));
  assert.equal(video.kind, "video");
  assert.equal(video.duration, 213);
  assert.deepEqual(video.collection, ["Watch later"]);
  assert.equal(video.image, "https://i.ytimg.com/120.jpg"); // ~100px thumbnail wins
  assert.equal(short.kind, "short");
  assert.equal(short.url, "https://www.youtube.com/shorts/short1");
  assert.equal(cursor, "cont-token-1");
  assert.equal(hasNext, true);
});

test("youtube continuation page: real rows appended directly, menu copies ignored", () => {
  // A real continuation batch (captured 2026-07-22): the next page of the
  // playlist's own videos arrives as direct playlistVideoRenderer children of
  // continuationItems, each row's menu embedding a duplicate renderer (the
  // re-insert row for the Add button) that must not be counted twice. The
  // trailing continuationItemRenderer is the playlist's real "more" token.
  const { items, cursor, hasNext } = parsePage("youtube", {
    kind: "items",
    body: fixture("youtube/playlist-continuation-page.json"),
    context: { playlistId: "PL1", collection: "bengali" },
    fetchedAt: Date.parse("2026-07-08T12:00:00Z"),
  });
  assert.deepEqual(items.map((i) => i.externalId), ["cont1"]); // no menu duplicate
  assert.equal(cursor, "cont-token-2");
  assert.equal(hasNext, true);
});

test("youtube playlist end: sectionList recommendations token is not followed", () => {
  // A playlist whose videos fit on one page (captured 2026-07-22): its own
  // continuation is exhausted, so the only token left is a sibling at the
  // sectionList level that loads the appended "Recommended videos" section.
  // Following it pulled suggestions into the DB — the real end must report
  // hasNext:false while still returning the playlist's actual videos.
  const { items, cursor, hasNext } = parsePage("youtube", {
    kind: "items",
    body: fixture("youtube/playlist-end-recommendations-token.json"),
    context: { playlistId: "PL1", collection: "music" },
    fetchedAt: Date.parse("2026-07-08T12:00:00Z"),
  });
  assert.deepEqual(items.map((i) => i.externalId), ["real1", "real2"]);
  assert.equal(cursor, null);
  assert.equal(hasNext, false);
});

test("youtube recommended tail page: suggestion itemSection and its token ignored", () => {
  // Once followed, the recommendations continuation returns a
  // recommendations-flagged itemSectionRenderer of videos NOT in the playlist
  // (captured 2026-07-22, music). Neither its rows nor its own "more" token may
  // be ingested — the batch carries no real playlistVideoRenderer rows.
  const { items, cursor, hasNext } = parsePage("youtube", {
    kind: "items",
    body: fixture("youtube/playlist-recommended-tail.json"),
    context: { playlistId: "PL1", collection: "music" },
    fetchedAt: Date.parse("2026-07-08T12:00:00Z"),
  });
  assert.deepEqual(items, []);
  assert.equal(cursor, null);
  assert.equal(hasNext, false);
});

test("youtube playlists feed: both renderer dialects parsed", () => {
  const { items, playlists, hasNext } = parsePage("youtube", {
    kind: "playlists",
    body: fixture("youtube/playlists-feed.json"),
  });
  assert.deepEqual(items, []);
  assert.deepEqual(playlists, { PL111: "Recipes", PL222: "Workouts" });
  assert.equal(hasNext, false);
});

test("youtube stats estimate publish date from bullet-separated relative age", () => {
  assert.deepEqual(
    parseYouTubeStats(
      { runs: [{ text: "45K views" }, { text: " • " }, { text: "11 days ago" }] },
      Date.parse("2026-07-08T12:00:00Z")
    ),
    {
      stats: { views: "45K views", age: "11 days ago" },
      publishedAt: Date.parse("2026-06-27T00:00:00.000Z"),
    }
  );
});

test("substack: posts and notes keep bookmark and publish times separate", () => {
  const { items, cursor, hasNext } = parsePage("substack", {
    body: fixture("substack/saved-page.json"),
  });
  assert.equal(items.length, 2);
  const [post, note] = [items[0]!, items[1]!];
  assert.equal(post.externalId, "post:9001");
  assert.equal(post.title, "On Writing Well");
  assert.equal(post.posterName, "Jane Doe");
  assert.equal(post.posterHandle, "");
  assert.equal(post.publication, "Example Letters");
  assert.equal(post.bookmarkedAt, Date.parse("2026-02-03T00:00:00.000Z"));
  assert.equal(post.publishedAt, Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(post.kind, "newsletter");
  assert.equal(note.externalId, "note:7001");
  assert.equal(note.title, "");
  assert.equal(note.posterName, "Bob");
  assert.equal(note.posterHandle, "bobwrites");
  assert.equal(note.summary, "a saved note body");
  assert.equal(note.url, "https://substack.com/@bobwrites/note/c-7001");
  assert.equal(note.bookmarkedAt, 0); // note has no bookmark timestamp
  assert.equal(note.publishedAt, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(note.kind, "note");
  assert.equal(cursor, "CURSOR-2");
  assert.equal(hasNext, true);
});

test("facebook connection: savable fields, storypointer→post, id-less nodes skipped", () => {
  const { items, cursor, hasNext } = parsePage("facebook", {
    kind: "connection",
    body: fixture("facebook/connection-page.json"),
  });
  assert.equal(items.length, 2);
  const [video, post] = [items[0]!, items[1]!];
  assert.equal(video.externalId, "save-node-1");
  assert.equal(video.title, "");
  assert.equal(video.publication, "");
  assert.equal(video.posterName, "Some Page");
  assert.equal(video.posterHandle, "somepage");
  assert.equal(video.summary, "A saved video title");
  assert.equal(video.url, "https://www.facebook.com/watch/?v=123"); // relative permalink resolved
  assert.equal(video.kind, "video");
  assert.equal(video.duration, 63);
  assert.deepEqual(video.collection, ["Watch list", "Other"]);
  assert.equal(post.kind, "post"); // storypointer normalized
  assert.equal(post.posterName, "Semanti Mukhopadhyay");
  assert.equal(post.posterHandle, "semanti.mukhopadhyay.9");
  assert.equal(post.publication, "Some Group");
  assert.equal(cursor, "FBCURSOR-1");
  assert.equal(hasNext, true);
});

test("all parsers tolerate empty/malformed page objects without throwing", () => {
  const cases: Record<ProviderId, string> = {
    linkedin: "{}",
    hackernews: "<html>nothing here</html>",
    instagram: "{}",
    twitter: "{}",
    youtube: "{}",
    facebook: "{}",
    substack: "{}",
  };
  for (const [provider, body] of Object.entries(cases) as [ProviderId, string][]) {
    const res = parsePage(provider, { body, context: {} });
    assert.deepEqual(res.items, [], `${provider} should yield no items`);
    assert.equal(res.hasNext, false, `${provider} should not page on`);
  }
});

test("no parser emits legacy saved_items fields", () => {
  const pages: [ProviderId, Parameters<typeof parsePage>[1]][] = [
    ["linkedin", { body: fixture("linkedin/saved-posts-page.json") }],
    ["hackernews", { kind: "stories", body: fixture("hackernews/upvoted-stories.html") }],
    ["instagram", { kind: "items", body: fixture("instagram/saved-feed-page.json"), context: {} }],
    ["twitter", { body: fixture("twitter/bookmarks-page.json") }],
    [
      "youtube",
      {
        kind: "items",
        body: fixture("youtube/playlist-page.json"),
        context: { playlistId: "WL", collection: "Watch later" },
      },
    ],
    ["substack", { body: fixture("substack/saved-page.json") }],
    ["facebook", { body: fixture("facebook/connection-page.json") }],
  ];
  for (const [provider, page] of pages) {
    for (const item of parsePage(provider, page).items) {
      assert.ok(!("metadata" in item), `${provider} item still carries metadata`);
      assert.ok(!("subtitle" in item), `${provider} item still carries subtitle`);
      assert.ok(!("poster" in item), `${provider} item still carries poster`);
    }
  }
});

test("registry covers every provider and rejects unknown ones", () => {
  assert.deepEqual(Object.keys(PARSERS).sort(), [
    "facebook",
    "hackernews",
    "instagram",
    "linkedin",
    "substack",
    "twitter",
    "youtube",
  ]);
  assert.throws(() => parsePage("myspace" as ProviderId, { body: "{}" }), /No parser/);
});
