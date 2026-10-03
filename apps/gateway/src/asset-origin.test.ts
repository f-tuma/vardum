import assert from "node:assert/strict";
import test from "node:test";
import { assetOrigin } from "./asset-origin.js";

test("asset return location distinguishes root/search origins from direct links", () => {
  assert.deepEqual(assetOrigin("deep/image.png", ""), { prefix: "" });
  assert.deepEqual(assetOrigin("deep/image.png"), { prefix: "deep/" });
  assert.deepEqual(assetOrigin("image.png"), { prefix: "" });
  assert.deepEqual(assetOrigin("deep/image.png", "", "Image"), {
    prefix: "",
    q: "Image",
  });
  assert.deepEqual(assetOrigin("deep/image.png", "other/", "Image"), {
    prefix: "other/",
    q: "Image",
  });
  assert.deepEqual(assetOrigin("deep/image.png", undefined, "Image"), {
    prefix: "",
    q: "Image",
  });
});
