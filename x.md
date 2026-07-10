X bookmarks support is in. Reload the extension, make sure you're signed in to x.com, pick "X (Twitter)" in the dropdown (it's also included in "All services" syncs), and hit Refresh.

How it works — new [twitter.js](providers/twitter.js) provider, registered in [background.js](background.js) with `https://x.com/*` added to [manifest.json](manifest.json):

- It calls the GraphQL `Bookmarks` endpoint behind x.com/i/bookmarks, authenticating with your existing session: the `ct0` CSRF cookie plus the public bearer token that X's own web app ships (it identifies the website, not you). If `auth_token`/`ct0` are missing you get the usual "Not logged in" error.
- Like the Instagram provider, requests run inside an x.com tab via `chrome.scripting` (an existing tab if open, otherwise a hidden one that's closed afterwards), since X rejects API calls whose browser-set headers don't look like they came from x.com.
- Bookmarks are newest-first, so the standard incremental rule applies — a refresh stops at the first page with nothing new, and pages are persisted as they arrive.
- Items get: first line of the tweet as title (t.co links expanded to their real targets, trailing media links stripped), `@handle · name` as subtitle, full text as summary, media thumbnail or author avatar as image, `kind` of `tweet`/`photo`/`video`/`gif`, video duration, and the post's publish time as `saved_at` (X doesn't expose when you bookmarked). Long-form "note tweets" use their full text, and tweets wrapped in `TweetWithVisibilityResults` are unwrapped.

Two drift-hardening measures, because this API is undocumented and moves:

- **queryId rotation** — handled like LinkedIn: a candidates list is tried newest-first, and stale ids (HTTP 404) fall through to the next. The ids I shipped are from my training data and may already be rotated; if the sync reports "X rejected all known API versions", grab the current one from DevTools on the bookmarks page (look for `graphql/<queryId>/Bookmarks`) and add it to `QUERY_IDS`.
- **Feature-flag drift** — X's GraphQL demands an exact map of client feature flags. The provider ships a baseline and self-repairs: when the server answers "features cannot be null: X" or "unknown features: Y" it adds/removes those flags and retries (up to 4 attempts per page).

One known risk I couldn't guard against: X has been rolling out an obfuscated `x-client-transaction-id` header requirement on some GraphQL endpoints. If they enforce it on Bookmarks, the sync will fail with a clear HTTP error rather than silently — worth knowing if it ever stops working. The README's provider, caveats, and login sections are updated accordingly.