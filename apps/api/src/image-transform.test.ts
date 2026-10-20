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


for (const format of formats) {
  test(`${format}: padding keeps an exact canvas, centers the complete source and uses the selected background`, async () => {
    const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="red"/><rect x="20" width="20" height="20" fill="blue"/></svg>');
    const encoded = await applyImageTransformation(sharp(source), {
      w: 100, h: 80, fit: "contain", format, q: 100, bg: background, pad: 25,
    }, format).toBuffer();
    const decoded = await pixels(encoded);
    assert.equal(decoded.width, 100); assert.equal(decoded.height, 80);
    // The shorter side is 80: 20 px on every edge, with a 60×40 inner box.
    // A 2:1 source is centered in that box as a 60×30 mark at (20, 25).
    decoded.at(10, 40, [32, 64, 96], 8); decoded.at(90, 40, [32, 64, 96], 8);
    decoded.at(50, 10, [32, 64, 96], 8); decoded.at(50, 70, [32, 64, 96], 8);
    decoded.at(30, 40, [255, 0, 0], 10); decoded.at(70, 40, [0, 0, 255], 10);
  });
}

test("padding without a background preserves source alpha and introduces transparent margins", async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red" fill-opacity="0.5"/></svg>');
  for (const format of ["png", "webp", "avif"] as const) {
    const encoded = await applyImageTransformation(sharp(source), { w: 100, h: 80, fit: "contain", format, q: 100, pad: 25 }, format).toBuffer();
    const { data, info } = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 100); assert.equal(info.height, 80);
    for (const [x, y] of [[10, 40], [90, 40], [50, 10], [50, 70]]) assert.equal(data[(y! * 100 + x!) * 4 + 3], 0, `${format}: padding alpha`);
    assert.ok(Math.abs(data[(40 * 100 + 50) * 4 + 3]! - 128) <= 1, `${format}: source alpha`);
  }
});

test("padding rounds down on small outputs and never erases the inner canvas", async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  for (const [w, h, pad, inset] of [[1, 1, 45, 0], [2, 3, 45, 0], [3, 3, 45, 1], [17, 13, 15, 1]]) {
    const encoded = await applyImageTransformation(sharp(source), { w, h, fit: "contain", format: "png", q: 100, bg: background, pad }, "png").toBuffer();
    const decoded = await pixels(encoded);
    assert.equal(decoded.width, w); assert.equal(decoded.height, h);
    decoded.at(Math.floor(w! / 2), Math.floor(h! / 2), [255, 0, 0], 3);
    if (inset) decoded.at(0, 0, [32, 64, 96]);
  }
});

test("zero padding produces the exact existing bytes with and without a background", async () => {
  for (const bg of [undefined, background]) for (const format of formats) {
    const spec = { w: 48, h: 48, fit: "contain", format, bg } as const;
    const original = await applyImageTransformation(sharp(svg), spec, format).toBuffer();
    const zero = await applyImageTransformation(sharp(svg), { ...spec, pad: 0 }, format).toBuffer();
    assert.deepEqual(zero, original, `${format}, bg ${bg}`);
  }
});

test("padding preserves every animation frame, timing and opaque or transparent margins", async () => {
  const width = 32, pageHeight = 16;
  const frameBytes = Buffer.alloc(width * pageHeight * 4 * 2);
  for (let frame = 0; frame < 2; frame++) for (let pixel = 0; pixel < width * pageHeight; pixel++) {
    const offset = (frame * width * pageHeight + pixel) * 4;
    frameBytes[offset + frame] = 255; frameBytes[offset + 3] = 128;
  }
  const source = await sharp(frameBytes, { raw: { width, height: pageHeight * 2, channels: 4, pageHeight } })
    .webp({ lossless: true, delay: [100, 200], loop: 0 }).toBuffer();
  for (const bg of [undefined, background]) {
    const encoded = await applyImageTransformation(sharp(source, { animated: true }), {
      w: 32, h: 32, fit: "contain", format: "webp", q: 100, pad: 12, bg,
    }, "webp").toBuffer();
    const metadata = await sharp(encoded, { animated: true }).metadata();
    assert.equal(metadata.pages, 2); assert.equal(metadata.pageHeight, 32); assert.equal(metadata.width, 32);
    assert.equal(metadata.loop, 0); assert.deepEqual(metadata.delay, [100, 200]);
    for (let page = 0; page < 2; page++) {
      const { data, info } = await sharp(encoded, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 32); assert.equal(info.height, 32);
      assert.equal(data[3], bg ? 255 : 0);
      const center = (16 * 32 + 16) * 4;
      assert.ok(Math.abs(data[center + 3]! - (bg ? 255 : 128)) <= 1);
      assert.ok(data[center + page]! > data[center + (page ? 0 : 1)]! + 75, "frames retain their distinct colors");
      if (bg) for (let alpha = 3; alpha < data.length; alpha += 4) assert.equal(data[alpha], 255);
    }
  }
});


test("padded grayscale-alpha sources retain colored margins and composite transparency inside the source bounds", async () => {
  const source = await grayscaleAlphaPng();
  const encoded = await applyImageTransformation(sharp(source), {
    w: 96, h: 96, fit: "contain", format: "png", q: 100, bg: background, pad: 25,
  }, "png").toBuffer();
  const decoded = await pixels(encoded);
  assert.equal(decoded.width, 96); assert.equal(decoded.height, 96);
  decoded.at(12, 48, [32, 64, 96]);
  decoded.at(32, 48, [32, 64, 96]);
  decoded.at(48, 48, [80, 96, 112]);
  decoded.at(64, 48, [240, 240, 240]);
});
