import assert from "node:assert/strict";
import test from "node:test";
import type { SyncAsset, VardItem } from "@vardum/shared";
import type { DraftItem } from "./vard-editor-state";
import { sourcePreview } from "./vard-preview-url";

test("source previews stay on the app origin and honor pinned versions", () => {
  const item = { key: "brand/a #1.png", versionId: "old-version" } as DraftItem;
  const source = {
    versionId: "new-version",
    mimeType: "video/mp4",
  } as SyncAsset;
  const saved = {
    versionId: "old-version",
    mimeType: "image/png",
    transformation: null,
  } as VardItem;
  assert.deepEqual(sourcePreview(item, "my workspace", source, saved), {
    url: "/w/my%20workspace/__v/old-version/brand/a%20%231.png",
    mimeType: "image/png",
  });
  assert.equal(
    sourcePreview({ ...item, versionId: null }, "test", source, saved).url,
    "/w/test/__v/new-version/brand/a%20%231.png",
  );
  assert.equal(sourcePreview(item, undefined, source, saved).url, null);
  assert.equal(
    sourcePreview({ ...item, versionId: null }, "test", undefined, undefined)
      .url,
    null,
  );
});

test("a pinned transformed output previews and restores its actual original source MIME", () => {
  const item = { key: "logo.png", versionId: "old" } as DraftItem;
  const source = { versionId: "new", mimeType: "image/jpeg" } as SyncAsset;
  const saved = { versionId: "old", mimeType: "image/webp", sourceMimeType: "image/png",
    transformation: { format: "webp" } } as VardItem;
  assert.equal(sourcePreview(item, "demo", source, saved).mimeType, "image/png");
});
