import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeTransformation,
  signTransformation,
  transformationSchema,
  transformedAssetUrl,
  transformedVersionUrl,
  verifyTransformation,
  identityVersionUrl,
  signVersionTransformation,
  verifyVersionTransformation,
} from "./transformation.js";

test("transformations are canonical and signatures reject tampering", () => {
  const transformation = transformationSchema.parse({
    w: "300",
    format: "webp",
  });
  assert.equal(
    canonicalizeTransformation(transformation),
    "w=300&fit=inside&format=webp&q=80",
  );

  const signature = signTransformation(
    "workspace",
    "brand/logo",
    transformation,
  );
  assert.equal(
    verifyTransformation("workspace", "brand/logo", transformation, signature),
    true,
  );
  assert.match(
    transformedAssetUrl("workspace", "brand/logo", transformation),
    /^\/w\/workspace\/brand\/logo\?/,
  );
  assert.match(
    transformedAssetUrl(
      "workspace",
      "brand/logo",
      transformation,
      "assets.example.com",
    ),
    /^https:\/\/assets\.example\.com\/w\/brand\/logo\?/,
  );
  assert.match(
    transformedVersionUrl(
      "workspace",
      "brand/logo",
      "a9eaadf4-c18e-4f42-bf24-7569219f811c",
      transformation,
    ),
    /^\/w\/workspace\/__v\/a9eaadf4-c18e-4f42-bf24-7569219f811c\/brand\/logo\?/,
  );
  assert.equal(
    verifyTransformation(
      "workspace",
      "brand/logo",
      { ...transformation, w: 301 },
      signature,
    ),
    false,
  );
});

test("identity signatures bind workspace, version, canonical transform and signing domain", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const transform = { w: 64, format: "png" as const };
  const signed = signVersionTransformation("ws", first, transform);
  assert.equal(verifyVersionTransformation("ws", first, { ...transform, fit: "inside", q: 80 }, signed), true);
  assert.equal(verifyVersionTransformation("other", first, transform, signed), false);
  assert.equal(verifyVersionTransformation("ws", second, transform, signed), false);
  assert.equal(verifyVersionTransformation("ws", first, { ...transform, w: 65 }, signed), false);
  assert.equal(verifyVersionTransformation("ws", first, transform, signTransformation("ws", first, transform)), false);
  assert.equal(verifyTransformation("ws", first, transform, signed), false);
  assert.equal(identityVersionUrl("ws", first), `/w/__id/ws/__v/${first}`);
});

test("fit and quality cannot create meaningless transformations", () => {
  assert.equal(transformationSchema.safeParse({ fit: "cover" }).success, false);
  assert.equal(transformationSchema.safeParse({ q: 90 }).success, false);
});
