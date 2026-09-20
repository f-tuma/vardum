import assert from "node:assert/strict";
import test from "node:test";
import {
  assetDeliveryPath,
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
