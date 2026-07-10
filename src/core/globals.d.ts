// Globals that exist in every runtime this core targets (Node ≥18, dedicated
// workers, extension pages/service worker) but sit outside the bare ES2022
// lib this project pins. Keep this list minimal — anything added here must
// truly be universal across all four runtime contexts.
declare const crypto: {
  randomUUID(): string;
};

/** WHATWG URL — typed to the members core actually uses. */
interface URL {
  href: string;
  hostname: string;
  pathname: string;
}
declare var URL: {
  new (url: string, base?: string): URL;
};
