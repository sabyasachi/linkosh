# Schema Notes

This document describes what each persisted column means and how each provider
should populate it. It is based on the current parser code and a raw archive
audit of a predecessor database export.

## Raw Data Audit

`raw_data` coverage inspected:

| Provider | Raw kinds | Pages | Relevant fields observed |
|---|---:|---:|---|
| Facebook | `connection` | 10 | `Save.id`, `savable_title`, `savable_description`, `savable_permalink`, `savable_image`, `savable_attributes`, `container_savable.savable_actors`, `story.owner_group`, `containing_lists`, `playable_duration`, `page_info`; no save/publish timestamp field found. |
| Hacker News | `stories`, `comments` | 5 | HTML has `athing` rows, `titleline`, `sitestr`, `hnuser`, `score`, `commtext`, and `span.age title`; no upvote timestamp field found. |
| Instagram | `collections`, `items` | 9 | Media has `pk`, `code`, `product_type`, `media_type`, `caption.text`, `user.username`, `user.full_name`, `taken_at`, `saved_collection_ids`, `video_duration`, `image_versions2`, `carousel_media`; collection pages have `collection_id` and `collection_name`. |
| LinkedIn | `items` | 10 | Entity results have `entityUrn`, `trackingUrn`, `title`, `primarySubtitle`, `summary`, `navigationUrl`, `image`; no save/publish timestamp field found. |
| Substack | `items` | 1 | Items have `saved_at`; posts have `post_date`, `title`, `subtitle`, `canonical_url`, `publishedBylines`, `type`, `podcast_duration`, `cover_image`; notes have `comment.date`, `body`, `name`, `handle`, `photo_url`. |
| X | `items` | 5 | Tweets have `rest_id`, `legacy.created_at`, `legacy.full_text`, URL expansions, user `name`/`screen_name`, media URLs, video duration, bottom cursors; no bookmark timestamp field found. |
| YouTube | `playlists`, `items` | 57 | Playlist videos have `videoId`, `title`, `shortBylineText`, `videoInfo`, `lengthSeconds`, `thumbnail`, `thumbnailOverlays`; `publishedTimeText` and `dateText` were absent from `playlistVideoRenderer`. |

## `saved_items`

Rows are keyed by `UNIQUE(provider, account, external_id)`. Empty text fields
should be stored as `""`, absent numeric timestamps as `NULL`, and absent JSON
objects/arrays as `{}` or `[]` once encoded by `db/ops.js`.

| Column | Type | General contract |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY` | Local row id. Never provider-derived. |
| `provider` | `TEXT NOT NULL` | Stable provider id: `facebook`, `hackernews`, `instagram`, `linkedin`, `substack`, `twitter`, `youtube`. |
| `account` | `TEXT NOT NULL` | Logged-in service identity used during sync. Use `"unknown"` only when the provider cannot read it. |
| `external_id` | `TEXT NOT NULL` | Provider item id stable across syncs. Must identify one saved content row. |
| `url` | `TEXT NOT NULL` | Best user-openable URL for the item. |
| `title` | `TEXT` | Content title only. Do not put the author/poster here. Posts/tweets/comments with no real title use `""`. |
| `publication` | `TEXT` | Secondary non-author context, such as site, publication, or containing group/story. |
| `summary` | `TEXT` | Main body/description/caption text, or compact content stats only when no better field exists. |
| `image` | `TEXT` | Thumbnail/avatar/cover image URL, preferring a small thumbnail around 100px wide where possible. |
| `bookmarked_at` | `INTEGER` | Epoch ms for actual save/bookmark time only. Leave `NULL` if the provider does not expose it. |
| `published_at` | `INTEGER` | Epoch ms for content publish time, or a documented estimate when exact publish time is unavailable. |
| `created_at` | `INTEGER NOT NULL` | Local ingestion time assigned by `ops.upsert`. Used for fallback ordering and partial-sync correctness. |
| `kind` | `TEXT NOT NULL DEFAULT ''` | Provider-normalized item type such as `story`, `comment`, `reel`, `tweet`, `video`, `short`, `post`, `note`. |
| `duration` | `INTEGER` | Duration in seconds for video/audio items when exposed, otherwise `NULL`. |
| `collection` | `TEXT NOT NULL DEFAULT ''` | JSON array text of user collection/list names. `ops.upsert` encodes arrays and merges names on conflict. |
| `embedding` | `BLOB` | Raw little-endian `Float32Array` vector. Never send through `chrome.runtime`. |
| `embedding_model` | `TEXT` | Model id for `embedding`, e.g. `local:minilm-l6-v2-q8`. |
| `poster_name` | `TEXT NOT NULL DEFAULT ''` | Author/channel display name for the content, not the saving user. |
| `poster_handle` | `TEXT NOT NULL DEFAULT ''` | Author/channel handle or username when exposed, stored without decorative parentheses. |
| `poster_bio` | `TEXT NOT NULL DEFAULT ''` | Author headline/bio when exposed. Display-only, not FTS-indexed. |
| `stats` | `TEXT NOT NULL DEFAULT '{}'` | JSON object of provider metrics that are not body text, e.g. YouTube views/relative age. |

FTS indexes `title`, `publication`, `summary`, `collection`, `kind`,
`poster_name`, and `poster_handle`. `poster_bio`, `stats`, timestamps, and
embeddings are deliberately not indexed.

List/search ordering is:

1. `bookmarked_at DESC`
2. `published_at DESC`
3. `created_at DESC`
4. `id ASC`

## Provider Mapping

### Facebook

Raw source: Comet saved-items Relay connection.

| Column | Value |
|---|---|
| `account` | Numeric `c_user` cookie value. Facebook raw data does not expose a handle here. |
| `external_id` | `Save.id` from the Relay node. |
| `url` | `savable.savable_permalink`, else `savable.url`, resolved against `https://www.facebook.com`. |
| `title` | `""`; saved posts/videos do not expose a clean title/body split reliably. |
| `publication` | `container_savable.story.owner_group.name/full_name`, else `savable.story.owner_group.name/full_name`; only populated for group posts. Do not use `savable_attributes`, which mixes type/media labels and author/page names. |
| `summary` | `savable.savable_title.text`, else `savable.savable_description.text`. |
| `image` | `savable.savable_image.uri`, else `story_pointer.savable_image.uri`. |
| `bookmarked_at` | `NULL`; not present in inspected raw data. |
| `published_at` | `NULL`; no reliable content timestamp found in inspected raw data. |
| `kind` | Lowercased `savable.__typename`; normalize `storypointer` to `post`. |
| `duration` | `savable.playable_duration` rounded to seconds. |
| `collection` | `containing_lists.nodes[].name` as an array. |
| `poster_name` | First actor name from `container_savable.savable_actors`, else `savable.savable_actors`, else `story.actors`. |
| `poster_handle` | Parsed from the actor Facebook URL when it is a clean profile/page slug; `""` for `profile.php`, group URLs, redirects, or absent actor URLs. |
| `poster_bio` | `""`. |
| `stats` | `{}`. |

### Hacker News

Raw source: private `/upvoted` HTML pages.

| Column | Value |
|---|---|
| `account` | HN username from the `user` cookie. |
| `external_id` | HN row id from `<tr class="athing" id="...">`. |
| `url` | `https://news.ycombinator.com/item?id=<id>` for both stories and comments, so clicks open the HN discussion rather than outbound story links. |
| `title` | Story title from `titleline`; `""` for comments. |
| `publication` | Story domain from `sitestr`; for comments, `on: <story title>`. |
| `summary` | Stories: `"<points> points · <comments> comments"`; comments: flattened `commtext`. |
| `image` | `""`; HN list pages expose no thumbnails. |
| `bookmarked_at` | `NULL`; upvote time is not exposed. |
| `published_at` | `span.age title` parsed as epoch/ISO time. Closest available proxy for ordering. |
| `kind` | `story` or `comment`. |
| `duration` | `NULL`. |
| `collection` | `["upvoted"]`. |
| `poster_name` | `""`; HN exposes usernames, not display names. |
| `poster_handle` | `hnuser`. |
| `poster_bio` | `""`. |
| `stats` | `{}`; story points/comments currently live in `summary` so they stay searchable. |

### Instagram

Raw source: saved feed plus collections list.

| Column | Value |
|---|---|
| `account` | Current user `username`; use `"unknown"` if the account endpoint fails. |
| `external_id` | `media.pk`. |
| `url` | `https://www.instagram.com/reel/<code>/` for reels, else `/p/<code>/`. |
| `title` | `""`; posts/reels do not have a distinct title in this feed. |
| `publication` | `""`. |
| `summary` | Trimmed `caption.text`. |
| `image` | Closest ~100px candidate from `image_versions2`; carousel uses first slide image. |
| `bookmarked_at` | `NULL`; save time is not exposed. |
| `published_at` | `taken_at * 1000`. Closest available proxy for ordering. |
| `kind` | `reel` for `product_type === "clips"`, else `carousel`/`video`/`post` from `media_type`. |
| `duration` | Rounded `video_duration`, or `0`/`NULL` when absent. |
| `collection` | `saved_collection_ids` resolved through captured `collections` context into names. |
| `poster_name` | `user.full_name`. |
| `poster_handle` | `user.username`. |
| `poster_bio` | `""`. |
| `stats` | `{}`. |

### LinkedIn

Raw source: Voyager saved-post search result entities.

| Column | Value |
|---|---|
| `account` | Public identifier from `/voyager/api/me`, else `"unknown"`. |
| `external_id` | `entity.entityUrn`, else `trackingUrn`. Avoid unstable random fallback except as last resort. |
| `url` | `navigationUrl`. |
| `title` | `""`; `entity.title.text` is the poster name, not a post title. |
| `publication` | `""`; author headline goes in `poster_bio`. |
| `summary` | `entity.summary.text`. |
| `image` | Best vector image URL from `entity.image`. |
| `bookmarked_at` | `NULL`; save time is not present in inspected raw data. |
| `published_at` | `NULL`; no reliable content timestamp found in inspected raw data. |
| `kind` | `""` until LinkedIn exposes a useful type. |
| `duration` | `NULL`. |
| `collection` | `[]`; LinkedIn saved posts are not collection-tagged in this endpoint. |
| `poster_name` | `entity.title.text`. |
| `poster_handle` | `""`; no stable public handle is exposed in this payload. |
| `poster_bio` | `entity.primarySubtitle.text`. |
| `stats` | `{}`. |

### Substack

Raw source: `/api/v1/reader/saved?filter=all`.

| Column | Value |
|---|---|
| `account` | Current profile `handle`, else profile `name`, else `"unknown"`. |
| `external_id` | `post:<post.id>` or `note:<comment.id>`. |
| `url` | `post.canonical_url` for posts; `https://substack.com/@<handle>/note/c-<id>` for notes. |
| `title` | `post.title` or `"Untitled post"`; `""` for notes. |
| `publication` | Publication name when distinct from byline; `""` for notes. |
| `summary` | `post.subtitle`, else `post.truncated_body_text`; note body for notes. |
| `image` | `post.cover_image` or note `photo_url`. |
| `bookmarked_at` | `item.saved_at`/`item.savedAt` when present. This is the real save time. |
| `published_at` | `post.post_date` or `comment.date`. |
| `kind` | `post.type` for posts; `note` for notes. |
| `duration` | Rounded `post.podcast_duration` for podcasts/audio, otherwise `NULL`/`0`. |
| `collection` | `[]`; saved feed is not collection-tagged. |
| `poster_name` | First `publishedBylines[].name` for posts; `comment.name` for notes. |
| `poster_handle` | `comment.handle`/`comment.author.handle` for notes; `""` for posts when absent. |
| `poster_bio` | `""`. |
| `stats` | `{}`. |

### X / Twitter

Raw source: GraphQL `Bookmarks` timeline.

| Column | Value |
|---|---|
| `account` | `screen_name` from account settings, else `"unknown"`. |
| `external_id` | Tweet `rest_id`. |
| `url` | `https://x.com/<handle>/status/<rest_id>`. |
| `title` | `""`; tweets have no distinct title. |
| `publication` | `""`. |
| `summary` | Tweet text with `t.co` URLs expanded and trailing media links removed. |
| `image` | First media `media_url_https?name=small`; fallback to author avatar. |
| `bookmarked_at` | `NULL`; bookmark time is not present in inspected raw data. |
| `published_at` | `tweet.legacy.created_at`. Closest available proxy for ordering. |
| `kind` | `video`, `gif`, `photo`, or `tweet` from media entities. |
| `duration` | `video_info.duration_millis / 1000` rounded for videos. |
| `collection` | `[]`; bookmarks are not collection-tagged. |
| `poster_name` | Author `name`. |
| `poster_handle` | Author `screen_name`. |
| `poster_bio` | `""`. |
| `stats` | `{}`. |

### YouTube

Raw source: InnerTube playlists and playlist videos.

| Column | Value |
|---|---|
| `account` | Active account handle from `account/account_menu`, stripped of leading `@`; fallback account name/`unknown`. |
| `external_id` | `playlistVideoRenderer.videoId`. Same video in multiple playlists remains one row. |
| `url` | `https://www.youtube.com/watch?v=<videoId>` or `/shorts/<videoId>` for Shorts. |
| `title` | `title` text from the renderer. |
| `publication` | `""`. |
| `summary` | `""`; playlist pages do not expose descriptions. |
| `image` | Closest ~100px thumbnail from `thumbnail.thumbnails`. |
| `bookmarked_at` | `NULL`; playlist item save/add time is not exposed in inspected raw data. |
| `published_at` | Approximate publish date derived from `videoInfo` relative age and `raw_data.fetched_at`/live fetch time. Exact publish date was not present in `playlistVideoRenderer`. |
| `kind` | `short` when a `SHORTS` time-status overlay or `/shorts/` URL is present, else `video`. |
| `duration` | `lengthSeconds` parsed as seconds. |
| `collection` | Playlist name from raw page context, merged across playlists. |
| `poster_name` | Channel name from `shortBylineText`. |
| `poster_handle` | `""`; playlist video renderers inspected here did not expose a stable handle. |
| `poster_bio` | `""`. |
| `stats` | `{ "views": "...", "age": "..." }` from `videoInfo`; if unsplittable, `{ "info": "..." }`. Do not store the publish estimate here. |

## `raw_data`

`raw_data` is a verbatim archive used for capture mode and offline reingest.

| Column | Contract |
|---|---|
| `id` | Local raw page id. |
| `provider` | Provider id matching `saved_items.provider`. |
| `account` | Account used for the fetch. |
| `kind` | Parser dialect for the body, e.g. `items`, `stories`, `comments`, `collections`, `playlists`, `connection`. |
| `url` | Endpoint/page/debug URL for the fetch. |
| `page` | Zero-based page number inside that sync run/list. |
| `context` | JSON parse context not recoverable from the body, such as Instagram collection maps or YouTube playlist identity. |
| `body` | Raw response/page text, verbatim. |
| `external_ids` | JSON array of parsed item ids at crawl time, used for incremental capture stop rules. |
| `fetched_at` | Epoch ms when the raw page was fetched. Used by YouTube to estimate `published_at` from relative age text. |
| `status` | `pending`, `ingested`, or `failed`. |
| `ingested_at` | Epoch ms for successful raw replay. |
| `error` | Parser/ingest error for failed rows. |
