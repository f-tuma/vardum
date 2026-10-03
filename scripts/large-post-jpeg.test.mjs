import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createLargePostJpeg } from "./large-post-jpeg.mjs";

const sharp = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
)("sharp");

test("large POST regression is a deterministic, decodable 4 MP JPEG with legal CR comments", async () => {
  const bytes = await createLargePostJpeg(sharp);
  assert.deepEqual(await createLargePostJpeg(sharp), bytes);
  assert.ok(bytes.length > 3 * 1024 ** 2 && bytes.length < 25 * 1024 ** 2);
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  let offset = 2;
  for (let index = 0; index < 8; index++) {
    assert.equal(bytes.readUInt16BE(offset), 0xfffe);
    const length = bytes.readUInt16BE(offset + 2);
    assert.equal(length, 65_535);
    assert.ok(bytes.subarray(offset + 4, offset + 2 + length).every((byte) => byte === 13));
    offset += 2 + length;
  }
  const baseline = Buffer.concat([bytes.subarray(0, 2), bytes.subarray(offset)]);
  const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 2048);
  assert.equal(decoded.info.height, 2048);
  assert.equal(decoded.info.channels, 3);
  assert.equal(decoded.data.length, 2048 * 2048 * 3);
  // Decode every pixel, not just JPEG metadata: the inserted comments must not
  // corrupt the encoded image or turn the regression into an invalid-file case.
  assert.deepEqual(decoded.data, await sharp(baseline).raw().toBuffer());
});
