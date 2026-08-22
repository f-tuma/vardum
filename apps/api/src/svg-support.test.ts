import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { detectMimeType, supportedImageMimeTypes } from "./asset-processor.js";

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60"/></svg>',
);

test("SVG uploads are detected and rasterize to bounded PNG variants", async () => {
  const metadata = await sharp(svg, {
    limitInputPixels: 100_000_000,
  }).metadata();
  assert.equal(metadata.format, "svg");
  assert.equal(
    detectMimeType(metadata.format, "image/svg+xml"),
    "image/svg+xml",
  );
  assert.ok(supportedImageMimeTypes.includes("image/svg+xml"));

  const png = await sharp(svg).resize({ width: 64 }).png().toBuffer();
  const variant = await sharp(png).metadata();
  assert.equal(variant.format, "png");
  assert.deepEqual([variant.width, variant.height], [64, 32]);
});
