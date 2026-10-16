import assert from "node:assert/strict";
import test from "node:test";
import { createUseSchema, useCompatibilityIssue } from "./asset-use-model.js";

test("use format and suffix promises fail explicitly when source bytes change type", () => {
  assert.equal(useCompatibilityIssue("mobile/icon", "image/png", "image/svg+xml", { format: "png", w: 32 }), null);
  assert.equal(useCompatibilityIssue("mobile/icon.png", "image/png", "image/webp", { format: "png" }), null);
  assert.match(useCompatibilityIssue("mobile/icon.png", "image/png", "video/mp4", { format: "png" })!, /not a transformable/);
  assert.match(useCompatibilityIssue("og", "image/png", "image/jpeg", null)!, /file type changed/);
  assert.match(useCompatibilityIssue("og.jpg", "image/png", "image/png", null)!, /extension/);
  assert.match(useCompatibilityIssue("icon.ico", "image/png", "image/png", null)!, /extension/);
  assert.equal(createUseSchema.safeParse({ sourceAssetId: "00000000-0000-4000-8000-000000000001", key: "other/icon", displayName: "Icon", transformation: { w: 32 } }).success, false);
});
