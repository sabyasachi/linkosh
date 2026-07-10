# Injected functions — the toString-serialization contract

Every function exported from this directory is passed as `func:` to
`chrome.scripting.executeScript`. Chrome serializes the function **via
`toString()` and re-parses it inside a third-party page** (instagram.com,
x.com, youtube.com, facebook.com). The function's compiled source is the
program — which imposes rules stricter than anywhere else in this codebase:

1. **No imports of any kind** — not even `import type`. The function body must
   not reference anything from module scope (imports, module constants,
   helper functions); everything it needs arrives via `args:` parameters.
   Types are declared locally inside each file.
2. **No TypeScript syntax that doesn't erase in place** (enforced repo-wide by
   `erasableSyntaxOnly`) and **no downlevel helpers** (guaranteed by
   `target: ES2022`): the emitted function must be byte-equivalent modern JS.
3. Page-context globals only: these run with the page's DOM (and in YouTube's
   case the MAIN world for `window.ytcfg`), never with chrome.* APIs.

Guards: `tests/injected-guard.test.ts` asserts each export re-parses
standalone and that sources contain no `import`/`require`/helper markers;
`scripts/build.ts` greps the emitted `dist/src/injected/*.js` for downlevel
helper references as a belt-and-braces check.
