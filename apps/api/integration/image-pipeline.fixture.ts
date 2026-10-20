import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import sharp from "sharp";
import { supportedImageMimeTypes } from "@vardum/shared";

// Runs inside private-delivery's disposable database and object storage fixture.
// Import application modules only after that fixture installs isolated config.
export async function checkImagePipeline(
  t: TestContext,
  admin: Pool,
  objects: Map<string, Buffer>,
) {
  const { processAsset } = await import("../src/asset-processor.js");
  const { getImageVariant } = await import("../src/image-variant.js");
  const { thumbnailTransformation } = await import("../src/asset-thumbnail.js");
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="red"/></svg>',
  );
  const formats = [
    "avif",
    "gif",
    "jpeg",
    "png",
    "svg",
    "tiff",
    "webp",
  ] as const;
  assert.deepEqual(
    formats
      .map((format) => (format === "svg" ? "image/svg+xml" : `image/${format}`))
      .sort(),
    [...supportedImageMimeTypes].sort(),
    "every accepted image type needs an ingest/transform fixture",
  );
  const assetIds: string[] = [];
  t.after(async () => {
    await admin.query("DELETE FROM asset WHERE id = ANY($1::uuid[])", [
      assetIds,
    ]);
  });
  async function ingest(bytes: Buffer, mimeType: string) {
    const assetId = randomUUID();
    const versionId = randomUUID();
    const storageKey = `image-pipeline/${versionId}`;
    assetIds.push(assetId);
    objects.set(storageKey, bytes);
    await admin.query(
      "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws',$2,'Image fixture','fixture','fixture')",
      [assetId, storageKey],
    );
    await admin.query(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,storage_key,filename,mime_type,size,created_by,updated_by) VALUES ($1,'ws',$2,1,$3,'fixture',$4,$5,'fixture','fixture')",
      [versionId, assetId, storageKey, mimeType, bytes.length],
    );
    await processAsset({
      workspaceId: "ws",
      assetId,
      versionId,
      requestId: "image-regression",
    });
    const {
      rows: [row],
    } = await admin.query(
      "SELECT v.status,v.mime_type,v.width,v.height,v.checksum,v.error,a.current_version_id FROM asset_version v JOIN asset a ON a.id=v.asset_id WHERE v.id=$1",
      [versionId],
    );
    return { row, source: { id: versionId, storageKey, mimeType, size: bytes.length } };
  }

  for (const format of formats) {
    await t.test(
      `${format}: ingest, conversions, default format and cache`,
      async () => {
        const mimeType = format === "svg" ? "image/svg+xml" : `image/${format}`;
        const bytes =
          format === "svg" ? svg : await sharp(svg).toFormat(format).toBuffer();
        const { row, source } = await ingest(bytes, mimeType);
        assert.equal(row.status, "ready", row.error);
        assert.equal(row.mime_type, mimeType);
        assert.equal(row.width, 32);
        assert.equal(row.height, 16);
        assert.equal(
          row.checksum,
          createHash("sha256").update(bytes).digest("hex"),
        );
        assert.equal(row.current_version_id, source.id);

        for (const output of [
          "avif",
          "jpeg",
          "png",
          "webp",
          undefined,
        ] as const) {
          const transformation = { w: 8, h: 8, format: output };
          const expected = output ?? (format === "svg" ? "png" : format);
          const variant = await getImageVariant(source, transformation);
          assert.equal(variant.cacheHit, false);
          assert.equal(variant.mimeType, `image/${expected}`);
          const encoded = Buffer.from(
            await variant.object.Body!.transformToByteArray(),
          );
          const decoded = await sharp(encoded).metadata();
          assert.equal(decoded.format, expected === "avif" ? "heif" : expected);
          assert.equal(decoded.width, 8);
          assert.equal(decoded.height, 4);
          // Decode pixels as well as metadata, including the upgraded AVIF decoder.
          const pixels = await sharp(encoded).raw().toBuffer();
          assert.ok(pixels.length >= 8 * 4 * 3);
          assert.ok(pixels[0]! > 180 && pixels[1]! < 60 && pixels[2]! < 60);
          const cached = await getImageVariant(source, transformation);
          assert.equal(cached.cacheHit, true);
          assert.deepEqual(
            Buffer.from(await cached.object.Body!.transformToByteArray()),
            encoded,
          );
        }
      },
    );
  }
  await t.test("background colors have separate cached outputs and never replace the source original", async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="16" height="16" fill="red" fill-opacity="0.5"/></svg>');
    const { source } = await ingest(bytes, "image/svg+xml");
    const legacy = await getImageVariant(source, { format: "png" });
    const transparent = Buffer.from(await legacy.object.Body!.transformToByteArray());
    assert.equal((await sharp(transparent).metadata()).hasAlpha, true);
    const keys: string[] = [];
    for (const bg of ["#204060", "#e0c0a0"]) {
      const spec = { w: 32, h: 32, fit: "contain", format: "png", bg } as const;
      const result = await getImageVariant(source, spec);
      assert.equal(result.cacheHit, false);
      const encoded = Buffer.from(await result.object.Body!.transformToByteArray());
      assert.equal(result.mimeType, "image/png");
      const metadata = await sharp(encoded).metadata();
      assert.equal(metadata.hasAlpha, false);
      assert.equal(metadata.width, 32); assert.equal(metadata.height, 32);
      const rgb = bg.match(/[0-9a-f]{2}/g)!.map((channel) => parseInt(channel, 16));
      const decoded = await sharp(encoded).raw().toBuffer();
      for (const [x, y] of [[16, 2], [24, 16]]) {
        const offset = (y! * 32 + x!) * 3;
        assert.deepEqual([...decoded.subarray(offset, offset + 3)], rgb, "padding and transparent pixels use the selected color");
      }
      const hash = createHash("sha256").update(`v1:w=32&h=32&fit=contain&format=png&q=80&bg=%23${bg.slice(1)}`).digest("hex");
      const key = `derived/v1/${source.id}/${hash}.png`;
      keys.push(key);
      assert.deepEqual(objects.get(key), encoded, "background participates in the legacy v1 cache identity");
      const cached = await getImageVariant(source, spec);
      assert.equal(cached.cacheHit, true);
      assert.deepEqual(Buffer.from(await cached.object.Body!.transformToByteArray()), encoded);
    }
    assert.notEqual(keys[0], keys[1]);
    assert.notDeepEqual(objects.get(keys[0]!), objects.get(keys[1]!));
    assert.deepEqual(objects.get(source.storageKey), bytes);
    assert.equal((await admin.query("SELECT checksum FROM asset_version WHERE id=$1", [source.id])).rows[0].checksum,
      createHash("sha256").update(bytes).digest("hex"));
  });
  await t.test("automatic thumbnails shrink without enlargement; explicit transforms still enlarge", async () => {
    for (const [width, height, expectedWidth, expectedHeight] of [
      [48, 48, 48, 48], [3200, 2000, 640, 400], [100, 1000, 40, 400], [1000, 100, 640, 64],
    ]) {
      const bytes = await sharp({ create: { width: width!, height: height!, channels: 4, background: "red" } }).png().toBuffer();
      const { source } = await ingest(bytes, "image/png");
      const result = await getImageVariant(source, thumbnailTransformation({ width: width!, height: height! }));
      const decoded = await sharp(Buffer.from(await result.object.Body!.transformToByteArray())).metadata();
      assert.equal(decoded.width, expectedWidth);
      assert.equal(decoded.height, expectedHeight);
      if (width === 48) {
        const enlarged = await getImageVariant(source, { w: 96, h: 96, format: "png" });
        const metadata = await sharp(Buffer.from(await enlarged.object.Body!.transformToByteArray())).metadata();
        assert.equal(metadata.width, 96);
      }
    }
    assert.deepEqual(thumbnailTransformation({ width: null, height: null }), { format: "webp", q: 72 });
  });

  for (const [name, bytes, mimeType] of [
    ["invalid image", Buffer.from("not an image"), "image/png"],
    ["declared type mismatch", svg, "image/jpeg"],
    [
      "pixel limit",
      Buffer.from(
        svg
          .toString()
          .replace('width="32" height="16"', 'width="10001" height="10001"'),
      ),
      "image/svg+xml",
    ],
  ] as const) {
    await t.test(`${name}: fails without becoming current`, async () => {
      const { row } = await ingest(bytes, mimeType);
      assert.equal(row.status, "failed");
      assert.ok(row.error);
      assert.equal(row.current_version_id, null);
    });
  }
}
