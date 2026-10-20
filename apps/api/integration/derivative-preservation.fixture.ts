import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import sharp from "sharp";

type Project = { path: string; key: string };
type RunCli = (
  project: Project,
  ...args: string[]
) => Promise<{ stdout: string; stderr: string }>;

// Only the enclosing disposable private-delivery fixture supplies these services.
// Import application modules after that fixture has replaced ambient configuration.
export async function checkDerivativePreservation(
  t: TestContext,
  fixture: {
    admin: Pool;
    app: FastifyInstance;
    objects: Map<string, Buffer>;
    objectTypes: Map<string, string>;
    origin: string;
    root: string;
    key: string;
    run: RunCli;
  },
) {
  const { admin, app, objects, objectTypes, origin, root, key, run } = fixture;
  const { transformedVersionUrl } = await import("../src/transformation.js");
  const { getImageVariant } = await import("../src/image-variant.js");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const assetId = randomUUID();
  const versionId = randomUUID();
  const vardId = randomUUID();
  const itemId = randomUUID();
  const sourceKey = `preservation/${assetId}`;
  const storageKey = `originals/ws/${assetId}/${versionId}/source`;
  const spec = { w: 8, format: "png" as const };
  // Pin legacy identity independently of the production canonicalizer/key builder.
  const canonical = "w=8&fit=inside&format=png&q=80";
  const derivedKey = `derived/v1/${versionId}/${digest(Buffer.from(`v1:${canonical}`))}.png`;
  const backgroundKeys: string[] = [];
  const url = transformedVersionUrl("demo", sourceKey, versionId, spec);
  assert.equal(
    new URL(url, origin).searchParams.get("sig"),
    createHmac("sha256", "isolated-test-transform-secret-at-least-32-characters")
      .update(`demo/${sourceKey}?${canonical}`)
      .digest("base64url"),
    "legacy HMAC keeps its slug/key/spec semantics",
  );
  const project = { path: join(root, "derivative-preservation"), key };
  const output = join(project.path, "assets/variant.png");
  const lockPath = join(project.path, ".vardum.lock");
  const original = await sharp({
    create: { width: 32, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  }).png().toBuffer();
  const originalChecksum = digest(original);
  objects.set(storageKey, original);
  objectTypes.set(storageKey, "image/png");
  t.after(async () => {
    await admin.query("DELETE FROM vard WHERE id=$1", [vardId]);
    await admin.query("DELETE FROM asset WHERE id=$1", [assetId]);
    for (const objectKey of [storageKey, derivedKey, ...backgroundKeys]) {
      objects.delete(objectKey);
      objectTypes.delete(objectKey);
    }
  });
  await admin.query(
    "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws',$2,'Preservation proof','fixture','fixture')",
    [assetId, sourceKey],
  );
  await admin.query(
    "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1,'ws',$2,1,'ready',$3,'source.png','image/png',$4,$5,'fixture','fixture')",
    [versionId, assetId, storageKey, original.length, originalChecksum],
  );
  await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, assetId]);
  await admin.query(
    "INSERT INTO vard(id,workspace_id,name,created_by,updated_by) VALUES ($1,'ws','Preservation proof','fixture','fixture')",
    [vardId],
  );
  await admin.query(
    "INSERT INTO vard_item(id,workspace_id,vard_id,asset_id,output_path,transformation,created_by,updated_by) VALUES ($1,'ws',$2,$3,'assets/variant.png',$4,'fixture','fixture')",
    [itemId, vardId, assetId, JSON.stringify(spec)],
  );
  const headers = { "x-api-key": key };
  const generated = await app.inject({ url, headers });
  assert.equal(generated.statusCode, 200, generated.body);
  const currentBytes = Buffer.from(generated.rawPayload);
  assert.deepEqual(objects.get(derivedKey), currentBytes, "real renderer writes the unchanged v1 key");

  // Controlled encoder-default drift: compression changes bytes, not decoded pixels.
  // This is not a claim about any actual historical Sharp/libvips upgrade.
  const retainedBytes = await sharp(original, { animated: true, limitInputPixels: 100_000_000 })
    .resize({ width: 8, fit: "inside" })
    .png({ quality: 80, compressionLevel: 0 })
    .toBuffer();
  assert.notEqual(digest(retainedBytes), digest(currentBytes));
  assert.deepEqual(
    await sharp(retainedBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    await sharp(currentBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    "valid outputs have identical dimensions and decoded pixels",
  );
  objects.set(derivedKey, retainedBytes);
  objectTypes.set(derivedKey, "image/png");
  await mkdir(project.path);
  await writeFile(join(project.path, "vardum.json"), JSON.stringify({
    schema: 1, server: origin, workspace: "ws", vard: vardId,
  }));
  assert.equal(JSON.parse((await run(project, "pull")).stdout).changed, 1);
  const locked = await readFile(lockPath, "utf8");
  const snapshot = JSON.parse(locked);
  assert.equal(snapshot.schema, 2);
  assert.equal(snapshot.items[itemId].checksum, digest(retainedBytes));
  assert.equal(snapshot.items[itemId].downloadUrl, new URL(url, origin).href);
  assert.deepEqual(await readFile(output), retainedBytes);

  await t.test("background changes Vard identity while a frozen pinned output keeps its captured color and bytes", async () => {
    const backgroundProject = { path: join(root, "background-frozen"), key };
    const backgroundLockPath = join(backgroundProject.path, ".vardum.lock");
    const backgroundOutput = join(backgroundProject.path, "assets/variant.png");
    await mkdir(backgroundProject.path);
    await writeFile(join(backgroundProject.path, "vardum.json"), JSON.stringify({
      schema: 1, server: origin, workspace: "ws", vard: vardId,
    }));
    let captured: Buffer | undefined, backgroundLock: string | undefined, firstFingerprint: string | undefined;
    for (const bg of ["#204060", "#e0c0a0"]) {
      await admin.query("UPDATE vard_item SET transformation=$1,version_id=$2 WHERE id=$3", [JSON.stringify({ ...spec, bg }), versionId, itemId]);
      const manifest = await app.inject({ url: `/api/workspaces/ws/vards/${vardId}/manifest`, headers });
      assert.equal(manifest.statusCode, 200, manifest.body);
      const item = manifest.json().items[0];
      const backgroundCanonical = `${canonical}&bg=%23${bg.slice(1)}`;
      assert.equal(item.fingerprint, `${versionId}:${backgroundCanonical}`);
      assert.equal(item.versionId, versionId); assert.equal(item.pinned, true);
      assert.equal(item.writable, false); assert.equal(item.mimeType, "image/png");
      assert.deepEqual(item.transformation, { ...spec, bg });
      backgroundKeys.push(`derived/v1/${versionId}/${digest(Buffer.from(`v1:${backgroundCanonical}`))}.png`);
      const response = await app.inject({ url: item.downloadUrl, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await sharp(response.rawPayload).metadata()).hasAlpha, false);
      if (!captured) {
        captured = Buffer.from(response.rawPayload);
        firstFingerprint = item.fingerprint;
        assert.equal(JSON.parse((await run(backgroundProject, "pull")).stdout).changed, 1);
        backgroundLock = await readFile(backgroundLockPath, "utf8");
        const saved = JSON.parse(backgroundLock).items[itemId];
        assert.equal(saved.fingerprint, item.fingerprint);
        assert.equal(saved.checksum, digest(captured));
        assert.equal(saved.downloadUrl, new URL(item.downloadUrl, origin).href);
      } else {
        assert.notEqual(item.fingerprint, firstFingerprint);
        assert.notDeepEqual(response.rawPayload, captured, "changing only bg renders a different opaque color");
        await writeFile(backgroundOutput, "local edit before frozen restore");
        assert.equal(JSON.parse((await run(backgroundProject, "pull", "--frozen", "--force")).stdout).changed, 1);
        assert.deepEqual(await readFile(backgroundOutput), captured);
        assert.equal(await readFile(backgroundLockPath, "utf8"), backgroundLock);
      }
    }
    assert.deepEqual(objects.get(storageKey), original);
    assert.equal((await admin.query("SELECT checksum FROM asset_version WHERE id=$1", [versionId])).rows[0].checksum, originalChecksum);
    await admin.query("UPDATE vard_item SET transformation=$1,version_id=null WHERE id=$2", [JSON.stringify(spec), itemId]);
    assert.equal(await readFile(lockPath, "utf8"), locked, "background adoption leaves the existing no-background snapshot intact");
  });

  async function frozenFailure(message: RegExp) {
    await assert.rejects(run(project, "pull", "--frozen", "--force"), (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && "code" in error);
      assert.equal(error.code, 1);
      const result = JSON.parse(String(error.stderr));
      assert.match(result.error, message);
      assert.equal(result.actions.length, 1);
      assert.equal(result.actions[0].applied, false);
      return true;
    });
    assert.equal(await readFile(lockPath, "utf8"), locked);
  }

  await t.test("retained private output survives original loss without granting anonymous access", async () => {
    objects.delete(storageKey);
    assert.equal((await app.inject({ url })).statusCode, 401);
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(response.rawPayload, retainedBytes);
    assert.equal(objects.has(storageKey), false);
    assert.deepEqual(objects.get(derivedKey), retainedBytes);
    objects.set(storageKey, original);
  });

  // Frozen success below must remain possible after the live recipe is gone.
  await admin.query("DELETE FROM vard WHERE id=$1", [vardId]);
  await t.test("cache loss regenerates changed bytes; frozen force preserves file and exact lock", async () => {
    objects.delete(derivedKey);
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.rawPayload, currentBytes);
    assert.notEqual(digest(response.rawPayload), snapshot.items[itemId].checksum);
    assert.deepEqual(objects.get(storageKey), original);
    assert.deepEqual(objects.get(derivedKey), currentBytes);
    const sentinel = Buffer.from("local file must survive renderer drift");
    await writeFile(output, sentinel);
    await frozenFailure(/checksum mismatch/i);
    assert.deepEqual(await readFile(output), sentinel);
    const version = await admin.query("SELECT checksum FROM asset_version WHERE id=$1", [versionId]);
    assert.equal(version.rows[0].checksum, originalChecksum);
  });

  await t.test("restoring retained matching bytes repairs frozen delivery without a live Vard", async () => {
    objects.set(derivedKey, retainedBytes);
    const restored = await run(project, "pull", "--frozen", "--force");
    assert.equal(JSON.parse(restored.stdout).changed, 1);
    assert.deepEqual(await readFile(output), retainedBytes);
    assert.equal(await readFile(lockPath, "utf8"), locked);
  });

  await t.test("same-runtime cache-loss reconstruction matches this fixture only", async () => {
    objects.delete(derivedKey);
    const variant = await getImageVariant({ id: versionId, storageKey, mimeType: "image/png", size: original.length }, spec);
    assert.equal(variant.cacheHit, false);
    assert.deepEqual(Buffer.from(await variant.object.Body!.transformToByteArray()), currentBytes);
    assert.deepEqual(objects.get(storageKey), original);
  });

  await t.test("missing original and derivative gives non-cacheable failure and preserves frozen state", async () => {
    objects.delete(storageKey);
    objects.delete(derivedKey);
    // A public error must not inherit the successful immutable response's cache policy.
    await admin.query("UPDATE asset SET is_public=true WHERE id=$1", [assetId]);
    const unavailable = await app.inject({ url });
    assert.equal(unavailable.statusCode, 502, unavailable.body);
    assert.equal(unavailable.headers["cache-control"], "private, no-store");
    assert.equal(unavailable.json().error, "Asset content unavailable");
    assert.equal(objects.has(derivedKey), false);
    const sentinel = Buffer.from("local file must survive missing source and cache");
    await writeFile(output, sentinel);
    await frozenFailure(/502/);
    assert.deepEqual(await readFile(output), sentinel);
    assert.equal(objects.has(storageKey), false);
    assert.equal(objects.has(derivedKey), false);
  });
  console.log(`Controlled PNG encoder-default drift: retained ${digest(retainedBytes)}, current ${digest(currentBytes)}; equal pixels, legacy cache loss, frozen fail-closed, retained restore and missing-object failures verified.`);
}
