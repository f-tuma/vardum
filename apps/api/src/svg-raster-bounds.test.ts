import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { CapacityError } from "./resource-budget.js";
import { assertSvgRasterBudget, svgRasterBounds, svgRasterLimitError, type SvgRasterBranch } from "./svg-raster-bounds.js";
import type { Transformation } from "./transformation.js";

type Recipe = Pick<Transformation, "w" | "h" | "fit" | "pad">;
const branches: SvgRasterBranch[] = ["legacy-background", "svg-loader-scale"];
const fits = ["inside", "outside", "cover", "contain", "fill"] as const;
const svg = (canvas: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${canvas}><rect width="100" height="100" fill="red"/></svg>`);
const capacity = (error: unknown) => error instanceof CapacityError && error.statusCode === 422 && /output pixel limit/.test(error.message);

// Independent native pipelines observe final and pre-crop sizes. Replacing
// contain with inside (or cover with outside) keeps the loader scale but omits
// only the embed (or crop). The helper's returned parameters are never rendered.
async function nativeCanvas(bytes: Buffer, recipe: Recipe, branch: SvgRasterBranch, preCrop = false) {
  let image = sharp(bytes, { limitInputPixels: 100_000_000 });
  if (branch === "legacy-background") image = image.pipelineColourspace("srgb").flatten({ background: "#204060" });
  if (recipe.w || recipe.h) {
    const inset = recipe.pad ? Math.floor(Math.min(recipe.w!, recipe.h!) * recipe.pad / 100) : 0;
    let fit = recipe.pad ? "contain" as const : recipe.fit ?? "inside";
    if (preCrop && fit === "contain") fit = "inside";
    else if (preCrop && fit === "cover") fit = "outside";
    image = image.resize({ width: recipe.w && recipe.w - 2 * inset, height: recipe.h && recipe.h - 2 * inset,
      fit, background: { r: 0, g: 0, b: 0, alpha: 0 } });
    if (inset && !preCrop) image = image.extend({ top: inset, bottom: inset, left: inset, right: inset,
      background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  return (await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })).info;
}

test("bounds enclose tiny native SVG outputs for intrinsic, inferred and viewBox canvases in both branches", async () => {
  const fixtures = [
    'width="96" height="32"',
    'width="1.1" height="10"',
    'viewBox="0 0 1.1 10"',
    'width="0.5" height="3.5"',
    'width="1.4999" height="9.5001"',
    'width="2.5001" height="3.4999"',
    'width="11" height="7" viewBox="0 0 100 100"',
    'width="7" viewBox="0 0 3.5 11"',
  ];
  const recipes: Recipe[] = [{}, { w: 16 }, { h: 17 }];
  for (const fit of fits) recipes.push({ w: 23, h: 19, fit }, { w: 16, fit }, { h: 17, fit });
  for (const pad of [0, 0.1, 12.8, 45]) recipes.push({ w: 23, h: 19, fit: "contain", pad });
  for (const canvas of fixtures) {
    const bytes = svg(canvas), metadata = await sharp(bytes).metadata();
    for (const branch of branches) for (const recipe of recipes) {
      const bounds = assertSvgRasterBudget(metadata, recipe, branch, 100_000_000);
      const final = await nativeCanvas(bytes, recipe, branch);
      const preCrop = await nativeCanvas(bytes, recipe, branch, true);
      const context = JSON.stringify({ canvas, branch, recipe, bounds, final: [final.width, final.height], preCrop: [preCrop.width, preCrop.height] });
      assert.ok(final.width <= bounds.finalUpper.w && final.height <= bounds.finalUpper.h, context);
      assert.ok(preCrop.width <= bounds.preCropUpper.w && preCrop.height <= bounds.preCropUpper.h, context);
      if (!recipe.w && !recipe.h) {
        assert.deepEqual(bounds.loader, { w: [metadata.width, metadata.width], h: [metadata.height, metadata.height] });
        assert.deepEqual(bounds.finalUpper, { w: final.width, h: final.height });
      }
    }
  }
});

test("fractional SVG metadata cannot undercount the v2 raw allocation, while the legacy boundary remains exact", async () => {
  for (const canvas of ['width="1.1" height="10"', 'viewBox="0 0 1.1 10"']) {
    const bytes = svg(canvas), metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height], [1, 10]);
    const recipe = { h: 128 };
    assert.throws(() => assertSvgRasterBudget(metadata, recipe, "svg-loader-scale", 1664), capacity);
    assert.throws(() => assertSvgRasterBudget(metadata, recipe, "svg-loader-scale", 1792), capacity,
      "an interval also admitting a larger natural width must fail closed");
    const v2 = assertSvgRasterBudget(metadata, recipe, "svg-loader-scale", 4096);
    const actualV2 = await nativeCanvas(bytes, recipe, "svg-loader-scale");
    assert.deepEqual([actualV2.width, actualV2.height], [14, 128]);
    assert.ok(v2.finalUpper.w * v2.finalUpper.h <= 4096);
    const legacy = assertSvgRasterBudget(metadata, recipe, "legacy-background", 1664);
    assert.deepEqual(legacy.finalUpper, { w: 13, h: 128 });
    const actualLegacy = await nativeCanvas(bytes, recipe, "legacy-background");
    assert.deepEqual([actualLegacy.width, actualLegacy.height], [13, 128]);
  }
});

test("one-axis fill retains the loaded missing axis and exact integer budget boundaries", async () => {
  const metadata = { width: 96, height: 32 }, bytes = svg('width="96" height="32"');
  for (const [recipe, expected] of [
    [{ w: 48, fit: "fill" }, { w: 48, h: 32 }],
    [{ h: 16, fit: "fill" }, { w: 96, h: 16 }],
  ] as const) for (const branch of branches) {
    const pixels = expected.w * expected.h;
    assert.deepEqual(assertSvgRasterBudget(metadata, recipe, branch, pixels).finalUpper, expected);
    assert.throws(() => assertSvgRasterBudget(metadata, recipe, branch, pixels - 1), capacity);
    const actual = await nativeCanvas(bytes, recipe, branch);
    assert.deepEqual([actual.width, actual.height], [expected.w, expected.h]);
  }
  const recipe = { w: 192, fit: "fill" } as const;
  const legacy = svgRasterBounds(metadata, recipe, "legacy-background");
  assert.deepEqual(legacy.finalUpper, { w: 192, h: 32 });
  const scaled = svgRasterBounds(metadata, recipe, "svg-loader-scale");
  const actual = await nativeCanvas(bytes, recipe, "svg-loader-scale");
  assert.deepEqual([actual.width, actual.height], [192, 64]);
  assert.ok(scaled.finalUpper.h >= 64, "loader enlargement also enlarges fill's unspecified axis");
});

test("native no-reload and contain padding have exact geometry, including zero-pixel padding", () => {
  const metadata = { width: 48, height: 48 };
  assert.deepEqual(svgRasterBounds(metadata, { w: 48 }, "svg-loader-scale").loader, { w: [48, 48], h: [48, 48] });
  for (const pad of [undefined, 0, 0.1, 12.8, 45]) for (const branch of branches) {
    assert.deepEqual(assertSvgRasterBudget(metadata, { w: 23, h: 19, fit: "contain", pad }, branch, 23 * 19).finalUpper,
      { w: 23, h: 19 });
  }
  assert.deepEqual(svgRasterBounds({ width: 1, height: 10_000 }, { w: 4096, h: 1, fit: "inside" }, "svg-loader-scale").loader,
    { w: [1, 1], h: [10_000, 10_000] }, "the per-axis minimum-pixel clamp can prevent a nominal loader shrink");
});

test("large pure geometry is rejected before rendering or allocating source, loader or pre-crop canvases", () => {
  const cases: [Parameters<typeof svgRasterBounds>[0], Recipe, SvgRasterBranch][] = [
    [{ width: 10_001, height: 10_000 }, {}, "svg-loader-scale"], // original source area
    [{ width: 32_768, height: 1 }, {}, "svg-loader-scale"], // native loader side
    [{ width: 1, height: 10 }, { w: 4096 }, "svg-loader-scale"], // scaled loader side
    [{ width: 1, height: 6 }, { w: 4096, h: 4096, fit: "fill" }, "svg-loader-scale"], // scaled loader area, small final canvas
    [{ width: 1, height: 3 }, { w: 4096, h: 4096, fit: "cover" }, "svg-loader-scale"], // pre-crop area after a bounded loader
  ];
  for (const [metadata, recipe, branch] of cases) assert.throws(() => svgRasterBounds(metadata, recipe, branch), capacity);
  assert.doesNotThrow(() => assertSvgRasterBudget({ width: 10_000, height: 10_000 }, {}, "svg-loader-scale", 100_000_000));
  assert.doesNotThrow(() => assertSvgRasterBudget({ width: 50_000, height: 500 }, { w: 50, h: 50, fit: "inside" }, "svg-loader-scale", 1000),
    "the initial native side can exceed 32767 when a safe loader reload shrinks it");
  assert.throws(() => assertSvgRasterBudget({ width: 48, height: 48 }, { w: 128, h: 128, fit: "contain" }, "svg-loader-scale", 1000), capacity);
});

test("invalid inputs and prototype-like mode names cannot select an unchecked branch", () => {
  for (const metadata of [{}, { width: NaN, height: 1 }, { width: 1, height: Infinity }, { width: 0.5, height: 1 }, { width: 0, height: 1 }, { width: -1, height: 1 }])
    assert.throws(() => svgRasterBounds(metadata, {}, "svg-loader-scale"), capacity);
  for (const recipe of [{ w: 0 }, { h: 4097 }, { w: 2.5 }, { pad: -1 }, { pad: 46 }, { pad: NaN }, { w: 2, h: 2, pad: 10 }, { fit: "constructor" }, { fit: "__proto__" }])
    assert.throws(() => svgRasterBounds({ width: 1, height: 1 }, recipe as Recipe, "svg-loader-scale"), capacity);
  assert.throws(() => svgRasterBounds({ width: 1, height: 1 }, {}, "constructor" as SvgRasterBranch), capacity);
  for (const limit of [0, -1, NaN, Infinity, 1.5, 100_000_001])
    assert.throws(() => assertSvgRasterBudget({ width: 1, height: 1 }, {}, "svg-loader-scale", limit), capacity);
});

test("only exact native SVG geometry limit errors become user-facing 422 failures", () => {
  const messages = [
    "Input image exceeds pixel limit",
    "Input SVG image exceeds 32767x32767 pixel limit",
    "Input SVG image will exceed 32767x32767 pixel limit when scaled",
  ];
  for (const message of messages) {
    const original = new Error(message), translated = svgRasterLimitError(original);
    assert.ok(capacity(translated));
    assert.notEqual(translated, original);
  }
  const abort = new Error(messages[0]); abort.name = "AbortError";
  const timeout = new Error(messages[0]); timeout.name = "TimeoutError";
  for (const error of [abort, timeout, new DOMException("cancelled", "AbortError"), new DOMException("expired", "TimeoutError"),
    new Error("S3 unavailable"), new Error("Input image exceeds pixel limit\n"), new Error(`prefix: ${messages[0]}`),
    new TypeError(messages[0]), new CapacityError(messages[0], 503), { message: messages[0] }, messages[0], null, undefined])
    assert.equal(svgRasterLimitError(error), error);
});
