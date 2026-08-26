import assert from "node:assert/strict";
import test from "node:test";
import { maximumUploadSize } from "./upload-limits.js";

test("upload ceilings are per kind: image, video, and everything else", () => {
  assert.equal(maximumUploadSize("image/png"), 25 * 1024 * 1024);
  assert.equal(maximumUploadSize("video/mp4"), 200 * 1024 * 1024);
  assert.equal(maximumUploadSize("application/pdf"), 100 * 1024 * 1024);
});
