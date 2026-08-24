import assert from "node:assert/strict";
import test from "node:test";
import type { SyncAsset } from "./client.js";
import { collectFolders } from "./interactive.js";

const asset = (key: string): SyncAsset =>
  ({
    id: "id",
    key,
    displayName: key,
    versionId: "v",
    checksum: null,
    mimeType: "image/png",
    size: 0,
  }) as SyncAsset;

test("collectFolders counts every folder, nested ones included", () => {
  assert.deepEqual(collectFolders([]), []);
  assert.deepEqual(
    collectFolders([
      asset("beach/sunset.avif"),
      asset("beach/waves.avif"),
      asset("beach/wide/panorama.avif"),
      asset("mountains/peak.avif"),
      asset("root.avif"),
    ]),
    [
      ["beach", 3],
      ["beach/wide", 1],
      ["mountains", 1],
    ],
  );
});
