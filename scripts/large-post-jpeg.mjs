// Seeded 4 MP photograph-like JPEG, with legal COM segments whose long CR runs
// exercise the retained-CR + 64 KiB chunk bug in RustFS 1.0.0's POST parser.
// Keep this separate from smoke-resource-budgets' unchanged random JPEG.
export async function createLargePostJpeg(sharp) {
  let seed = 0x939a84e;
  const raw = Buffer.alloc(2048 * 2048 * 3);
  for (let index = 0; index < raw.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    raw[index] = seed & 255;
  }
  const jpeg = await sharp(raw, {
    raw: { width: 2048, height: 2048, channels: 3 },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  // COM length includes the two length bytes, so 0xffff permits 65,533 payload
  // bytes. The two marker bytes make each complete segment 65,537 bytes.
  const comment = Buffer.alloc(65_537, 13);
  comment[0] = 0xff;
  comment[1] = 0xfe;
  comment.writeUInt16BE(0xffff, 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    ...Array(8).fill(comment),
    jpeg.subarray(2),
  ]);
}
