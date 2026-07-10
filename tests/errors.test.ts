// Also the P0 toolchain probe: this file running at all proves Node's type
// stripping executes .ts sources with .ts-extension imports directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, serializeError, reviveError } from "../src/core/errors.ts";

test("ProviderError survives an RPC round-trip with needsLogin intact", () => {
  const wire = serializeError(new ProviderError("Not logged in to LinkedIn", { needsLogin: true }));
  assert.deepEqual(wire, {
    name: "ProviderError",
    message: "Not logged in to LinkedIn",
    needsLogin: true,
  });

  const revived = reviveError(wire);
  assert.ok(revived instanceof ProviderError);
  assert.equal(revived.needsLogin, true);
  assert.equal(revived.message, "Not logged in to LinkedIn");
});

test("plain errors keep their name but gain no needsLogin", () => {
  const revived = reviveError(serializeError(new TypeError("boom")));
  assert.equal(revived.name, "TypeError");
  assert.equal(revived.message, "boom");
  assert.ok(!(revived instanceof ProviderError));
});

test("non-Error throwables serialize to a readable message", () => {
  assert.deepEqual(serializeError("just a string"), { name: "Error", message: "just a string" });
});
