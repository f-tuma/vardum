import assert from "node:assert/strict";
import test from "node:test";
import sharp, { type Sharp } from "sharp";
import { applyImageTransformation } from "./image-transform.js";
import { getImageVariant } from "./image-variant.js";
import { renderSvgRasterBackground } from "./svg-raster-background.js";
import { CapacityError } from "./resource-budget.js";
import type { Transformation } from "./transformation.js";

const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect x="4" y="8" width="40" height="32" fill="#c8553d"/><rect x="16" y="16" width="16" height="16" fill="#204060" fill-opacity="0.5"/></svg>');
const bg = "#050507";
const budget = (maxOutputPixels = 16_777_216) => ({ signal: new AbortController().signal, deadline: Date.now() + 30_000, maxOutputPixels });
const decoded = (bytes: Buffer) => sharp(bytes).raw().toBuffer({ resolveWithObject: true });

function bounds(data: Buffer, width: number, height: number, channels: number) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    if ([5, 5, 7].some((value, c) => data[i + c] !== value)) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return [left, top, right - left + 1, bottom - top + 1];
}

test("v2 upscales native SVG geometry before background for app and touch canvases", async () => {
  for (const [size, pad] of [[1024, 12.8], [180, 14]]) {
    const recipe: Transformation = { w: size, h: size, fit: "contain", format: "png", q: 100, pad, bg, render: "v2" };
    const actual = await renderSvgRasterBackground(sharp(source), recipe, "png", budget());
    const inset = Math.floor(size! * pad! / 100), inner = size! - 2 * inset;
    // An independent vector reference has a final-size intrinsic canvas and no
    // resize operation at all. This catches interpolation of the 48px raster.
    const referenceSvg = Buffer.from(source.toString().replace('width="48" height="48"', `width="${inner}" height="${inner}"`));
    const alpha = await sharp(referenceSvg).extend({ top: inset, bottom: inset, left: inset, right: inset,
      background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const expected = await sharp(alpha).flatten({ background: bg }).png({ quality: 100 }).toBuffer();
    const result = await decoded(actual), target = await decoded(expected);
    assert.equal(result.info.width, size); assert.equal(result.info.height, size); assert.equal(result.info.channels, 3);
    assert.deepEqual(bounds(result.data, size!, size!, 3), bounds(target.data, size!, size!, 3));
    assert.deepEqual(result.data, target.data, "vector edges and semitransparent colors match direct final-size rasterization");
    const legacy = await decoded(await applyImageTransformation(sharp(source), recipe, "png").toBuffer());
    assert.notDeepEqual(bounds(legacy.data, size!, size!, 3), bounds(target.data, size!, size!, 3), "fixture exposes legacy enlarged raster blur");
  }
});

test("v2 supports raster encoders, native size and one- or two-dimensional resize fits", async () => {
  for (const format of ["png", "webp", "avif", "jpeg"] as const) {
    for (const geometry of [{}, { w: 128 }, { h: 96 }, ...["inside", "outside", "cover", "contain", "fill"].map(fit => ({ w: 128, h: 96, fit } as const))]) {
      const recipe = { ...geometry, format, bg, q: 100, render: "v2" } as Transformation;
      const result = await renderSvgRasterBackground(sharp(source), recipe, format, budget());
      const metadata = await sharp(result).metadata();
      assert.equal(metadata.hasAlpha, false, `${format} output is opaque`);
      const expected = await applyImageTransformation(sharp(source), { ...recipe, bg: undefined }, format).toBuffer();
      const expectedMetadata = await sharp(expected).metadata();
      assert.equal(metadata.width, expectedMetadata.width); assert.equal(metadata.height, expectedMetadata.height);
      if (!geometry.w && !geometry.h) { assert.equal(metadata.width, 48); assert.equal(metadata.height, 48); }
    }
  }
});

test("v2 non-square contain letterboxing uses the selected background, including zero-pixel padding", async () => {
  const wide = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="16" height="16" fill="red"/><rect x="16" width="16" height="16" fill="blue" fill-opacity="0.5"/></svg>');
  for (const pad of [undefined, 0, 0.1]) {
    const recipe = { w: 128, h: 128, fit: "contain", format: "png", q: 100, bg: "#204060", render: "v2", pad } as const;
    const { data, info } = await decoded(await renderSvgRasterBackground(sharp(wide), recipe, "png", budget()));
    assert.equal(info.width, 128); assert.equal(info.height, 128); assert.equal(info.channels, 3);
    const at = (x: number, y: number) => [...data.subarray((y * 128 + x) * 3, (y * 128 + x) * 3 + 3)];
    for (const [x, y] of [[0, 0], [127, 127], [64, 16], [64, 31], [64, 96], [64, 112]])
      assert.deepEqual(at(x!, y!), [32, 64, 96], `pad ${pad}: selected background at (${x}, ${y})`);
    assert.deepEqual(at(16, 64), [255, 0, 0], `pad ${pad}: opaque artwork retains its color`);
    assert.ok(at(112, 64).every((value, channel) => Math.abs(value - [16, 32, 176][channel]!) <= 1),
      `pad ${pad}: alpha composites onto the selected background within eight-bit rounding`);
  }
});

test("v2 rejects raster content, animation, excessive output and expired work", async () => {
  const png = await sharp(source).png().toBuffer();
  const animated = await sharp(Buffer.alloc(2 * 4 * 4 * 4, 255), { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
    .webp({ lossless: true, delay: [100, 200], loop: 0 }).toBuffer();
  const recipe = { format: "png", bg, render: "v2" } as const;
  for (const bytes of [png, animated]) await assert.rejects(
    renderSvgRasterBackground(sharp(bytes, { animated: true }), recipe, "png", budget()), /static SVG source/);
  await assert.rejects(renderSvgRasterBackground(sharp(source), { ...recipe, w: 4096, h: 4096, fit: "contain" }, "png", budget(1024)), /output pixel limit/);
  await assert.rejects(renderSvgRasterBackground(sharp(source), recipe, "png", { ...budget(), deadline: Date.now() - 1 }), /timed out/);
  await assert.rejects(renderSvgRasterBackground(sharp(source), recipe, "png", { ...budget(), signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  assert.ok((await renderSvgRasterBackground(sharp(source), recipe, "png", { ...budget(), deadline: Date.now() + 1000 })).length,
    "the valid one-second deployment timeout can still complete small SVG work");
});

test("v2 rejects non-SVG sources and SVG output before touching the cache", async () => {
  const record = { id: "not-real", storageKey: "must-not-be-read", mimeType: "image/png", size: 100 };
  await assert.rejects(getImageVariant(record, { format: "png", bg, render: "v2" }), /requires an SVG source/);
  await assert.rejects(getImageVariant({ ...record, mimeType: "image/svg+xml" }, { format: "svg", bg, render: "v2" }), /raster output format/);
});

test("fractional SVG geometry is rejected before raw allocation at ambiguous pixel boundaries", async () => {
  for (const canvas of ['width="1.1" height="10"', 'viewBox="0 0 1.1 10"', 'width="10" height="1.1"']) {
    const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${canvas}><rect width="100%" height="100%" fill="red"/></svg>`);
    const recipe = { ...(canvas.startsWith('width="10"') ? { w: 128 } : { h: 128 }), format: "png", bg, render: "v2" } as const;
    for (const limit of [1664, 1792]) {
      const image = sharp(bytes);
      let allocated = false;
      image.raw = () => { allocated = true; throw new Error("raw allocation must not be reached"); };
      await assert.rejects(renderSvgRasterBackground(image, recipe, "png", budget(limit)), error =>
        error instanceof CapacityError && error.statusCode === 422 && /output pixel limit/.test(error.message));
      assert.equal(allocated, false, `${canvas}, limit ${limit}: ambiguity rejected before raw`);
    }
    const result = await sharp(await renderSvgRasterBackground(sharp(bytes), recipe, "png", budget(4096))).metadata();
    assert.deepEqual([result.width, result.height], "w" in recipe ? [128, 14] : [14, 128]);
  }
});

test("a small cropped output cannot admit an excessive SVG loader canvas", async () => {
  let allocated = false;
  const image = {
    timeout() { return this; },
    async metadata() { return { format: "svg", width: 1, height: 100_000 }; },
    raw() { allocated = true; throw new Error("raw allocation must not be reached"); },
  } as unknown as Sharp;
  await assert.rejects(renderSvgRasterBackground(image,
    { w: 32, h: 32, fit: "cover", format: "png", bg, render: "v2" }, "png", budget()),
    error => error instanceof CapacityError && error.statusCode === 422);
  assert.equal(allocated, false);
});

test("unexpected native raw geometry or byte depth is rejected before a second pipeline", async () => {
  for (const [data, info] of [
    [Buffer.alloc(1), { width: 2, height: 2, channels: 4 }],
    [Buffer.alloc(16), { width: 4, height: 1, channels: 4 }],
  ] as const) {
    const image = {
      timeout() { return this; },
      async metadata() { return { format: "svg", width: 2, height: 2 }; },
      ensureAlpha() { return this; }, raw() { return this; },
      async toBuffer() { return { data, info }; },
    } as unknown as Sharp;
    await assert.rejects(renderSvgRasterBackground(image,
      { format: "png", bg, render: "v2" }, "png", budget(64)),
      error => error instanceof CapacityError && error.statusCode === 422);
  }
});

// The pre-VARD111 pipeline is an independent byte reference: admission may
// reject an uncertain canvas but must not rewrite accepted resize parameters.
async function previousV2(bytes: Buffer, recipe: Transformation, format: "png" | "webp" | "avif" | "jpeg") {
  let image = sharp(bytes).timeout({ seconds: 30 });
  await image.metadata();
  if (recipe.pad) image = applyImageTransformation(image, { ...recipe, bg: undefined }, undefined);
  else if (recipe.w || recipe.h) image = image.resize({ width: recipe.w, height: recipe.h,
    fit: recipe.fit ?? "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return applyImageTransformation(sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: 16_777_216,
  }).timeout({ seconds: 30 }), { format: recipe.format, q: recipe.q, bg: recipe.bg }, format).toBuffer();
}

test("admitted integer SVG outputs retain the exact encoded bytes of the previous v2 pipeline", async () => {
  const wide = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="32"><rect x="4" y="4" width="80" height="24" fill="red" fill-opacity="0.5"/></svg>');
  const geometries: Partial<Transformation>[] = [{}, { w: 48, fit: "fill" }, { h: 16, fit: "fill" }, { w: 192, fit: "fill" },
    { w: 128 }, { h: 96 }, ...(["inside", "outside", "cover", "contain", "fill"] as const).map(fit => ({ w: 128, h: 96, fit })),
    ...[0, 0.1, 12.5].map(pad => ({ w: 128, h: 96, fit: "contain", pad } as const))];
  for (const format of ["png", "webp", "avif", "jpeg"] as const) for (const geometry of geometries) {
    const recipe: Transformation = { ...geometry, format, q: 93, bg, render: "v2" };
    assert.deepEqual(await renderSvgRasterBackground(sharp(wide), recipe, format, budget()),
      await previousV2(wide, recipe, format), `${format}: ${JSON.stringify(geometry)}`);
  }
});
