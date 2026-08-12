# LinkedIn My Learning saved items

Status: implemented (2026-08-12).

## Outcome

Sync the user's saved LinkedIn Learning content (https://www.linkedin.com/my-items/learning/)
alongside their saved posts. Courses appear in the popup/page list with a real title, author,
duration and viewer count, are searchable in all three modes, and are filterable with `kind:course`.
(The kind is a search facet only — the meta line renders kind just for `"short"`, see
 [format.ts](../../src/core/format.ts) `metaParts` — so a course row shows duration, viewers and
 its "My Learning" collection, not the word "Course".)

This is an extension of the existing `linkedin` provider, **not** a new provider: My Learning is
served by the *same* Voyager endpoint, the same queryId, the same cookies/CSRF auth and the same
response envelope as saved posts — only the `flagshipSearchIntent` differs. A separate provider
would duplicate the queryId self-repair loop and add `ProviderId` churn for no isolation benefit.

## API findings (captured live, 2026-08-12)

Verified against a logged-in session by loading the page and replaying the request:

```
GET https://www.linkedin.com/voyager/api/graphql
  ?variables=(start:N,query:(flagshipSearchIntent:SEARCH_MY_ITEMS_LEARNING))
  &queryId=voyagerSearchDashClusters.a7a0567fa66c52d645b5ff2f960b92aa
```

- **Same queryId as saved posts** (the one already in `QUERY_IDS`, captured 2026-07) — it is one
  GraphQL query parameterized by intent, so a queryId that works for posts works for learning.
  Same headers: `accept: application/vnd.linkedin.normalized+json+2.1`, `csrf-token`,
  `x-restli-protocol-version: 2.0.0`, cookie auth.
- Response is the familiar normalized envelope: `included[]` of
  `com.linkedin.voyager.dash.search.EntityResultViewModel`, 10 per page.
- **Pagination differs from posts**: `metadata.paginationToken` is `null` for this intent; paging
  is pure `start` offset with `paging: {count, start, total}` and `metadata.totalResultCount`.
  A short/empty page is the end (observed: total 13 → page at start:10 returned 3, start:200
  returned 0). Threading `res.cursor` anyway is harmless (stays null).
- Entity fields (unlike posts, these have a real title):

  | field | example | maps to |
  |---|---|---|
  | `entityUrn` | `urn:li:fsd_entityResultViewModel:(urn:li:lyndaCourse:513586,SEARCH_MY_ITEMS_LEARNING,DEFAULT)` | `externalId` |
  | `trackingUrn` | `urn:li:lyndaCourse:513586` | `kind` (URN type) |
  | `title.text` | `Chief Technology Officer Career Guide` | `title` |
  | `primarySubtitle.text` | `Course · 2h 37m` | `duration` (best-effort) |
  | `secondarySubtitle.text` | `By: Drew Falkman · Released Feb 1, 2017` | `posterName`, `publishedAt` (best-effort) |
  | `insightsResolutionResults[].simpleInsight.title.text` | `261,138 viewers` | `stats.views` (verbatim) |
  | `navigationUrl` | `https://www.linkedin.com/learning/chief-technology-officer-career-guide?trk=…` | `url` (strip `trk`) |
  | `image` | vectorImage | `image` via existing `findImageUrl` |

- `summary` was absent on all observed entities; keep the field mapping (posts already read it)
  and let it stay empty.
- `bookmarkedAt` is not exposed anywhere in the payload → null.

## Design decisions

- **Two-list walk in one provider**, copying the Hacker News stories+comments pattern
  ([hackernews.ts](../../src/ext/providers/hackernews.ts)): walk saved posts first (unchanged),
  then the learning list, page numbering restarting per list. The single per-provider watermark
  stays correct because every run walks both lists.
- **The learning walk is always a full walk** — it ignores `unseen` and stops on
  `!res.hasNext` (paging end, see below) or `MAX_PAGES`. The `unseen === 0` incremental stop
  rule assumes newest-saved-first ordering; that holds for posts but is *unverified* for the
  learning list (Learning surfaces often order by activity/progress), and a wrong assumption
  would silently and permanently skip new saves sitting below a fully-known page. Learning
  lists are small (10/page, `paging.total` observed at 13) and `PAGE_DELAY_MS` pacing bounds
  the cost, so walking to the end every run buys correctness for a handful of requests. If
  ordering is later proven newest-first (save a course, resync, watch page 0), the incremental
  rule can be adopted as an optimization.
- **New `PageKind` `"learning"`** tags raw pages so the parser, the capture archive and raw
  re-ingest all dispatch correctly — the same mechanism `stories`/`playlists` use.
- **`kind` facet from the trackingUrn type**, not from `primarySubtitle`: URN types
  (`lyndaCourse` → `course`, and whatever `lyndaVideo`/learning-path URNs turn out to be) are
  locale-independent, whereas subtitle text is `USER_LOCALE`. Normalization rule: take the URN
  type segment, strip a leading `lynda` prefix, split camelCase words, lowercase, join with a
  space (`lyndaCourse` → `course`, `lyndaVideo` → `video`, a hypothetical `learningPath` →
  `learning path`) — so future types produce usable facet values instead of `learningpath`
  mush. Fallback when `trackingUrn` is missing/unparseable: `"learning"` — honest rather than
  fabricating "course" for something unidentified. (Near-dead path: an unknown-but-parseable
  URN type derives its own kind and never hits the fallback.) This makes `kind:course` work as
  an FTS facet for free.
- **`duration`, `publishedAt`, `posterName` are best-effort** parses of localized display strings
  (`2h 37m`, `By: X · Released Feb 1, 2017`). Per the conventions these are display data only, so
  graceful degradation (null / "") on non-English locales is acceptable; comment the assumption.
- **`stats` uses the recognized `views` key with the insight text verbatim**
  (`{views: "261,138 viewers"}`), matching YouTube's `{views: "1.2M views"}` convention:
  `formatStats` ([format.ts](../../src/core/format.ts)) renders recognized keys value-only but
  unknown keys as `key: value` — a `viewers` key would render "viewers: 261,138 viewers".
  Keep the unit word in the value; stripping it would render a naked number.
- **`title` is real here** — unlike posts, courses have their own titles, so the
  poster-never-in-title rule is satisfied naturally: title = course name, posterName = author.
- **`publication` stays empty.** A constant "LinkedIn Learning" would inject identical tokens into
  every learning item's embedded row text (title+publication+summary), clustering them for no
  search benefit; provider + kind already carry that signal.
- **`collection` is `["My Learning"]`.** This preserves the source list as visible metadata and
  enables `collection:"my learning"` filtering. As a provider-default rather than a topical user
  label, it is excluded by the embedding row-text collection stoplist to avoid clustering every
  learning item around the same words.
- **Strip the `trk` query param** from `navigationUrl` — pure click-tracking noise; stripping keeps
  stored URLs canonical. (Posts currently keep theirs; changing that is out of scope.)
- `externalId` keeps the posts rule (`entityUrn || trackingUrn`); the intent tuple inside
  `entityUrn` guarantees no collision with saved-post ids.

## Implementation steps

1. **core/types.ts** — add `"learning"` to the `PageKind` union.
2. **core/db/raw.ts** — add `"learning"` to the `isPageKind` list.
3. **core/parse/linkedin.ts** — add a `parseLearningEntities` walker over the same
   `EntityResultViewModel` entities (URN-derived `kind`, duration/date/author best-effort
   helpers, `trk` strip, reuse `findImageUrl`) and branch `parsePage` on
   `kind === "learning"`; learning pages return `cursor: null` and an honest
   `hasNext = paging.start + paging.count < paging.total` (read from
   `data.data.searchDashClustersByAll.paging`; absent/malformed paging degrades to
   `items.length > 0`). Comment the contrast with the posts branch's paginationToken. This
   `hasNext` is the learning walk's primary stop signal, so it is load-bearing, not cosmetic.
4. **ext/providers/linkedin.ts** — give `buildUrl` an intent parameter; after the posts walk,
   walk `SEARCH_MY_ITEMS_LEARNING` with the queryId the posts phase already validated, same
   `PAGE_DELAY_MS` pacing and `MAX_PAGES` cap, pages tagged `kind: "learning"`. The learning
   loop breaks on `!res.hasNext` only (full walk — deliberately ignores `res.unseen`, see
   Design decisions; the pattern to copy is [substack.ts](../../src/ext/providers/substack.ts)'s
   loop minus its `unseen` clause). Document the endpoint findings above (with the capture
   date) and the ordering rationale in the provider header comment.
5. **pages/popup/app.tsx** — `PAGE_KIND_LABELS.learning = "learning"` (sync progress copy).
6. **README** — extend the LinkedIn entry + Caveats (queryId capture instructions already cover
   this endpoint since the queryId is shared).

No schema, ingest, background, or options changes: `raw_data.kind` is TEXT, ingest re-dispatches
through the parse registry, and the UI derives everything from stored rows.

## Tests

- **Fixture**: one-page learning payload in `tests/fixtures/` — scrubbed capture
  (capture mode + `capture-fixtures.ts`) or minimal hand-built page matching the observed shape,
  plus a short final page (3 items) and an empty page.
- **Parser** (extend the linkedin parser test): title/kind/duration/publishedAt/posterName/stats/
  url-stripping mappings (`stats.views` key, value verbatim); `hasNext` true on a full page with
  `paging` saying more remain, **false on the final short page** (start+count ≥ total), degrades
  to `items.length > 0` when paging is absent; unknown-but-parseable URN type derives its own
  kind (`lyndaVideo` → `video`), missing/malformed URN falls back to `"learning"`; malformed
  subtitle strings degrade to null/"" without throwing.
- **Provider** (extend the linkedin scenario in `tests/providers.test.ts`, scripted `ProviderEnv`):
  the run walks posts then learning; **a fully-known learning page does *not* stop the learning
  walk** (full-walk contract — paging continues until `hasNext` is false), while the posts walk
  keeps its `unseen === 0` stop; queryId fallthrough still happens once (posts phase) and
  learning reuses the survivor; learning pages arrive kind-tagged.
- **Raw/ingest**: `isPageKind("learning")` accepted; a captured learning page re-ingests through
  the same parser branch.

## Live smoke checklist (after implementation)

Per CLAUDE.md: `npm run build` → reload unpacked → incremental linkedin sync (posts *and*
learning land; second sync stops immediately on posts, re-walks learning to its paging end
with 0 inserted) → `kind:course` search + one
semantic search hitting a course → "≈ more like this" on a course → capture-mode sync →
`__sql("SELECT kind, status FROM raw_data WHERE provider='linkedin'")` shows `learning` pages →
Ingest raw → Clear raw.

## Open questions

- **Non-course learning content**: the probe account's 13 items are all `lyndaCourse`. Saved
  videos, learning paths or audiobooks presumably surface with different URN types; the URN-derived
  `kind` plus capture mode's failed-page archiving means unknowns degrade gracefully and produce
  ready-made fixtures rather than breaking the sync.
- **List ordering**: unverified, but no longer load-bearing — the full-walk design makes
  correctness independent of ordering. If someone later proves the list is newest-saved-first
  (save a course, resync, watch page 0), the `unseen === 0` incremental rule can be adopted as
  a request-saving optimization for large learning libraries.
- **Default filter scope**: the page exposes "Just show me" primary filters; the unfiltered
  request is what the saved-items page itself issues, so the default list is what the user sees —
  filter values were not enumerated.
