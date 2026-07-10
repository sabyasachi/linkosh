// Injected into an x.com tab (isolated world). See README.md for the
// toString-serialization contract: fully self-contained, args-only inputs.

/** Same-origin API GET with X's web-app auth headers. Returns status 0 with
 *  the error text when the fetch itself fails. */
export async function xApiGet(
  path: string,
  csrf: string,
  bearer: string
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(path, {
      credentials: "include",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${bearer}`,
        "x-csrf-token": csrf,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
      },
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}
