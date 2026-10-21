import assert from "node:assert/strict";
import test from "node:test";
import { createUseSchema, useCompatibilityIssue, useOutputMime } from "./asset-use-model.js";

test("use format and suffix promises fail explicitly when source bytes change type", () => {
  assert.equal(useCompatibilityIssue("mobile/icon", "image/png", "image/svg+xml", { format: "png", w: 32 }), null);
  assert.equal(useCompatibilityIssue("mobile/icon.png", "image/png", "image/webp", { format: "png" }), null);
  assert.match(useCompatibilityIssue("mobile/icon.png", "image/png", "video/mp4", { format: "png" })!, /not a transformable/);
  assert.match(useCompatibilityIssue("og", "image/png", "image/jpeg", null)!, /file type changed/);
  assert.match(useCompatibilityIssue("og.jpg", "image/png", "image/png", null)!, /extension/);
  assert.match(useCompatibilityIssue("icon.ico", "image/png", "image/png", null)!, /extension/);
  assert.equal(createUseSchema.safeParse({ sourceAssetId: "00000000-0000-4000-8000-000000000001", key: "other/icon", displayName: "Icon", transformation: { w: 32 } }).success, false);
});

test("known source dimensions reject impossible format-only outputs before redirect", () => {
  assert.match(useCompatibilityIssue("hero", "image/webp", "image/png", { format: "webp" }, { width: 5000, height: 5000 })!, /pixel limit/);
  assert.equal(useCompatibilityIssue("hero", "image/webp", "image/png", { format: "webp", w: 320 }, { width: 5000, height: 5000 }), null);
});

test("auto-oriented metadata does not falsely reject a feasible rotated source", () => {
  assert.equal(useCompatibilityIssue("portrait", "image/png", "image/jpeg", { format: "png", w: 4096 }, { width: 100, height: 10000 }), null);
});


test("SVG uses preserve SVG MIME and suffixes and fail when a source becomes raster", () => {
  assert.equal(useOutputMime("image/svg+xml", { format: "svg" }), "image/svg+xml");
  assert.equal(useCompatibilityIssue("web/mark.svg", "image/svg+xml", "image/svg+xml", { format: "svg" }), null);
  assert.equal(useCompatibilityIssue("web/mark-neutral", "image/svg+xml", "image/svg+xml", { format: "svg", layer: "neutral-arm" }), null);
  assert.match(useCompatibilityIssue("web/mark", "image/svg+xml", "image/png", { format: "svg" })!, /SVG source/);
  assert.match(useCompatibilityIssue("web/mark.png", "image/png", "image/png", { format: "png", layer: "neutral-arm" })!, /SVG source/);
  assert.match(useCompatibilityIssue("web/mark.png", "image/svg+xml", "image/svg+xml", { format: "svg" })!, /extension/);
});
