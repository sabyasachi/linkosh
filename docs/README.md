# docs

Engineering notes and design records for Linkosh. Start with
[CLAUDE.md](../CLAUDE.md) for the day-to-day contract; these go deeper on
specific topics.

## Topics

- [typescript-rewrite.md](typescript-rewrite.md) — why the toolchain is
  tsc-only (no bundler), the linchpin compiler flags, vendored Preact, the
  seven-project layout, and the C4 architecture model.
- [sync-and-refresh.md](sync-and-refresh.md) — the onPage inversion, the
  incremental stop rule, the `SyncReport` union, and exactly what a Refresh
  does after a partial sync (the backfill/resume semantics).
- [instagram-provider.md](instagram-provider.md) — HTTP 572 (injection world
  vs volume throttle), the retry/backoff, and the backfill resume checkpoint.

## Plans

`plans/` holds the original feature/design proposals
([semantic-search](plans/semantic-search.md),
[auto-tagging](plans/auto-tagging.md),
[testability](plans/testability.md), [AI-features](plans/AI-features.md)).
