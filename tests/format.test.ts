import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSynced,
  formatDuration,
  formatCollection,
  formatStats,
  formatPoster,
  formatRelativeDate,
  metaParts,
} from "../src/core/format.ts";

test("formatSynced buckets: never / just now / minutes / absolute", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  assert.equal(formatSynced(0, now), "never synced");
  assert.equal(formatSynced(now - 20_000, now), "synced just now");
  assert.equal(formatSynced(now - 5 * 60_000, now), "synced 5 min ago");
  assert.match(formatSynced(now - 3 * 3600_000, now), /^synced \d/); // locale string
});

test("formatDuration renders m:ss and h:mm:ss", () => {
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3661), "1:01:01");
});

test("formatCollection joins decoded arrays", () => {
  assert.equal(formatCollection(["Watch later", "Recipes"]), "Watch later, Recipes");
  assert.equal(formatCollection(["One", "Two"]), "One, Two");
  assert.equal(formatCollection([]), "");
  assert.equal(formatCollection(undefined), "");
});

test("formatStats renders provider metrics", () => {
  assert.equal(formatStats({ views: "1.2M views", age: "2 years ago" }), "1.2M views · 2 years ago");
  assert.equal(formatStats({ points: "1234 points", comments: "456 comments" }), "1234 points · 456 comments");
  assert.equal(formatStats({ info: "No views" }), "No views");
  assert.equal(formatStats({ likes: "10" }), "likes: 10");
});

test("metaParts renders HN counts like date metadata and hides the upvoted collection", () => {
  const current = metaParts({
    provider: "hackernews",
    kind: "story",
    stats: { points: "1234 points", comments: "456 comments" },
    collection: ["upvoted"],
    publishedAt: Date.parse("2026-07-06T00:00:00Z"),
  });
  assert.equal(current[0], "1234 points · 456 comments");
  assert.ok(!current.includes("upvoted"));

  // Rows saved before counters moved from summary to stats render identically.
  const legacy = metaParts({
    provider: "hackernews",
    kind: "story",
    summary: "1234 points · 456 comments",
    stats: {},
    collection: ["upvoted"],
  });
  assert.deepEqual(legacy, ["1234 points · 456 comments"]);
});

test("formatPoster combines split display name and handle", () => {
  assert.equal(formatPoster({ posterName: "Jane Doe", posterHandle: "jane" }), "Jane Doe (@jane)");
  assert.equal(formatPoster({ posterHandle: "@alice" }), "@alice");
  assert.equal(formatPoster({ posterName: "Some Channel" }), "Some Channel");
});

test("formatRelativeDate buckets estimated dates", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  assert.equal(formatRelativeDate(Date.parse("2026-07-08T00:00:00Z"), now), "today");
  assert.equal(formatRelativeDate(Date.parse("2026-06-27T00:00:00Z"), now), "11 days ago");
  assert.equal(formatRelativeDate(Date.parse("2026-06-08T00:00:00Z"), now), "4 weeks ago");
  assert.equal(formatRelativeDate(Date.parse("2025-07-08T00:00:00Z"), now), "1 year ago");
});

test("metaParts replaces YouTube's frozen age with a dynamic relative date", () => {
  const item = {
    provider: "youtube" as const,
    kind: "short",
    duration: 65,
    stats: { views: "1.2M views", age: "2 years ago" },
    collection: ["Watch later"],
    publishedAt: Date.parse("2024-07-08T00:00:00Z"),
  };
  const parts = metaParts(item, {
    providerLabel: "YouTube",
    now: Date.parse("2026-07-08T12:00:00Z"),
  });
  assert.equal(parts[0], "YouTube");
  assert.equal(parts[1], "Short");
  assert.equal(parts[2], "1:05");
  assert.equal(parts[3], "1.2M views");
  assert.equal(parts[4], "Watch later");
  assert.equal(parts[5], "about 2 years ago");
  assert.equal(parts.length, 6);

  // Empty fields drop out entirely.
  assert.deepEqual(metaParts({ kind: "story" }), []);
});

test("YouTube's relative publication date advances without another sync", () => {
  const item = {
    provider: "youtube" as const,
    kind: "video",
    stats: { views: "50K views", age: "10 days ago" },
    publishedAt: Date.parse("2026-07-01T00:00:00Z"),
  };
  assert.deepEqual(metaParts(item, { now: Date.parse("2026-07-11T12:00:00Z") }), [
    "50K views",
    "about 10 days ago",
  ]);
  assert.deepEqual(metaParts(item, { now: Date.parse("2026-07-12T12:00:00Z") }), [
    "50K views",
    "about 11 days ago",
  ]);
});

test("metaParts shows an estimated YouTube date when its age stat is absent", () => {
  const parts = metaParts(
    {
      provider: "youtube",
      kind: "video",
      publishedAt: Date.parse("2024-07-08T00:00:00Z"),
    },
    { now: Date.parse("2026-07-08T12:00:00Z") }
  );
  assert.deepEqual(parts, ["about 2 years ago"]);
});

test("metaParts keeps non-estimated saved dates absolute", () => {
  const parts = metaParts({
    kind: "story",
    bookmarkedAt: Date.parse("2026-01-02T00:00:00Z"),
  });
  assert.match(parts[0]!, /2026/);
});
