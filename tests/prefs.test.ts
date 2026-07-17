import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryPrefs } from "../src/core/prefs.ts";

test("memory prefs: get/set/remove round-trip", async () => {
  const prefs = createMemoryPrefs({ lastProvider: "hackernews" });
  assert.equal(await prefs.get("lastProvider"), "hackernews");
  assert.equal(await prefs.get("searchMode"), undefined);
  await prefs.set("openFullPage", true);
  assert.equal(await prefs.get("openFullPage"), true);
  await prefs.set("ai:settings", { embedProvider: "local" });
  assert.deepEqual(await prefs.get("ai:settings"), { embedProvider: "local" });
  await prefs.remove("ai:settings");
  assert.equal(await prefs.get("ai:settings"), undefined);
});

test("memory prefs: watch fires on set and remove, unwatch stops it", async () => {
  const prefs = createMemoryPrefs();
  const seen: (boolean | undefined)[] = [];
  const unwatch = prefs.watch("captureRaw", (v) => seen.push(v));
  await prefs.set("captureRaw", true);
  await prefs.set("testMode", true); // unrelated key: no event
  await prefs.remove("captureRaw");
  unwatch();
  await prefs.set("captureRaw", false);
  assert.deepEqual(seen, [true, undefined]);
});

test("meta keys are per provider", async () => {
  const prefs = createMemoryPrefs();
  await prefs.set("meta:hackernews", { syncedAt: 123 });
  assert.deepEqual(await prefs.get("meta:hackernews"), { syncedAt: 123 });
  assert.equal(await prefs.get("meta:youtube"), undefined);
});
