import assert from "node:assert/strict";
import test from "node:test";
import {
  importedAssetKey,
  importedMimeType,
  importSource,
} from "./asset-import.js";
import { assetKey } from "./asset-routes.js";

test("imported keys stay valid asset keys or are skipped", () => {
  const cases: [string, string, string, string | null][] = [
    ["", "photos/", "photos/logo.png", "logo.png"],
    [
      "brand/",
      "photos/",
      "photos/icons/App Icon.PNG",
      "brand/icons/app-icon.png",
    ],
    ["", "", "Ćervená Šípková.jpeg", "cervena-sipkova.jpeg"],
    ["", "photos/", "photos/nested/deep/a.webp", "nested/deep/a.webp"],
    // A folder marker and anything outside the prefix are not objects to import.
    ["", "photos/", "photos/subfolder/", null],
    ["", "photos/", "other/logo.png", null],
    // Nothing usable survives the segment rules.
    ["", "", "///", null],
    ["", "", "___", null],
  ];

  for (const [prefix, source, objectKey, expected] of cases) {
    const key = importedAssetKey(prefix, source, objectKey);
    assert.equal(key, expected, objectKey);
    if (key)
      assert.equal(
        assetKey.safeParse(key).success,
        true,
        `${key} must satisfy the asset key schema`,
      );
  }

  assert.equal(
    importedAssetKey("", "", `${"a".repeat(260)}.png`),
    null,
    "an over-long key must be skipped, not truncated",
  );
});

test("imported objects declare a supported image type or are skipped", () => {
  assert.equal(importedMimeType("a.PNG", undefined), "image/png");
  assert.equal(importedMimeType("a.jpg", undefined), "image/jpeg");
  assert.equal(importedMimeType("a.tif", undefined), "image/tiff");
  assert.equal(importedMimeType("a.txt", undefined), null);
  // S3 metadata wins when it names a supported type, and is ignored otherwise.
  assert.equal(importedMimeType("a", "image/webp"), "image/webp");
  assert.equal(
    importedMimeType("a.png", "application/octet-stream"),
    "image/png",
  );
  assert.equal(importedMimeType("a.exe", "text/html"), null);
});

test("imports refuse Vardum's own storage prefixes", () => {
  assert.equal(importSource.safeParse("photos/").success, true);
  assert.equal(importSource.safeParse("").success, true);
  assert.equal(importSource.safeParse("originals/").success, false);
  assert.equal(importSource.safeParse("derived/v1/").success, false);
});
