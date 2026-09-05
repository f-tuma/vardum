import assert from "node:assert/strict";
import test from "node:test";
import { assetDeliveryPath, setAssetVisibility } from "./asset-api.js";

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
