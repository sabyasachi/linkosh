// Clean v1 schema — the TypeScript rewrite starts fresh (the pre-rewrite
// migration chain was retired with its data; the OPFS filename changed to
// linkosh-v1.sqlite so an old-schema file can never collide with these
// CREATE IF NOT EXISTS statements).
import type { SqlDatabase } from "./port.ts";

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS saved_items (
    id            INTEGER PRIMARY KEY,
    provider      TEXT NOT NULL,
    account       TEXT NOT NULL,             -- the user's identity on the service
    external_id   TEXT NOT NULL,             -- the item's id on the service
    url           TEXT NOT NULL,
    title         TEXT,                      -- '' for post-like items (author never goes here)
    publication   TEXT,
    summary       TEXT,
    image         TEXT,
    kind          TEXT NOT NULL DEFAULT '',  -- provider facet: tweet|short|story|comment|…
    duration      INTEGER,                   -- seconds, for playable media
    collection    TEXT NOT NULL DEFAULT '[]',-- JSON array of collection/playlist names
    poster_name   TEXT NOT NULL DEFAULT '',  -- author/channel display name, not the saving user
    poster_handle TEXT NOT NULL DEFAULT '',  -- author/channel handle or username when exposed
    poster_bio    TEXT NOT NULL DEFAULT '',  -- author headline/bio when the provider exposes it
    stats         TEXT NOT NULL DEFAULT '{}',-- provider metrics as a JSON object (views, age, …)
    bookmarked_at INTEGER,                   -- when the user saved it (epoch ms), rarely exposed
    published_at  INTEGER,                   -- when the content appeared (epoch ms), often estimated
    created_at    INTEGER NOT NULL,          -- row insert time — the incremental-sync watermark
    embedding     BLOB,                      -- raw little-endian Float32; dim = byteLength / 4
    embedding_model TEXT,                    -- e.g. 'local:minilm-l6-v2-q8+r2' (+rN = rowText recipe version)
    UNIQUE (provider, account, external_id)
  );

  -- Raw response archive, written only when capture mode is on (a dev
  -- setting): each row is one page exactly as the service returned it, so
  -- the parse/ingest pipeline can be re-run offline (tests, tools/) without
  -- re-fetching from the service. Normal syncs never touch this table.
  CREATE TABLE IF NOT EXISTS raw_data (
    id           INTEGER PRIMARY KEY,
    provider     TEXT NOT NULL,
    account      TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'items',   -- parse dialect: items|stories|comments|collections|playlists|connection
    url          TEXT NOT NULL DEFAULT '',
    page         INTEGER NOT NULL DEFAULT 0,      -- 0-based position within its sync run
    context      TEXT,                            -- JSON: parse inputs not recoverable from the body
                                                  -- (e.g. Instagram's collection-id → name map)
    body         TEXT NOT NULL,                   -- raw response text, verbatim
    external_ids TEXT NOT NULL DEFAULT '[]',      -- JSON array of item ids parsed at crawl time;
                                                  -- feeds the incremental stop rule without re-parsing
    fetched_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending', -- pending | ingested | failed
    ingested_at  INTEGER,
    error        TEXT                             -- parse failure message when status = 'failed'
  );
  CREATE INDEX IF NOT EXISTS raw_data_status ON raw_data (status, provider, id);
`;

// collection, kind and poster identity are indexed so the search bar supports
// FTS5 column filters like collection:"watch later", kind:short,
// poster_name:"jane doe" or poster_handle:jane alongside plain text.
// poster_bio is kept as structured display data, but deliberately not
// indexed: searching should find saved content, not everyone with a similar
// job headline.
export const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS saved_items_fts USING fts5(
    title, publication, summary, collection, kind, poster_name, poster_handle,
    content='saved_items', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS saved_items_ai AFTER INSERT ON saved_items BEGIN
    INSERT INTO saved_items_fts(rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES (new.id, new.title, new.publication, new.summary, new.collection, new.kind, new.poster_name, new.poster_handle);
  END;

  CREATE TRIGGER IF NOT EXISTS saved_items_ad AFTER DELETE ON saved_items BEGIN
    INSERT INTO saved_items_fts(saved_items_fts, rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES ('delete', old.id, old.title, old.publication, old.summary, old.collection, old.kind, old.poster_name, old.poster_handle);
  END;

  CREATE TRIGGER IF NOT EXISTS saved_items_au AFTER UPDATE ON saved_items BEGIN
    INSERT INTO saved_items_fts(saved_items_fts, rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES ('delete', old.id, old.title, old.publication, old.summary, old.collection, old.kind, old.poster_name, old.poster_handle);
    INSERT INTO saved_items_fts(rowid, title, publication, summary, collection, kind, poster_name, poster_handle)
    VALUES (new.id, new.title, new.publication, new.summary, new.collection, new.kind, new.poster_name, new.poster_handle);
  END;
`;

/** Apply the current schema to a freshly opened DB. */
export function initSchema(db: SqlDatabase): void {
  db.exec(SCHEMA);
  db.exec(FTS_SCHEMA);
}
