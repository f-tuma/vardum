import assert from "node:assert/strict";
import { mutateLegacyVersion } from "./legacy-version.fixture.js";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import sharp from "sharp";

// Runs only inside private-delivery's isolated DB and fake object storage.
export async function checkSvgDerivatives(t: TestContext, admin: Pool, objects: Map<string, Buffer>, app: FastifyInstance) {
  const { canonicalizeTransformation, transformedVersionUrl } = await import("../src/transformation.js");
  const { getImageVariant } = await import("../src/image-variant.js");
  const assetId = randomUUID(), versionId = randomUUID(), vardId = randomUUID(), itemId = randomUUID();
  const key = `svg-derivatives/${assetId}`, storageKey = `svg-derivatives/${versionId}`;
  const source = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><!-- untouched original --><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><g transform="translate(4 8)"><g id="neutral-arm"><path fill="#050507" d="M0 0H16V24H0Z"/></g><g id="accent-arm"><rect x="16" width="16" height="24" fill="#c8553d"/></g></g></svg>');
  objects.set(storageKey, source);
  const sourceRecord = { id: versionId, storageKey, mimeType: "image/svg+xml", size: source.length };
  const recipe = { format: "svg", darkLayer: "neutral-arm", darkColor: "#e8e4d9" } as const;
  const canonical = "format=svg&darkLayer=neutral-arm&darkColor=%23e8e4d9";
  assert.equal(canonicalizeTransformation(recipe), canonical);
  const derivedKey = `derived/v1/${versionId}/${createHash("sha256").update(`v1:${canonical}`).digest("hex")}.svg`;
  t.after(async () => {
    await admin.query("DELETE FROM vard WHERE id=$1", [vardId]);
    await admin.query("DELETE FROM asset WHERE id=$1", [assetId]);
    for (const objectKey of objects.keys()) if (objectKey === storageKey || objectKey.startsWith(`derived/v1/${versionId}/`)) objects.delete(objectKey);
  });
  await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) VALUES ($1,'ws',$2,'SVG master',true,'fixture','fixture')", [assetId, key]);
  await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,width,height,created_by,updated_by) VALUES ($1,'ws',$2,1,'ready',$3,'master.svg','image/svg+xml',$4,$5,48,48,'fixture','fixture')", [versionId, assetId, storageKey, source.length, createHash("sha256").update(source).digest("hex")]);
  await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, assetId]);
  await admin.query("INSERT INTO vard(id,workspace_id,name,is_public,created_by,updated_by) VALUES ($1,'ws','SVG derivatives',true,'fixture','fixture')", [vardId]);
  await admin.query("INSERT INTO vard_item(id,workspace_id,vard_id,asset_id,output_path,transformation,created_by,updated_by) VALUES ($1,'ws',$2,$3,'brand/favicon.svg',$4,'fixture','fixture')", [itemId, vardId, assetId, JSON.stringify(recipe)]);
  const originalUrl = `/w/demo/__v/${versionId}/${key}`;
  const original = await app.inject({ url: originalUrl });
  assert.equal(original.statusCode, 200, original.body);
  assert.deepEqual(original.rawPayload, source, "no transformation preserves exact raw source bytes");
  const url = transformedVersionUrl("demo", key, versionId, recipe);
  const generated = await app.inject({ url });
  assert.equal(generated.statusCode, 200, generated.body);
  assert.match(String(generated.headers["content-type"]), /^image\/svg\+xml/);
  assert.match(String(generated.headers["content-disposition"]), /master\.svg/);
  assert.match(String(generated.headers["content-security-policy"]), /default-src 'none';.*style-src 'unsafe-inline'; sandbox/);
  assert.equal(generated.headers["x-content-type-options"], "nosniff");
  assert.match(generated.body, /prefers-color-scheme: dark/);
  assert.deepEqual(objects.get(derivedKey), generated.rawPayload, "SVG uses the canonical v1 key with its svg extension");
  const cached = await getImageVariant(sourceRecord, recipe);
  assert.equal(cached.cacheHit, true);
  assert.deepEqual(Buffer.from(await cached.object.Body!.transformToByteArray()), generated.rawPayload);
  const firstManifest = await app.inject({ url: `/v/${vardId}` });
  assert.equal(firstManifest.statusCode, 200, firstManifest.body);
  assert.equal(firstManifest.json().items[0].mimeType, "image/svg+xml");
  assert.equal(firstManifest.json().items[0].fingerprint, `${versionId}:${canonical}`);
  await admin.query("UPDATE vard_item SET transformation=$1 WHERE id=$2", [JSON.stringify({ ...recipe, darkColor: "#ffffff" }), itemId]);
  const changedManifest = await app.inject({ url: `/v/${vardId}` });
  assert.notEqual(changedManifest.json().items[0].fingerprint, firstManifest.json().items[0].fingerprint);
  assert.deepEqual((await app.inject({ url })).rawPayload, generated.rawPayload, "captured SVG URL keeps its old recipe bytes");
  for (const layer of ["neutral-arm", "accent-arm"]) {
    const spec = { w: 48, h: 48, fit: "contain", format: "png", layer } as const;
    const rendered = await getImageVariant(sourceRecord, spec);
    assert.equal(rendered.cacheHit, false); assert.equal(rendered.mimeType, "image/png");
    const bytes = Buffer.from(await rendered.object.Body!.transformToByteArray());
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 48); assert.equal(info.height, 48);
    assert.equal(data[(16 * 48 + (layer === "neutral-arm" ? 8 : 24)) * 4 + 3], 255);
    assert.equal(data[(16 * 48 + (layer === "neutral-arm" ? 24 : 8)) * 4 + 3], 0);
    assert.equal((await getImageVariant(sourceRecord, spec)).cacheHit, true);
  }
  for (const spec of [{ format: "svg", layer: "missing" }, { format: "png", layer: "missing" }] as const) {
    const response = await app.inject({ url: transformedVersionUrl("demo", key, versionId, spec) });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
  const background = { w: 180, h: 180, fit: "contain", format: "png", q: 100, pad: 14, bg: "#204060" } as const;
  const v2 = { ...background, render: "v2" } as const;
  const legacyUrl = transformedVersionUrl("demo", key, versionId, background);
  const v2Url = transformedVersionUrl("demo", key, versionId, v2);
  const legacyRaster = await app.inject({ url: legacyUrl }), v2Raster = await app.inject({ url: v2Url });
  assert.equal(legacyRaster.statusCode, 200, legacyRaster.body);
  assert.equal(v2Raster.statusCode, 200, v2Raster.body);
  assert.notDeepEqual(v2Raster.rawPayload, legacyRaster.rawPayload, "v2 does not reuse the legacy derivative");
  for (const spec of [background, v2]) {
    const identity = canonicalizeTransformation(spec);
    const cacheKey = `derived/v1/${versionId}/${createHash("sha256").update(`v1:${identity}`).digest("hex")}.png`;
    const hit = await getImageVariant(sourceRecord, spec);
    assert.equal(hit.cacheHit, true);
    assert.ok(objects.has(cacheKey), "each signed render identity has its own stored object");
  }
  const tampered = new URL(v2Url, "https://example.test"); tampered.searchParams.delete("render");
  assert.equal((await app.inject({ url: tampered.pathname + tampered.search })).statusCode, 403);
  await admin.query("UPDATE vard_item SET transformation=$1 WHERE id=$2", [JSON.stringify(background), itemId]);
  const legacyFingerprint = (await app.inject({ url: `/v/${vardId}` })).json().items[0].fingerprint;
  await admin.query("UPDATE vard_item SET transformation=$1 WHERE id=$2", [JSON.stringify(v2), itemId]);
  const v2Fingerprint = (await app.inject({ url: `/v/${vardId}` })).json().items[0].fingerprint;
  assert.equal(v2Fingerprint, `${legacyFingerprint}&render=v2`);
  assert.deepEqual((await app.inject({ url: legacyUrl })).rawPayload, legacyRaster.rawPayload, "captured legacy URLs retain their bytes after upgrading the recipe");
  // A source type guard runs even before an already stored SVG derivative hit.
  await mutateLegacyVersion(admin, "UPDATE asset_version SET mime_type='image/png' WHERE id=$1", [versionId]);
  assert.equal((await app.inject({ url })).statusCode, 422);
  assert.equal((await app.inject({ url: v2Url })).statusCode, 422, "v2 source validation precedes its existing cache hit");
  await mutateLegacyVersion(admin, "UPDATE asset_version SET mime_type='image/svg+xml' WHERE id=$1", [versionId]);
  const unsafe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><script>alert(1)</script></svg>');
  objects.set(storageKey, unsafe);
  const rejected = await app.inject({ url: transformedVersionUrl("demo", key, versionId, { format: "svg", w: 32 }) });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.headers["cache-control"], "private, no-store");
  assert.deepEqual((await app.inject({ url: originalUrl })).rawPayload, unsafe, "raw delivery keeps its existing original contract");
  objects.delete(storageKey);
  assert.deepEqual((await app.inject({ url })).rawPayload, generated.rawPayload, "retained cached SVG remains usable without rereading its original");
}
