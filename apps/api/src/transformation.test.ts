import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeTransformation,
  signTransformation,
  transformationSchema,
  transformedAssetUrl,
  transformedVersionUrl,
  verifyTransformation,
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

test("fit and quality cannot create meaningless transformations", () => {
  assert.equal(transformationSchema.safeParse({ fit: "cover" }).success, false);
  assert.equal(transformationSchema.safeParse({ q: 90 }).success, false);
});
