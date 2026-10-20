import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { applyImageTransformation } from "./image-transform.js";

// Wide transparent canvas, with separate semitransparent and opaque regions.
// Samples stay well inside each region so lossy encoders can be checked fairly.
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="32"><rect x="32" width="32" height="32" fill="red" fill-opacity="0.5"/><rect x="64" width="32" height="32" fill="blue"/></svg>');
const formats = ["png", "webp", "avif", "jpeg"] as const;
const background = "#204060";

async function grayscaleAlphaPng() {
  const data = Buffer.alloc(96 * 32 * 2);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 96; x++) {
    const offset = (y * 96 + x) * 2;
    data[offset] = x < 32 ? 0 : x < 64 ? 128 : 240;
    data[offset + 1] = x < 32 ? 0 : x < 64 ? 128 : 255;
  }
  return sharp(data, { raw: { width: 96, height: 32, channels: 2 } })
    .toColourspace("b-w").png().toBuffer();
}

async function pixels(encoded: Buffer, allowOpaqueAlpha = false) {
  const metadata = await sharp(encoded).metadata();
  if (!allowOpaqueAlpha) assert.equal(metadata.hasAlpha, false, "static opaque outputs must remove the alpha channel");
  const { data, info } = await sharp(encoded).raw().toBuffer({ resolveWithObject: true });
  if (allowOpaqueAlpha && info.channels === 4) {
    for (let offset = 3; offset < data.length; offset += 4) assert.equal(data[offset], 255, "every animated pixel must be opaque");
  } else assert.equal(info.channels, 3);
  return {
    width: info.width, height: info.height,
    at(x: number, y: number, expected: number[], tolerance = 3) {
      const offset = (y * info.width + x) * info.channels;
      const actual = [...data.subarray(offset, offset + 3)];
      assert.ok(actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance),
        `pixel (${x}, ${y}): expected ${expected}, received ${actual}`);
    },
  };
}

for (const inputFormat of ["svg", "png"] as const) {
  for (const format of formats) {
    test(`${inputFormat} to ${format}: background fills transparent pixels and contain padding without alpha`, async () => {
      const source = inputFormat === "svg" ? svg : await sharp(svg).png().toBuffer();
      const encoded = await applyImageTransformation(sharp(source), {
        w: 96, h: 96, fit: "contain", format, q: 100, bg: background,
      }, format).toBuffer();
      const decoded = await pixels(encoded);
      assert.equal(decoded.width, 96);
      assert.equal(decoded.height, 96);
      const tolerance = format === "png" ? 1 : 8;
      decoded.at(48, 16, [32, 64, 96], tolerance); // top canvas padding
      decoded.at(48, 80, [32, 64, 96], tolerance); // bottom canvas padding
      decoded.at(16, 48, [32, 64, 96], tolerance); // transparent source pixels
      decoded.at(48, 48, [144, 32, 48], tolerance); // red over the selected color
      decoded.at(80, 48, [0, 0, 255], tolerance); // opaque artwork is retained
    });
  }
}

for (const format of formats) {
  test(`grayscale-alpha PNG to ${format}: RGB background stays colored before flattening and canvas padding`, async () => {
    const source = await grayscaleAlphaPng();
    const metadata = await sharp(source).metadata();
    assert.equal(metadata.space, "b-w");
    assert.equal(metadata.channels, 2);
    assert.equal(metadata.hasAlpha, true);
    const encoded = await applyImageTransformation(sharp(source), {
      w: 96, h: 96, fit: "contain", format, q: 100, bg: background,
    }, format).toBuffer();
    const decoded = await pixels(encoded);
    assert.equal(decoded.width, 96); assert.equal(decoded.height, 96);
    const tolerance = format === "png" ? 1 : 8;
    decoded.at(48, 16, [32, 64, 96], tolerance);
    decoded.at(16, 48, [32, 64, 96], tolerance);
    decoded.at(48, 48, [80, 96, 112], tolerance);
    decoded.at(80, 48, [240, 240, 240], tolerance);
  });
}

test("a format and background alone preserve source dimensions and make every pixel opaque", async () => {
  const encoded = await applyImageTransformation(sharp(svg), { format: "png", bg: background }, "png").toBuffer();
  const decoded = await pixels(encoded);
  assert.equal(decoded.width, 96);
  assert.equal(decoded.height, 32);
  decoded.at(16, 16, [32, 64, 96]);
  decoded.at(48, 16, [144, 32, 48]);
});

test("without bg, the legacy resize/encode pipeline produces the same bytes and retains PNG transparency", async () => {
  for (const input of [await sharp(svg).png().toBuffer(), await grayscaleAlphaPng()]) for (const format of [...formats, undefined]) {
    const transformation = { w: 48, h: 48, fit: "contain", format } as const;
    let legacy = sharp(input).resize({ width: 48, height: 48, fit: "contain" });
    if (format) legacy = legacy.toFormat(format, { quality: 80 });
    const expected = await legacy.toBuffer();
    const actual = await applyImageTransformation(sharp(input), transformation, format).toBuffer();
    assert.deepEqual(actual, expected, `${format ?? "source format"} bytes must not change`);
    if (format === "png" || !format) assert.equal((await sharp(actual).metadata()).hasAlpha, true);
  }
});

test("animated contain output flattens every frame and keeps its frame geometry", async () => {
  const width = 32, pageHeight = 16;
  const frameBytes = Buffer.alloc(width * pageHeight * 4 * 2);
  for (let frame = 0; frame < 2; frame++) {
    for (let pixel = 0; pixel < width * pageHeight; pixel++) {
      const offset = (frame * width * pageHeight + pixel) * 4;
      frameBytes[offset + frame] = 255;
      frameBytes[offset + 3] = 128;
    }
  }
  const source = await sharp(frameBytes, { raw: { width, height: pageHeight * 2, channels: 4, pageHeight } })
    .webp({ lossless: true, delay: [100, 200], loop: 0 }).toBuffer();
  const encoded = await applyImageTransformation(sharp(source, { animated: true }), {
    w: 32, h: 32, fit: "contain", format: "webp", q: 100, bg: background,
  }, "webp").toBuffer();
  const metadata = await sharp(encoded, { animated: true }).metadata();
  assert.equal(metadata.pages, 2);
  assert.equal(metadata.pageHeight, 32);
  assert.equal(metadata.width, 32);
  assert.deepEqual(metadata.delay, [100, 200]);
  // Animated WebP may encode transparent subframes for unchanged regions, even
  // though the fully decoded frames are opaque. Check all decoded alpha values.
  for (const [page, expected] of [[0, [144, 32, 48]], [1, [16, 160, 48]]] as const) {
    const decoded = await pixels(await sharp(encoded, { page }).png().toBuffer(), true);
    decoded.at(16, 2, [32, 64, 96], 8);
    decoded.at(16, 16, [...expected], 8);
  }
});
