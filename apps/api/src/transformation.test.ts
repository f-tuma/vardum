import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeTransformation,
  signTransformation,
  transformationSchema,
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
