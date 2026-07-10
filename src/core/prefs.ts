// Typed preference store. The schema below is the complete set of persisted
// preferences — get/set/watch are keyed against it, so a typo'd key or a
// wrongly-typed value is a compile error. chrome.storage.local backs it in
// the extension (ext/chrome-prefs.ts); the in-memory twin serves Node tests
// and the dev harness.
//
// The Facebook provider's doc_id cache intentionally stays on raw
// chrome.storage (it's extension-only self-repair state, not a preference).
import type { AiSettings, ProviderId, ProviderMeta, SearchMode } from "./types.ts";

export interface PrefsSchema {
  /** Provider tab the popup last showed ("all" = across providers). */
  lastProvider: ProviderId | "all";
  searchMode: SearchMode;
  /** Dev: archive raw pages instead of upserting (the no-refetch pipeline). */
  captureRaw: boolean;
  /** Dev: cap syncs at ~100 items for smoke tests. */
  testMode: boolean;
  "ai:settings": AiSettings | null;
}

/** Per-provider sync watermark keys, e.g. "meta:hackernews". */
export type AllPrefs = PrefsSchema & { [K in ProviderId as `meta:${K}`]: ProviderMeta };

export interface Prefs {
  get<K extends keyof AllPrefs>(key: K): Promise<AllPrefs[K] | undefined>;
  set<K extends keyof AllPrefs>(key: K, value: AllPrefs[K]): Promise<void>;
  remove(key: keyof AllPrefs): Promise<void>;
  /** Fires with the new value on every change (undefined on removal). */
  watch<K extends keyof AllPrefs>(key: K, fn: (value: AllPrefs[K] | undefined) => void): () => void;
}

export function createMemoryPrefs(initial: Partial<AllPrefs> = {}): Prefs {
  const store = new Map<string, unknown>(Object.entries(initial));
  const watchers = new Map<string, Set<(value: unknown) => void>>();
  const notify = (key: string, value: unknown) => {
    for (const fn of watchers.get(key) ?? []) fn(value);
  };
  return {
    async get(key) {
      return store.get(key) as AllPrefs[typeof key] | undefined;
    },
    async set(key, value) {
      store.set(key, value);
      notify(key, value);
    },
    async remove(key) {
      store.delete(key);
      notify(key, undefined);
    },
    watch(key, fn) {
      let set = watchers.get(key);
      if (!set) watchers.set(key, (set = new Set()));
      const cast = fn as (value: unknown) => void;
      set.add(cast);
      return () => set.delete(cast);
    },
  };
}
