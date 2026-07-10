// Injected into an instagram.com tab's MAIN world (see the provider for why
// MAIN, not isolated). README.md documents the toString-serialization
// contract: fully self-contained, args-only inputs, no imports.

/** Same-origin API GET with Instagram's web-app headers, aborted after
 *  timeoutMs (Instagram stalls the connection instead of replying when it is
 *  throttling — a hang must become a retryable error, not freeze the sync).
 *  Returns status 0 with the error text when the fetch fails or times out. */
export async function igApiGet(
  path: string,
  csrf: string,
  appId: string,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      credentials: "include",
      signal: controller.signal,
      headers: {
        accept: "*/*",
        "x-ig-app-id": appId,
        "x-csrftoken": csrf,
        "x-requested-with": "XMLHttpRequest",
      },
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
