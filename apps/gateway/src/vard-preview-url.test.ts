import assert from "node:assert/strict";
import test from "node:test";
import type { SyncAsset, VardItem, VardEditorItemV2 } from "@vardum/shared";
import type { DraftItem } from "./vard-editor-state";
import { linkedPreview, sourcePreview, transformedPreviewUrl } from "./vard-preview-url";

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

test("linked preview uses captured canonical output and has no source-original fallback", () => {
  const item = { binding: { kind: "use", assetUseId: "use" }, resolved: {
    versionId: "ready", fingerprint: "recipe", downloadUrl: "/w/demo/__v/ready/source.svg?pad=20&sig=signed",
    mimeType: "image/png", availabilityError: null,
  } } as VardEditorItemV2;
  assert.deepEqual(linkedPreview(item), { url: item.resolved.downloadUrl, mimeType: "image/png" });
  assert.equal(linkedPreview({ ...item, resolved: { ...item.resolved, availabilityError: "Incompatible use" } }).url, null);
  assert.equal(linkedPreview({ ...item, resolved: { ...item.resolved, versionId: null } }).url, null);
  assert.equal(linkedPreview({ ...item, resolved: { ...item.resolved, downloadUrl: null } }).url, null);
  assert.equal(linkedPreview(undefined).url, null);
});

test("a pinned transformed output previews and restores its actual original source MIME", () => {
  const item = { key: "logo.png", versionId: "old" } as DraftItem;
  const source = { versionId: "new", mimeType: "image/jpeg" } as SyncAsset;
  const saved = { versionId: "old", mimeType: "image/webp", sourceMimeType: "image/png",
    transformation: { format: "webp" } } as VardItem;
  assert.equal(sourcePreview(item, "demo", source, saved).mimeType, "image/png");
});

test("output previews apply signed settings to the selected version, never latest", () => {
  const original = sourcePreview({ key: "logo.svg", versionId: "pinned" } as DraftItem,
    "demo", { versionId: "latest", mimeType: "image/svg+xml" } as SyncAsset, undefined).url;
  assert.equal(transformedPreviewUrl(original, "https://cdn.example/w/logo.svg?format=png&bg=%23ffffff&sig=signed"),
    "/w/demo/__v/pinned/logo.svg?format=png&bg=%23ffffff&sig=signed");
  assert.equal(transformedPreviewUrl(null, "/w/demo/logo.svg?sig=signed"), null);
  assert.equal(transformedPreviewUrl(original, undefined), null);
  assert.equal(transformedPreviewUrl(original, "/w/demo/logo.svg"), null);
});
