// Guards for the toString-serialization contract (src/injected/README.md):
// every exported function must survive being stringified and re-parsed in a
// third-party page, with no imports, module-scope references or compiler
// helpers. Running under Node's type stripping, fn.toString() exercises the
// stripped source — representationally identical to tsc's emit for erasable
// syntax (the build script additionally greps the real dist output).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as twitter from "../src/injected/twitter.ts";
import * as instagram from "../src/injected/instagram.ts";
import * as youtube from "../src/injected/youtube.ts";
import * as facebook from "../src/injected/facebook.ts";

const MODULES = { twitter, instagram, youtube, facebook };

test("every injected export re-parses standalone and is helper-free", () => {
  for (const [name, mod] of Object.entries(MODULES)) {
    const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
    assert.ok(fns.length > 0, `${name} exports no functions`);
    for (const [fnName, fn] of fns) {
      const source = (fn as (...args: never[]) => unknown).toString();
      // Chrome re-parses exactly this string inside the page — new Function
      // here replicates that on our own repo-controlled source (no untrusted
      // input); the function is only parsed, never invoked.
      assert.doesNotThrow(
        () => new Function(`return (${source})`),
        `${name}.${fnName} does not re-parse standalone`
      );
      assert.doesNotMatch(
        source,
        /__awaiter|__generator|__spreadArray|__assign|\brequire\(/,
        `${name}.${fnName} contains a compiler helper or module reference`
      );
    }
  }
});

test("injected source files contain no imports of any kind", () => {
  for (const name of Object.keys(MODULES)) {
    const source = readFileSync(new URL(`../src/injected/${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*import\b/m, `src/injected/${name}.ts has an import`);
  }
});
