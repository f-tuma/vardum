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
