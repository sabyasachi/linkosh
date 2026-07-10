// The ProviderEnv port: everything a provider needs from the extension
// environment — cookies, tab acquisition, page-context script execution, the
// self-repair cache and pacing — behind one injectable surface. Providers
// become pure(ish) pagination/self-repair logic, unit-testable against a
// scripted fake env (tests/providers.test.ts) for the first time.
import { ProviderError } from "../../core/errors.ts";

export interface TabTarget {
  /** chrome.tabs.query URL pattern a reusable tab must match, e.g. "https://x.com/*". */
  pattern: string;
  /** URL opened in a background tab when no matching tab exists. */
  createUrl: string;
  /** Human label for timeout errors, e.g. "x.com". */
  label: string;
}

export interface ProviderEnv {
  getCookie(url: string, name: string): Promise<string | null>;
  /** Reuse an open, loaded tab matching target.pattern, else create
   *  target.createUrl in the background; created tabs are closed (in a
   *  finally) when fn settles. Existing tabs are left alone — navigating
   *  them would lose the user's state. */
  withTab<T>(target: TabTarget, fn: (tabId: number) => Promise<T>): Promise<T>;
  /** Serialize fn into the tab and run it with args (see src/injected/ for
   *  the functions and their contract). Rejects when the tab is gone. */
  execInTab<Args extends unknown[], R>(
    tabId: number,
    fn: (...args: Args) => R,
    args: Args,
    opts?: { world?: "MAIN" }
  ): Promise<Awaited<R> | undefined>;
  /** Self-repair state that must outlive a sync (facebook's doc_id). Raw
   *  chrome.storage in the extension — deliberately not Prefs; this is not a
   *  user preference. */
  cache: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  /** Pacing between page fetches — injected so tests run instantly. */
  sleep(ms: number): Promise<void>;
}

function waitForLoad(tabId: number, label: string, timeoutMs = 30000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ProviderError(`${label} took too long to load.`));
    }, timeoutMs);
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    chrome.tabs.onUpdated.addListener(listener);
    // The tab may already have finished loading before the listener attached.
    chrome.tabs.get(tabId).then(
      (t) => t.status === "complete" && done(),
      () => {}
    );
  });
}

export function createChromeProviderEnv(): ProviderEnv {
  return {
    async getCookie(url, name) {
      const cookie = await chrome.cookies.get({ url, name });
      return cookie?.value ?? null;
    },

    async withTab(target, fn) {
      const tabs = await chrome.tabs.query({ url: target.pattern, discarded: false });
      const ready = tabs.find((t) => t.status === "complete");
      if (ready?.id !== undefined) return fn(ready.id);

      const tab = await chrome.tabs.create({ url: target.createUrl, active: false });
      const tabId = tab.id!;
      try {
        await waitForLoad(tabId, target.label);
        return await fn(tabId);
      } finally {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
    },

    async execInTab<Args extends unknown[], R>(
      tabId: number,
      fn: (...args: Args) => R,
      args: Args,
      opts?: { world?: "MAIN" }
    ): Promise<Awaited<R> | undefined> {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        ...(opts?.world ? { world: opts.world } : {}),
        args,
        func: fn,
      } as chrome.scripting.ScriptInjection<unknown[], unknown>);
      return injection?.result as Awaited<R> | undefined;
    },

    cache: {
      async get(key) {
        return (await chrome.storage.local.get(key))[key] as string | undefined;
      },
      async set(key, value) {
        await chrome.storage.local.set({ [key]: value });
      },
      async remove(key) {
        await chrome.storage.local.remove(key);
      },
    },

    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
