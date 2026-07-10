# Vendored Preact 10.29.7

Source: the official `preact` npm package (10.29.7), vendored like the other
libraries in `vendor/` so the extension keeps zero npm runtime dependencies
and every shipped byte is auditable. Compiled to the page via tsc's classic
JSX transform (`jsxFactory: "h"`) — components import `h` explicitly from
`./preact.js`, so no bundler or bare-specifier resolution is needed.

| File | Origin in the npm package | Local edit |
|---|---|---|
| preact.js | dist/preact.module.js | none |
| hooks.js | hooks/dist/hooks.module.js | `from"preact"` → `from"./preact.js"` |
| preact.d.ts | src/index.d.ts | `'./jsx'`/`'./dom'` → `'./jsx.js'`/`'./dom.js'` |
| jsx.d.ts | src/jsx.d.ts | `'preact'` → `'./preact.js'` |
| dom.d.ts | src/dom.d.ts | `'preact'` → `'./preact.js'` |
| hooks.d.ts | hooks/src/index.d.ts | `'preact'` → `'./preact.js'` |

The edits only rewrite import specifiers (the npm builds self-reference the
bare `preact` specifier, which nothing resolves here); no code changes.
To upgrade: repeat the table against a newer `npm pack preact` tarball.
