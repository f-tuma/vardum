import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export async function checkUploadIntegrity(t: TestContext, fixture: {
  admin: Pool;
  app: FastifyInstance;
  objects: Map<string, Buffer>;
  keyHeaders: Record<string, Record<string, string>>;
  setWriteHook: (hook: (key: string, bytes: Buffer) => Promise<void>) => void;
}) {
  const { admin, app, objects, keyHeaders, setWriteHook } = fixture;
  const { processAsset } = await import("../src/asset-processor.js");
  const { cleanupUploadObjects } = await import("../src/upload-objects.js");
  const { inWorkspace } = await import("../src/db/tenant.js");
  const { workspaceUsage } = await import("../src/upload-lifecycle.js");
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>');
  const changed = Buffer.from(bytes.toString().replace("red", "tan"));
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const assets: string[] = [];
  const versions: string[] = [];
  const workspaces: string[] = [];
  // Isolate this maintenance fixture from thousands of earlier legacy fixtures.
  // Restore their timestamps afterwards; every invocation still uses the real
  // bounded global worker path rather than a test-only production filter.
  const priorLedger = (await admin.query("SELECT version_id,sweep_at,sweep_attempt_at FROM asset_upload")).rows;
  await admin.query("UPDATE asset_upload SET sweep_at=now()+interval '1 year'");
  const state = async (id: string) => (await admin.query("SELECT * FROM asset_version WHERE id=$1", [id])).rows[0];
  const usage = () => inWorkspace("ws", tx => workspaceUsage(tx, "ws"));
  const sweep = (offset = 0) => cleanupUploadObjects(new Date(Date.now() + offset), 10_000);
  async function seed(expected: string | null = null) {
    const assetId = randomUUID(), versionId = randomUUID();
    assets.push(assetId); versions.push(versionId);
    const key = `integrity/${assetId}`;
    const stage = `originals/ws/${assetId}/${versionId}/source`;
    await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,'ws',$2,'Integrity','fixture','fixture')", [assetId, key]);
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,expected_checksum,created_by,updated_by) VALUES($1,'ws',$2,1,'processing',$3,'fixture.svg','image/svg+xml',$4,$5,'fixture','fixture')", [versionId, assetId, stage, bytes.length, expected]);
    objects.set(stage, bytes);
    return { workspaceId: "ws", assetId, versionId, requestId: "upload-integrity", stage, key };
  }
  t.beforeEach(() => setWriteHook(async () => {}));
  t.after(async () => {
    setWriteHook(async () => {});
    await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [assets]);
    await admin.query("DELETE FROM asset_upload WHERE version_id=ANY($1::uuid[])", [versions]);
    await admin.query("DELETE FROM workspace WHERE id=ANY($1::text[])", [workspaces]);
    await admin.query("UPDATE asset_upload u SET sweep_at=p.sweep_at,sweep_attempt_at=p.sweep_attempt_at FROM jsonb_to_recordset($1::jsonb) AS p(version_id uuid,sweep_at timestamptz,sweep_attempt_at timestamptz) WHERE u.version_id=p.version_id", [JSON.stringify(priorLedger)]);
    for (const key of objects.keys()) if (assets.some(id => key.startsWith(`originals/ws/${id}/`))) objects.delete(key);
  });

  await t.test("publishes the validated Buffer, not a later stage; replay/archive/sweeps preserve delivery and quota", async () => {
    const item = await seed(digest(bytes));
    const beforeUsage = await usage();
    setWriteHook(async key => { if (key.includes("/sealed/")) objects.set(item.stage, changed); });
    await processAsset(item);
    setWriteHook(async () => {});
    const ready = await state(item.versionId);
    assert.equal(ready.status, "ready");
    assert.notEqual(ready.storage_key, item.stage);
    assert.deepEqual(objects.get(ready.storage_key), bytes);
    assert.equal(ready.checksum, digest(bytes));
    assert.equal(ready.upload_cleaned_at, null);
    const delivered = await app.inject({ url: `/w/demo/__v/${item.versionId}/${item.key}`, headers: keyHeaders.read });
    assert.equal(delivered.statusCode, 200, delivered.body);
    assert.deepEqual(delivered.rawPayload, bytes);
    await admin.query("UPDATE asset SET archived_at=now() WHERE id=$1", [item.assetId]);
    await sweep();
    assert.ok(!objects.has(item.stage));
    objects.set(item.stage, changed); // same unexpired form can recreate stage
    await sweep(86400_001);
    assert.ok(!objects.has(item.stage));
    assert.deepEqual(objects.get(ready.storage_key), bytes);
    assert.equal((await usage()).reservedBytes, beforeUsage.reservedBytes);
    assert.equal((await state(item.versionId)).upload_cleaned_at, null);
    assert.equal((await state(item.versionId)).checksum, digest(bytes));
  });

  await t.test("late PUT of a superseded attempt cannot overwrite the winner", async () => {
    const item = await seed();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let firstKey = "";
    setWriteHook(async key => {
      if (!firstKey && key.includes("/sealed/")) { firstKey = key; entered(); await gate; }
    });
    const stale = processAsset(item);
    try {
      await waiting;
      objects.set(item.stage, changed);
      await processAsset(item);
      const winner = await state(item.versionId);
      assert.equal(winner.status, "ready");
      assert.equal(winner.checksum, digest(changed));
      assert.notEqual(winner.storage_key, firstKey);
      release();
      await stale;
      assert.deepEqual(objects.get(winner.storage_key), changed);
      assert.deepEqual(objects.get(firstKey), bytes);
      await sweep(2 * 86400_001);
      assert.ok(!objects.has(firstKey));
      assert.deepEqual(objects.get(winner.storage_key), changed);
    } finally { release(); await stale; }
  });

  await t.test("crash candidate is swept while retry stage stays; failed PUT never becomes ready", async () => {
    const item = await seed();
    let candidate = "";
    setWriteHook(async key => {
      if (key.includes("/sealed/")) {
        candidate = key;
        await admin.query("UPDATE asset_version SET status='failed',retryable=true,ingest_attempt_id=NULL WHERE id=$1", [item.versionId]);
      }
    });
    await processAsset(item);
    setWriteHook(async () => {});
    assert.equal((await state(item.versionId)).storage_key, item.stage);
    await sweep(3 * 86400_001);
    assert.ok(!objects.has(candidate));
    assert.deepEqual(objects.get(item.stage), bytes);
    await admin.query("UPDATE asset_version SET status='processing' WHERE id=$1", [item.versionId]);
    setWriteHook(async () => { throw new Error("storage failure"); });
    await assert.rejects(processAsset(item));
    assert.equal((await state(item.versionId)).status, "processing");
    assert.equal((await state(item.versionId)).storage_key, item.stage);
  });

  await t.test("ledger survives delete and sweeps late stage/candidates without allowing UUID resurrection", async () => {
    const item = await seed();
    await admin.query("DELETE FROM asset WHERE id=$1", [item.assetId]);
    const candidate = `originals/ws/${item.assetId}/${item.versionId}/sealed/${randomUUID()}/source`;
    objects.set(candidate, bytes);
    await sweep(4 * 86400_001);
    assert.ok(!objects.has(candidate)); assert.ok(!objects.has(item.stage));
    objects.set(item.stage, changed); objects.set(candidate, changed);
    await sweep(5 * 86400_001);
    assert.ok(!objects.has(candidate)); assert.ok(!objects.has(item.stage));
    await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,'ws',$2,'Reused','fixture','fixture')", [item.assetId, item.key]);
    await assert.rejects(admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,created_by,updated_by) VALUES($1,'ws',$2,1,'ready',$3,'fixture.svg','image/svg+xml',$4,'fixture','fixture')", [item.versionId, item.assetId, item.stage, bytes.length]), /asset_upload_pkey/);
  });

  await t.test("database rejects old worker publication, re-opening ready and content mutation", async () => {
    const item = await seed();
    await assert.rejects(admin.query("UPDATE asset_version SET status='ready',checksum=$2 WHERE id=$1", [item.versionId, digest(bytes)]), /must be sealed/);
    await processAsset(item);
    for (const change of ["status='pending'", "status='processing'", "storage_key=storage_key||'-changed'", "checksum='changed'", "size=size+1", "mime_type='image/png'", "asset_id=gen_random_uuid()"])
      await assert.rejects(admin.query(`UPDATE asset_version SET ${change} WHERE id=$1`, [item.versionId]), /immutable/);
    const denied = await app.inject({ method: "POST", url: `/api/workspaces/ws/assets/${item.assetId}/versions`, headers: keyHeaders.write,
      payload: { id: item.versionId, filename: "fixture.svg", mimeType: "image/svg+xml", size: bytes.length, expectedChecksum: digest(bytes), expectedCurrentVersionId: item.versionId } });
    // Fixture seed had no planned checksum; conflicting identity must not yield any grant.
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().upload, undefined);
  });

  await t.test("shortened stage and wrong checksum cannot publish an object", async () => {
    for (const kind of ["short", "checksum"]) {
      const item = await seed(kind === "checksum" ? "f".repeat(64) : null);
      if (kind === "short") objects.set(item.stage, bytes.subarray(0, bytes.length - 1));
      await processAsset(item);
      const row = await state(item.versionId);
      assert.equal(row.status, "failed"); assert.equal(row.retryable, false);
      assert.equal(row.storage_key, item.stage);
      assert.equal([...objects.keys()].some(key => key.startsWith(`originals/ws/${item.assetId}/${item.versionId}/sealed/`)), false);
    }
  });

  await t.test("tenant-private ledger and fair cleanup discover deleted scopes behind 100 pending workspaces", async () => {
    const suffix = randomUUID();
    for (let index = 0; index < 100; index++) {
      const ws = `a-integrity-${suffix}-${index.toString().padStart(3, "0")}`;
      const assetId = randomUUID(), versionId = randomUUID();
      workspaces.push(ws); assets.push(assetId); versions.push(versionId);
      await admin.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES($1,'org','Fair cleanup',$1,'fixture','fixture')", [ws]);
      await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,$2,'pending','Pending','fixture','fixture')", [assetId, ws]);
      await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,storage_key,filename,mime_type,size,created_by,updated_by) VALUES($1,$2,$3,1,$4,'fixture.svg','image/svg+xml',$5,'fixture','fixture')", [versionId, ws, assetId, `originals/${ws}/${assetId}/${versionId}/source`, bytes.length]);
    }
    const deletedVersion = randomUUID(), deletedAsset = randomUUID();
    const deletedStage = `originals/z-integrity-${suffix}/${deletedAsset}/${deletedVersion}/source`;
    versions.push(deletedVersion);
    await admin.query("INSERT INTO asset_upload(version_id,workspace_id,asset_id,storage_key) VALUES($1,$2,$3,$4)", [deletedVersion, `z-integrity-${suffix}`, deletedAsset, deletedStage]);
    objects.set(deletedStage, bytes);
    const { pool } = await import("../src/db/index.js");
    assert.equal((await pool.query("SELECT * FROM asset_upload WHERE version_id=$1", [deletedVersion])).rowCount, 0);
    const hidden = await inWorkspace("ws", tx => tx.execute("SELECT * FROM asset_upload WHERE workspace_id LIKE 'z-integrity-%'"));
    assert.equal(hidden.rowCount, 0);
    for (let run = 0; run < 3; run++)
      assert.ok(await cleanupUploadObjects(new Date(Date.now() + 7 * 86400_001 + run * 1000), 100) <= 100);
    assert.ok(!objects.has(deletedStage), "pending scopes cannot starve the deleted-workspace ledger");
    const untouched = await admin.query("SELECT count(*)::int AS n FROM asset_upload WHERE version_id=ANY($1::uuid[]) AND sweep_at IS NULL", [versions]);
    assert.equal(untouched.rows[0].n, 0);
  });

  await t.test("cleanup keeps an active committed PUT and bounds every deletion page to 1000 keys", async () => {
    const item = await seed();
    let release!: () => void, entered!: () => void, active = "";
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    setWriteHook(async (key, data) => {
      if (key.includes("/sealed/")) {
        active = key;
        objects.set(key, data); // object committed; acknowledgement still in flight
        entered(); await gate;
      }
    });
    const running = processAsset(item);
    try {
      await waiting;
      const prefix = active.slice(0, active.indexOf("/sealed/") + "/sealed/".length);
      for (let index = 0; index < 1001; index++) objects.set(`${prefix}abandoned-${index.toString().padStart(4, "0")}/source`, bytes);
      await sweep(8 * 86400_001);
      await sweep(8 * 86400_001 + 1000);
      assert.deepEqual(objects.get(active), bytes);
      assert.deepEqual(objects.get(item.stage), bytes);
      assert.equal([...objects.keys()].filter(key => key.startsWith(prefix)).length, 1);
      release(); await running;
      assert.equal((await state(item.versionId)).storage_key, active);
    } finally { release(); await running; }
  });
}
