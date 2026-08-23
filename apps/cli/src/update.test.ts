import assert from "node:assert/strict";
import test from "node:test";
import { isNewer } from "./update.js";

test("outdated warning only fires for genuinely newer versions", () => {
  assert.equal(isNewer("0.5.0", "0.4.0"), true);
  assert.equal(isNewer("0.4.1", "0.4.0"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.4.0", "0.4.0"), false);
  assert.equal(isNewer("0.4.0", "0.5.0"), false);
  assert.equal(isNewer("0.4.0", "0.4.1-beta.1"), false);
});
