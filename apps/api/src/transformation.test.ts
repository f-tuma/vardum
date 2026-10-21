import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeTransformation,
  signTransformation,
  transformationSchema,
  transformationQuerySchema,
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

test("opaque backgrounds normalize and require an explicit output format", () => {
  const transformation = transformationSchema.parse({ format: "png", bg: "#Ab12Ef" });
  assert.deepEqual(transformation, { format: "png", bg: "#ab12ef" });
  assert.equal(canonicalizeTransformation(transformation), "format=png&q=80&bg=%23ab12ef");
  assert.equal(transformationSchema.safeParse({ bg: "#123456" }).success, false);
  assert.equal(transformationSchema.safeParse({ w: 16, bg: "#123456" }).success, false);
  assert.equal(transformationSchema.safeParse({ format: "svg", bg: "#123456" }).success, true);
  for (const bg of ["", "#abc", "#12345678", "transparent", "white", "rgb(1,2,3)", "#gg0000", "#123456 ", null, 123]) {
    assert.equal(transformationSchema.safeParse({ format: "png", bg }).success, false, String(bg));
    assert.equal(transformationQuerySchema.safeParse({ format: "png", bg, sig: "fixture" }).success, false, String(bg));
  }
  assert.equal(transformationQuerySchema.safeParse({ w: "16", bg: "#123456", sig: "fixture" }).success, false);
});

test("background URLs encode the hash, round-trip and reject color tampering", () => {
  const transformation = { w: 16, format: "webp", bg: "#Ab12Ef" } as const;
  const url = new URL(transformedVersionUrl("workspace", "brand/logo", "version", transformation), "https://example.test");
  assert.equal(url.hash, "");
  assert.match(url.search, /&bg=%23ab12ef&sig=/);
  const parsed = transformationQuerySchema.parse(Object.fromEntries(url.searchParams));
  assert.equal(parsed.bg, "#ab12ef");
  assert.equal(verifyTransformation("workspace", "brand/logo", parsed, parsed.sig), true);
  assert.equal(verifyTransformation("workspace", "brand/logo", { ...parsed, bg: "#123456" }, parsed.sig), false);
  assert.notEqual(signTransformation("workspace", "brand/logo", parsed), signTransformation("workspace", "brand/logo", { ...parsed, bg: "#123456" }));
  assert.notEqual(signTransformation("workspace", "brand/logo", parsed), signTransformation("workspace", "brand/logo", { w: 16, format: "webp" }));
});

test("legacy transformations without background retain their exact canonical identity", () => {
  for (const [input, canonical] of [
    [{ w: 300 }, "w=300&fit=inside"],
    [{ h: 40, fit: "contain" }, "h=40&fit=contain"],
    [{ format: "png" }, "format=png&q=80"],
    [{ w: 128, h: 128, fit: "cover", format: "jpeg", q: 90 }, "w=128&h=128&fit=cover&format=jpeg&q=90"],
  ] as const) assert.equal(canonicalizeTransformation(input), canonical);
});


test("padding is a bounded percentage with at most two decimal places requiring an explicit contained canvas", () => {
  const canvas = { w: 1024, h: 1024, fit: "contain", format: "png" } as const;
  for (const pad of [0, 1, 1.5, 12.8, 26.57, 16.7, 15, 45]) {
    assert.equal(transformationSchema.parse({ ...canvas, pad }).pad, pad);
    assert.equal(transformationQuerySchema.parse({ ...canvas, pad: String(pad), sig: "fixture" }).pad, pad);
  }
  for (const pad of [-1, 46, "46", "046", 1.501, "1.501", "45.01", "", " ", null, false, true, "many", {}, []]) {
    assert.equal(transformationSchema.safeParse({ ...canvas, pad }).success, false, JSON.stringify(pad));
    assert.equal(transformationQuerySchema.safeParse({ ...canvas, pad, sig: "fixture" }).success, false, JSON.stringify(pad));
  }
  for (const input of [
    { format: "png", pad: 10 }, { w: 32, fit: "contain", format: "png", pad: 10 },
    { h: 32, fit: "contain", format: "png", pad: 10 }, { w: 32, h: 32, fit: "contain", pad: 10 },
    ...[undefined, "inside", "outside", "cover", "fill"].map(fit => ({ ...canvas, fit, pad: 10 })),
  ]) {
    assert.equal(transformationSchema.safeParse(input).success, false, JSON.stringify(input));
    assert.equal(transformationQuerySchema.safeParse({ ...input, sig: "fixture" }).success, false, JSON.stringify(input));
  }
  assert.equal(transformationQuerySchema.parse({ ...canvas, pad: "015", sig: "fixture" }).pad, 15);
  assert.equal(transformationSchema.safeParse({ format: "png", pad: 0 }).success, true);
  assert.equal(transformationSchema.safeParse({ pad: 0 }).success, false);
});

test("padding participates in signed identity while zero preserves existing identities", () => {
  const canvas = { w: 64, h: 48, fit: "contain", format: "png", bg: "#204060" } as const;
  const url = new URL(transformedVersionUrl("workspace", "brand/logo", "version", { ...canvas, pad: 15 }), "https://example.test");
  const parsed = transformationQuerySchema.parse(Object.fromEntries(url.searchParams));
  assert.equal(canonicalizeTransformation(parsed), "w=64&h=48&fit=contain&format=png&q=80&bg=%23204060&pad=15");
  assert.equal(verifyTransformation("workspace", "brand/logo", parsed, parsed.sig), true);
  assert.equal(verifyTransformation("workspace", "brand/logo", { ...parsed, pad: 16 }, parsed.sig), false);
  assert.equal(verifyTransformation("workspace", "brand/logo", { ...parsed, pad: undefined }, parsed.sig), false);
  assert.equal(canonicalizeTransformation({ ...canvas, pad: 0 }), canonicalizeTransformation(canvas));
  assert.equal(signTransformation("workspace", "brand/logo", { ...canvas, pad: 0 }), signTransformation("workspace", "brand/logo", canvas));
  assert.equal(transformedVersionUrl("workspace", "brand/logo", "version", { ...canvas, pad: 0 }), transformedVersionUrl("workspace", "brand/logo", "version", canvas));
});


test("SVG fields round-trip signed canonical queries and reject tampering", () => {
  assert.deepEqual(transformationSchema.parse({ format: "svg", fit: "contain" }), { format: "svg", fit: "contain" });
  assert.equal(canonicalizeTransformation({ format: "svg", fit: "contain" }), "format=svg");
  assert.equal(transformationSchema.safeParse({ format: "png", fit: "contain" }).success, false);
  const recipe = transformationSchema.parse({ w: 48, h: 48, format: "svg", layer: "neutral-arm", darkLayer: "neutral-arm", darkColor: "#Ab12Ef" });
  const canonical = "w=48&h=48&fit=contain&format=svg&layer=neutral-arm&darkLayer=neutral-arm&darkColor=%23ab12ef";
  assert.equal(canonicalizeTransformation(recipe), canonical);
  const url = new URL(transformedVersionUrl("workspace", "master", "version", recipe), "https://example.test");
  const parsed = transformationQuerySchema.parse(Object.fromEntries(url.searchParams));
  assert.equal(verifyTransformation("workspace", "master", parsed, parsed.sig), true);
  for (const change of [{ layer: "accent-arm" }, { darkLayer: "accent-arm" }, { darkColor: "#112233" }, { format: "png" }])
    assert.equal(verifyTransformation("workspace", "master", { ...parsed, ...change } as typeof parsed, parsed.sig), false);
  assert.equal(canonicalizeTransformation({ format: "svg" }), "format=svg");
  assert.equal(canonicalizeTransformation(transformationSchema.parse({ w: 1024, h: 1024, fit: "contain", format: "png", pad: "012.80" })), "w=1024&h=1024&fit=contain&format=png&q=80&pad=12.8");
});

test("SVG output supports only contain and bounded group/adaptive fields", () => {
  for (const input of [
    { format: "svg", q: 80 }, { format: "svg", w: 48, fit: "inside" },
    { format: "svg", darkLayer: "neutral-arm" }, { format: "svg", darkColor: "#123456" },
    { format: "png", darkLayer: "neutral-arm", darkColor: "#123456" },
    ...["", "#arm", "arm path", "a:b", "1arm", "x".repeat(65), 'arm" onclick="x'].map(layer => ({ format: "svg", layer })),
    ...["red", "#123", "#12345678", "#123456;display:none"].map(darkColor => ({ format: "svg", darkLayer: "neutral-arm", darkColor })),
  ]) assert.equal(transformationSchema.safeParse(input).success, false, JSON.stringify(input));
  assert.equal(transformationSchema.safeParse({ format: "png", layer: "neutral-arm" }).success, true);
  assert.equal(transformationSchema.safeParse({ w: 48, layer: "neutral-arm" }).success, true);
  assert.equal(transformationSchema.safeParse({ format: "svg", w: 48, h: 48, fit: "contain", pad: 12.8 }).success, true);
});
