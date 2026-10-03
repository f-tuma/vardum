import assert from "node:assert/strict";
import test from "node:test";
import {
  assetDeliveryPath,
  assetPreviewUrl,
  setAssetVisibility,
  uploadVersion,
  validateUploadFile,
} from "./asset-api.js";

test("assetDeliveryPath keeps private Open/copy URLs on the app origin", () => {
  const asset = {
    key: "brand/logo.svg",
    isPublic: false,
    customDomain: "cdn.example.test",
  };
  assert.equal(assetDeliveryPath("demo", asset), "/w/demo/brand/logo.svg");
  assert.equal(
    assetDeliveryPath("demo", { ...asset, isPublic: true }),
    "https://cdn.example.test/w/brand/logo.svg",
  );
  assert.equal(
    assetDeliveryPath("demo", { ...asset, isPublic: true, customDomain: null }),
    "/w/demo/brand/logo.svg",
  );
});

test("current previews change on upload, restore and retry while copy URLs stay stable", () => {
  const asset = {
    key: "brand/logo #1.png",
    isPublic: false,
    customDomain: "cdn.example.test",
    currentVersionId: "version-1",
    thumbnailUrl: "/w/my%20workspace/brand/logo%20%231.png",
  };
  const stableUrl = assetDeliveryPath("my workspace", asset);
  const original = assetPreviewUrl("my workspace", asset, stableUrl);
  assert.equal(original, "/w/my%20workspace/__v/version-1/brand/logo%20%231.png");
  const uploaded = { ...asset, currentVersionId: "version-2" };
  const retried = { ...asset, currentVersionId: "version-3" };
  assert.equal(
    assetPreviewUrl("my workspace", uploaded),
    "/w/my%20workspace/__v/version-2/brand/logo%20%231.png",
  );
  assert.equal(
    assetPreviewUrl("my workspace", retried),
    "/w/my%20workspace/__v/version-3/brand/logo%20%231.png",
  );
  assert.equal(assetPreviewUrl("my workspace", asset), original);
  assert.equal(assetDeliveryPath("my workspace", uploaded), stableUrl);
  assert.equal(assetDeliveryPath("my workspace", retried), stableUrl);
});

test("public previews use immutable app and custom-domain paths", () => {
  const asset = {
    key: "brand/a%2F.svg",
    isPublic: true,
    currentVersionId: "version-2",
    thumbnailUrl: "/w/demo/brand/a%252F.svg",
  };
  assert.equal(
    assetPreviewUrl("demo", asset),
    "/w/demo/__v/version-2/brand/a%252F.svg",
  );
  const custom = {
    ...asset,
    customDomain: "cdn.example.test",
    thumbnailUrl: "https://cdn.example.test/w/brand/a%252F.svg",
  };
  assert.equal(
    assetPreviewUrl("demo", custom),
    "https://cdn.example.test/w/__v/version-2/brand/a%252F.svg",
  );
  assert.equal(assetDeliveryPath("demo", custom), custom.thumbnailUrl);
});

test("immutable transformed previews preserve signed query strings byte for byte", () => {
  const query = "?w=240&h=180&fit=inside&format=webp&q=80&sig=a%2Bb%2Fc%3D#preview";
  const asset = {
    key: "brand/logo.png",
    isPublic: false,
    customDomain: "cdn.example.test",
    currentVersionId: "version-1",
    thumbnailUrl: `/w/demo/brand/logo.png${query}`,
  };
  assert.equal(
    assetPreviewUrl("demo", asset),
    `/w/demo/__v/version-1/brand/logo.png${query}`,
  );
  assert.equal(
    assetPreviewUrl("demo", { ...asset, currentVersionId: "version-2" }),
    `/w/demo/__v/version-2/brand/logo.png${query}`,
  );
  const custom = {
    ...asset,
    isPublic: true,
    thumbnailUrl: `https://cdn.example.test/w/brand/logo.png${query}`,
  };
  assert.equal(
    assetPreviewUrl("demo", custom),
    `https://cdn.example.test/w/__v/version-1/brand/logo.png${query}`,
  );
});

test("already versioned previews preserve pinned versions and signed transforms", () => {
  const asset = {
    key: "brand/logo.png",
    isPublic: true,
    currentVersionId: "new-version",
    thumbnailUrl: "/w/demo/__v/old-version/brand/logo.png?w=100&fit=inside&sig=signed",
  };
  assert.equal(assetPreviewUrl("demo", asset), asset.thumbnailUrl);
  const custom = {
    ...asset,
    customDomain: "cdn.example.test",
    thumbnailUrl: "https://cdn.example.test/w/__v/old-version/brand/logo.png?w=100&fit=inside&sig=signed",
  };
  assert.equal(assetPreviewUrl("demo", custom), custom.thumbnailUrl);
});

test("unpublished assets and absent previews have no delivery URL", () => {
  const asset = {
    key: "logo.png",
    isPublic: false,
    currentVersionId: null,
    thumbnailUrl: "/w/demo/logo.png",
  };
  assert.equal(assetPreviewUrl("demo", asset), null);
  assert.equal(assetPreviewUrl("demo", { ...asset, currentVersionId: "v1", thumbnailUrl: null }), null);
});

test("setAssetVisibility sends a dedicated boolean PATCH without URL credentials", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init: RequestInit) => {
      assert.equal(url, "/api/workspaces/workspace/assets/asset/visibility");
      assert.equal(init.method, "PATCH");
      assert.deepEqual(JSON.parse(init.body as string), { isPublic: false });
      return new Response(JSON.stringify({ isPublic: false }), { status: 200 });
    },
  );
  assert.deepEqual(await setAssetVisibility("workspace", "asset", false), {
    isPublic: false,
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("oversized uploads stop before creating a version; exact limits remain valid", async (t) => {
  const mib = 1024 * 1024;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    assert.equal(url, "/api/upload-limits");
    return Response.json({
      image: 25 * mib,
      video: 200 * mib,
      file: 100 * mib,
    });
  });
  const oversized = new File([new Uint8Array(26 * mib)], "large.png", {
    type: "image/png",
  });
  await assert.rejects(
    uploadVersion("workspace", "asset", oversized),
    /26 MB.*25 MB/,
  );
  assert.deepEqual(requests, ["/api/upload-limits"]);
  assert.equal(
    await validateUploadFile(new File([new Uint8Array(25 * mib)], "limit.png")),
    "image/png",
  );
  assert.equal(
    await validateUploadFile(new File([new Uint8Array(26 * mib)], "clip.mp4")),
    "video/mp4",
  );
});
