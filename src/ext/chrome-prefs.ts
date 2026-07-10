// The chrome.storage.local implementation of the typed Prefs store (see
// core/prefs.ts for the schema and the in-memory twin).
import type { AllPrefs, Prefs } from "../core/prefs.ts";

export function createChromePrefs(): Prefs {
  return {
    async get(key) {
      return (await chrome.storage.local.get(key))[key] as AllPrefs[typeof key] | undefined;
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
    watch(key, fn) {
      const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "local" && key in changes) {
          fn(changes[key]!.newValue as AllPrefs[typeof key] | undefined);
        }
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
  };
}
