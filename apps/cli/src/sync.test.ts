import assert from "node:assert/strict";
import test from "node:test";
import { assetKey, pullDecision, pushDecision, type LockItem } from "./sync.js";

const lock: LockItem = {
  path: "assets/icon.png",
  versionId: "v1",
  fingerprint: "v1:",
  checksum: "local-v1",
};

test("sync detects local and remote conflicts before overwriting", () => {
  assert.equal(pullDecision("v1:", "local-v1", lock), "skip");
  assert.equal(pullDecision("v2:", "local-v1", lock), "download");
  assert.equal(pullDecision("v2:", "local-edit", lock), "conflict");
  assert.equal(pushDecision("v1:", "local-edit", lock), "upload");
  assert.equal(pushDecision("v2:", "local-edit", lock), "conflict");
  assert.equal(pullDecision("v1:", "existing", undefined), "conflict");
});

test("bulk push preserves relative paths as safe asset keys", () => {
  assert.equal(assetKey("mobile", "icons/app.png"), "mobile/icons/app.png");
  assert.throws(() => assetKey("mobile", "Icons/App.png"), /valid asset key/);
  assert.throws(() => assetKey("../mobile", "app.png"), /valid asset key/);
});
