import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";

type PlannedUpload = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  expectedChecksum: string;
  expectedCurrentVersionId: string | null;
};

// Only called after private-delivery installs its disposable database/storage config.
export async function checkUploadResume(
  t: TestContext,
  fixture: {
    admin: Pool;
    app: FastifyInstance;
    objects: Map<string, Buffer>;
    keyHeaders: Record<string, Record<string, string>>;
    cookies: Record<string, string>;
  },
) {
  const { admin, app, objects, keyHeaders, cookies } = fixture;
  const { config } = await import("../src/config.js");
  const { uploadDeadline } = await import("../src/upload-lifecycle.js");
  const { inWorkspace } = await import("../src/db/tenant.js");
  const { pool } = await import("../src/db/index.js");
  const { processAsset } = await import("../src/asset-processor.js");
  const assets: string[] = [];
  const storedObjects: string[] = [];
  const limits = {
    bytes: config.WORKSPACE_STORAGE_MB,
    pending: config.WORKSPACE_PENDING_UPLOADS,
  };
  const bytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>',
  );
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const headers = keyHeaders.write!;
  t.after(async () => {
    config.WORKSPACE_STORAGE_MB = limits.bytes;
    config.WORKSPACE_PENDING_UPLOADS = limits.pending;
    await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [assets]);
    for (const key of storedObjects) objects.delete(key);
  });

  const create = (
    payload: Record<string, unknown>,
    principal = headers,
    workspaceId = "ws",
  ) => app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/assets`,
    headers: principal,
    payload,
  });
  const issue = (
    assetId: string,
    payload: Record<string, unknown> | PlannedUpload,
    principal = headers,
    workspaceId = "ws",
  ) => app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/assets/${assetId}/versions`,
    headers: principal,
    payload,
  });
  const exact = (
    assetId: string,
    versionId: string,
    principal = keyHeaders.read!,
    workspaceId = "ws",
  ) => app.inject({
    url: `/api/workspaces/${workspaceId}/assets/${assetId}/versions/${versionId}`,
    headers: principal,
  });
  const planned = (
    expectedCurrentVersionId: string | null = null,
    changes: Partial<PlannedUpload> = {},
  ): PlannedUpload => ({
    id: randomUUID(),
    filename: "retry.svg",
    mimeType: "image/svg+xml",
    size: bytes.length,
    expectedChecksum: checksum,
    expectedCurrentVersionId,
    ...changes,
  });
  const state = async (versionId: string) =>
    (await admin.query("SELECT * FROM asset_version WHERE id=$1", [versionId])).rows[0];
  const assetState = async (assetId: string) =>
    (await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows[0];
  const audit = async (targetId: string) =>
    (await admin.query("SELECT * FROM audit_event WHERE target_id=$1 ORDER BY id", [targetId])).rows;
  const versionCount = async (assetId: string) =>
    (await admin.query("SELECT count(*)::int AS count FROM asset_version WHERE asset_id=$1", [assetId])).rows[0].count;
  function successful(response: Awaited<ReturnType<typeof app.inject>>) {
    assert.ok([200, 201].includes(response.statusCode), response.body);
    return response.json();
  }
  function withoutUpload(body: Record<string, unknown>) {
    assert.ok(!body.upload, "a processing/ready/failed version cannot issue an upload form");
    assert.equal(body.uploadUrl, undefined);
  }
  async function makeAsset(workspaceId = "ws") {
    const id = randomUUID();
    assets.push(id);
    await admin.query(
      "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,$2,$3,'Upload resume fixture','fixture','fixture')",
      [id, workspaceId, `upload-resume/${id}`],
    );
    return id;
  }
  async function makeReady(assetId: string) {
    const id = randomUUID();
    await admin.query(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES($1,'ws',$2,1,'ready',$3,'old.svg','image/svg+xml',$4,$5,'fixture','fixture')",
      [id, assetId, `upload-resume/${id}/old`, bytes.length, checksum],
    );
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [id, assetId]);
    return id;
  }

  await t.test("asset UUID replay preserves names and audit; key and UUID collisions conflict", async () => {
    const id = randomUUID();
    const key = `upload-resume/${id}`;
    assets.push(id);
    const first = successful(await create({ id, key, displayName: "Original name" }));
    assert.equal(first.id, id);
    const before = await assetState(id);
    const beforeAudit = await audit(id);
    assert.equal(beforeAudit.filter(event => event.action === "asset.created").length, 1);
    const replay = successful(await create({ id, key, displayName: "Changed by replay" }));
    assert.equal(replay.id, id);
    assert.equal(replay.displayName, "Original name");
    assert.deepEqual(await assetState(id), before);
    assert.deepEqual(await audit(id), beforeAudit);
    for (const payload of [
      { id, key: `${key}-different`, displayName: "Wrong key" },
      { id: randomUUID(), key, displayName: "Key collision" },
    ]) {
      const result = await create(payload);
      assert.equal(result.statusCode, 409, result.body);
    }
    assert.deepEqual(await assetState(id), before);
    assert.deepEqual(await audit(id), beforeAudit);
  });

  await t.test("concurrent asset UUID replay creates one asset and one audit", async () => {
    const id = randomUUID();
    assets.push(id);
    const payload = { id, key: `upload-resume/${id}`, displayName: "Concurrent" };
    const responses = await Promise.all([create(payload), create(payload), create(payload)]);
    for (const result of responses) assert.equal(successful(result).id, id);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM asset WHERE id=$1", [id])).rows[0].count, 1);
    assert.equal((await audit(id)).filter(event => event.action === "asset.created").length, 1);
  });

  await t.test("planned upload fields are validated; legacy requests remain independent", async () => {
    const assetId = await makeAsset();
    const valid = planned();
    const invalid: Record<string, unknown>[] = [
      { ...valid, id: "not-a-uuid" },
      { ...valid, expectedChecksum: "a".repeat(63) },
      { ...valid, expectedChecksum: "g".repeat(64) },
      { ...valid, expectedCurrentVersionId: "not-a-uuid" },
    ];
    for (const omitted of ["expectedChecksum", "expectedCurrentVersionId"]) {
      const payload: Record<string, unknown> = { ...valid };
      delete payload[omitted];
      invalid.push(payload);
    }
    for (const payload of invalid) {
      const response = await issue(assetId, payload);
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal(await versionCount(assetId), 0);
    const invalidAsset = await create({ id: "not-a-uuid", key: "upload-resume/invalid", displayName: "Invalid" });
    assert.equal(invalidAsset.statusCode, 400, invalidAsset.body);
    const legacy = { filename: "retry.svg", mimeType: "image/svg+xml", size: bytes.length };
    const first = successful(await issue(assetId, legacy));
    const second = successful(await issue(assetId, legacy));
    assert.notEqual(first.id, second.id);
    assert.deepEqual([first.number, second.number], [1, 2]);
    assert.ok(first.upload?.url && second.upload?.url);
    assert.equal((await state(first.id)).expected_checksum, null);
    const created = successful(await create({ key: `upload-resume/${randomUUID()}`, displayName: "Legacy" }));
    assets.push(created.id);
    assert.match(created.id, /^[0-9a-f-]{36}$/);
  });

  await t.test("pending UUID replay keeps one row, audit, storage key and upload deadline", async () => {
    const assetId = await makeAsset();
    const intent = planned();
    const first = successful(await issue(assetId, intent));
    assert.equal(first.id, intent.id);
    assert.equal(first.status, "pending");
    assert.ok(first.upload?.url);
    const before = await state(intent.id);
    const beforeAudit = await audit(intent.id);
    assert.equal(before.expected_checksum, checksum);
    assert.equal(beforeAudit.filter(event => event.action === "asset.version_created").length, 1);
    const replay = successful(await issue(assetId, intent));
    assert.equal(replay.id, intent.id);
    assert.equal(replay.number, first.number);
    assert.equal(replay.status, "pending");
    assert.equal(replay.expiresAt, first.expiresAt);
    assert.equal(replay.expiresAt, uploadDeadline(before.created_at).toISOString());
    assert.equal(replay.upload?.fields.key, first.upload.fields.key);
    assert.equal(replay.upload?.fields.key, before.storage_key);
    assert.deepEqual(await state(intent.id), before);
    assert.deepEqual(await audit(intent.id), beforeAudit);
    assert.equal(await versionCount(assetId), 1);
    const detail = await exact(assetId, intent.id);
    assert.equal(detail.statusCode, 200, detail.body);
    assert.deepEqual(Object.keys(detail.json()).sort(), [
      "id", "number", "status", "filename", "mimeType", "size", "checksum",
      "expectedChecksum", "retryable", "error", "expiresAt",
    ].sort());
    assert.deepEqual(detail.json(), {
      id: intent.id, number: 1, status: "pending", filename: intent.filename,
      mimeType: intent.mimeType, size: intent.size, checksum: null,
      expectedChecksum: checksum, retryable: false, error: null,
      expiresAt: replay.expiresAt,
    });
  });

  await t.test("UUID metadata mismatch and foreign asset UUID cannot change an existing intent", async () => {
    const assetId = await makeAsset();
    const anotherAssetId = await makeAsset();
    const intent = planned();
    successful(await issue(assetId, intent));
    const before = await state(intent.id);
    const beforeAudit = await audit(intent.id);
    for (const changes of [
      { filename: "different.svg" }, { mimeType: "image/png" },
      { size: intent.size + 1 }, { expectedChecksum: "f".repeat(64) },
    ]) {
      const response = await issue(assetId, { ...intent, ...changes });
      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(await state(intent.id), before);
    }
    const foreign = await issue(anotherAssetId, intent);
    assert.equal(foreign.statusCode, 409, foreign.body);
    assert.equal(await versionCount(anotherAssetId), 0);
    assert.deepEqual(await state(intent.id), before);
    assert.deepEqual(await audit(intent.id), beforeAudit);
  });

  await t.test("concurrent UUID replay and new UUID adoption reserve one active intent", async () => {
    const assetId = await makeAsset();
    const intent = planned();
    const replayResponses = await Promise.all([issue(assetId, intent), issue(assetId, intent)]);
    for (const response of replayResponses) assert.equal(successful(response).id, intent.id);
    const before = await state(intent.id);
    const beforeAudit = await audit(intent.id);
    const adopted = planned();
    const adoptedResponse = successful(await issue(assetId, adopted));
    assert.equal(adoptedResponse.id, intent.id);
    assert.equal(adoptedResponse.expiresAt, uploadDeadline(before.created_at).toISOString());
    assert.equal(adoptedResponse.upload?.fields.key, before.storage_key);
    assert.equal(await state(adopted.id), undefined);
    assert.deepEqual(await state(intent.id), before);
    assert.deepEqual(await audit(intent.id), beforeAudit);
    assert.equal(await versionCount(assetId), 1);

    const emptyAsset = await makeAsset();
    const simultaneous = [planned(), planned()];
    const responses = await Promise.all(simultaneous.map(payload => issue(emptyAsset, payload)));
    const results = responses.map(successful);
    assert.equal(results[0].id, results[1].id);
    assert.ok(simultaneous.some(payload => payload.id === results[0].id));
    assert.equal(await versionCount(emptyAsset), 1);
    assert.equal((await audit(results[0].id)).filter(event => event.action === "asset.version_created").length, 1);
  });

  await t.test("a different active intent or stale current pointer conflicts without mutation", async () => {
    const assetId = await makeAsset();
    const currentId = await makeReady(assetId);
    const intent = planned(currentId, { expectedChecksum: "f".repeat(64) });
    successful(await issue(assetId, intent));
    const before = await state(intent.id);
    const beforeAsset = await assetState(assetId);
    const beforeAudit = await audit(intent.id);
    for (const changes of [
      { filename: "other.svg" }, { mimeType: "image/png" },
      { size: intent.size + 1 }, { expectedChecksum: "e".repeat(64) },
      { expectedCurrentVersionId: null }, { expectedCurrentVersionId: randomUUID() },
    ]) {
      const response = await issue(assetId, { ...intent, id: randomUUID(), ...changes });
      assert.equal(response.statusCode, 409, response.body);
    }
    // Matching ready A must not hide unfinished B, which can still be published later.
    const readyWhileActive = await issue(assetId, planned(currentId, { filename: "old.svg" }));
    assert.equal(readyWhileActive.statusCode, 409, readyWhileActive.body);
    assert.deepEqual(await state(intent.id), before);
    assert.deepEqual(await assetState(assetId), beforeAsset);
    assert.deepEqual(await audit(intent.id), beforeAudit);
    assert.equal(await versionCount(assetId), 2);
  });

  await t.test("identity listings expose all unfinished uploads even behind a newer ready version", async () => {
    const assetId = await makeAsset();
    const intent = planned();
    successful(await issue(assetId, intent));
    const check = async (expected: boolean) => {
      for (const pagination of ["", "&pagination=cursor"]) {
        const response = await app.inject({
          url: `/api/workspaces/ws/assets?prefix=upload-resume%2F&search=${assetId}${pagination}`,
          headers: keyHeaders.read!,
        });
        assert.equal(response.statusCode, 200, response.body);
        const rows = response.json().assets;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, assetId);
        assert.equal(rows[0].hasUnfinishedUploads, expected);
      }
    };
    await check(true);
    await admin.query("UPDATE asset_version SET status='failed',retryable=true WHERE id=$1", [intent.id]);
    await check(true);
    await admin.query("UPDATE asset_version SET retryable=false WHERE id=$1", [intent.id]);
    await check(false);
    await admin.query("UPDATE asset_version SET status='processing' WHERE id=$1", [intent.id]);
    const newestId = randomUUID();
    await admin.query(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) SELECT $1::uuid,workspace_id,asset_id,2,'ready',$1::text,filename,mime_type,size,$2,'fixture','fixture' FROM asset_version WHERE id=$3",
      [newestId, checksum, intent.id],
    );
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [newestId, assetId]);
    await check(true);
    await admin.query("UPDATE asset_version SET status='ready',checksum=$2 WHERE id=$1", [intent.id, checksum]);
    await check(false);
  });

  await t.test("replay and adoption work when storage and pending capacity are already full", async () => {
    const assetId = await makeAsset();
    const intent = planned();
    successful(await issue(assetId, intent));
    const anotherAssetId = await makeAsset();
    try {
      config.WORKSPACE_STORAGE_MB = 0;
      for (const payload of [intent, { ...intent, id: randomUUID() }]) {
        const replay = successful(await issue(assetId, payload));
        assert.equal(replay.id, intent.id);
      }
      const storageDenied = await issue(anotherAssetId, planned());
      assert.equal(storageDenied.statusCode, 413, storageDenied.body);
      config.WORKSPACE_STORAGE_MB = limits.bytes;
      config.WORKSPACE_PENDING_UPLOADS = Number((await admin.query(
        "SELECT count(*) FROM asset_version WHERE workspace_id='ws' AND status IN ('pending','processing')",
      )).rows[0].count);
      for (const payload of [intent, { ...intent, id: randomUUID() }]) {
        const replay = successful(await issue(assetId, payload));
        assert.equal(replay.id, intent.id);
      }
      const pendingDenied = await issue(anotherAssetId, planned());
      assert.equal(pendingDenied.statusCode, 429, pendingDenied.body);
      assert.equal(await versionCount(assetId), 1);
      assert.equal(await versionCount(anotherAssetId), 0);
    } finally {
      config.WORKSPACE_STORAGE_MB = limits.bytes;
      config.WORKSPACE_PENDING_UPLOADS = limits.pending;
    }
  });

  await t.test("processing and ready UUID replay return state without a new upload or CAS rejection", async () => {
    const assetId = await makeAsset();
    const intent = planned();
    successful(await issue(assetId, intent));
    await admin.query("UPDATE asset_version SET status='processing' WHERE id=$1", [intent.id]);
    const processing = successful(await issue(assetId, intent));
    assert.equal(processing.id, intent.id);
    assert.equal(processing.status, "processing");
    withoutUpload(processing);
    const adopted = successful(await issue(assetId, { ...intent, id: randomUUID() }));
    assert.equal(adopted.id, intent.id);
    assert.equal(adopted.status, "processing");
    withoutUpload(adopted);
    await admin.query("UPDATE asset_version SET status='ready',checksum=$2 WHERE id=$1", [intent.id, checksum]);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [intent.id, assetId]);
    const before = await state(intent.id);
    const beforeAudit = await audit(intent.id);
    // The original null CAS is now stale, but an exact UUID replay is still its original operation.
    const ready = successful(await issue(assetId, intent));
    assert.equal(ready.id, intent.id);
    assert.equal(ready.status, "ready");
    withoutUpload(ready);
    assert.deepEqual(await state(intent.id), before);
    assert.deepEqual(await audit(intent.id), beforeAudit);
    assert.equal(await versionCount(assetId), 1);
  });

  await t.test("matching current ready bytes skip a new version; stale CAS conflicts and new bytes reserve the next version", async () => {
    const assetId = await makeAsset();
    const currentId = await makeReady(assetId);
    const before = await assetState(assetId);
    const beforeVersion = await state(currentId);
    const intent = planned(currentId, { filename: "old.svg" });
    const ready = successful(await issue(assetId, intent));
    assert.equal(ready.id, currentId);
    assert.equal(ready.status, "ready");
    withoutUpload(ready);
    assert.equal(await state(intent.id), undefined);
    const completedBeforeRetry = successful(await issue(assetId, {
      ...intent, id: randomUUID(), expectedCurrentVersionId: null,
    }));
    assert.equal(completedBeforeRetry.id, currentId);
    assert.equal(completedBeforeRetry.status, "ready");
    withoutUpload(completedBeforeRetry);
    const stale = await issue(assetId, {
      ...intent, id: randomUUID(), expectedCurrentVersionId: null,
      expectedChecksum: "f".repeat(64),
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual(await assetState(assetId), before);
    assert.deepEqual(await state(currentId), beforeVersion);
    assert.equal(await versionCount(assetId), 1);
    assert.equal((await audit(currentId)).length, 0);
    const newIntent = planned(currentId, { expectedChecksum: "f".repeat(64) });
    const next = successful(await issue(assetId, newIntent));
    assert.equal(next.id, newIntent.id);
    assert.equal(next.status, "pending");
    assert.equal(next.number, 2);
  });

  await t.test("expired UUID replay exposes an actionable failure and never extends the reservation", async () => {
    const assetId = await makeAsset();
    const intent = planned();
    successful(await issue(assetId, intent));
    await admin.query("UPDATE asset_version SET created_at=now()-interval '2 days' WHERE id=$1", [intent.id]);
    const before = await state(intent.id);
    const response = await issue(assetId, intent);
    assert.equal(response.statusCode, 409, response.body);
    const result = response.json();
    withoutUpload(result);
    assert.match(result.error, /expired|new file/i);
    assert.deepEqual(await state(intent.id), before);
    const detail = await exact(assetId, intent.id);
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().status, "pending");
    assert.equal(detail.json().retryable, false);
    assert.equal(detail.json().expiresAt, uploadDeadline(before.created_at).toISOString());
    const repeated = await issue(assetId, intent);
    assert.equal(repeated.statusCode, 409, repeated.body);
    withoutUpload(repeated.json());
    assert.deepEqual(await state(intent.id), before);
    assert.equal((await audit(intent.id)).filter(event => event.action === "asset.upload_expired").length, 0);
    assert.equal(await versionCount(assetId), 1);
  });

  await t.test("exact reads and writes enforce real workspace permissions and tenant RLS", async () => {
    const assetId = await makeAsset();
    const anotherAssetId = await makeAsset();
    const otherAssetId = await makeAsset("other-ws");
    const intent = planned();
    successful(await issue(assetId, intent));
    for (const principal of [keyHeaders.read!, headers, ...["owner", "editor", "viewer"].map(role => ({ cookie: cookies[role]! }))]) {
      const response = await exact(assetId, intent.id, principal);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().id, intent.id);
    }
    for (const [principal, status] of [
      [{}, 401], [keyHeaders.insufficient!, 401], [keyHeaders.revoked!, 401],
      [keyHeaders.other!, 401], [{ cookie: cookies.outsider! }, 403],
    ] as const) {
      const response = await exact(assetId, intent.id, principal);
      assert.equal(response.statusCode, status, response.body);
      assert.ok(!response.body.includes(intent.id));
      assert.ok(!response.body.includes(checksum));
    }
    assert.equal((await exact(anotherAssetId, intent.id)).statusCode, 404);
    assert.equal((await exact(assetId, randomUUID())).statusCode, 404);
    assert.equal((await exact(assetId, intent.id, keyHeaders.other!, "other-ws")).statusCode, 404);
    for (const [principal, status] of [
      [{}, 401], [keyHeaders.read!, 401], [keyHeaders.insufficient!, 401],
      [keyHeaders.other!, 401], [{ cookie: cookies.viewer! }, 403],
      [{ cookie: cookies.outsider! }, 403],
    ] as const) {
      const response = await issue(assetId, intent, principal);
      assert.equal(response.statusCode, status, response.body);
      const created = await create({ id: randomUUID(), key: `upload-resume/${randomUUID()}`, displayName: "Denied" }, principal);
      assert.equal(created.statusCode, status, created.body);
    }
    assert.equal((await pool.query("SELECT id FROM asset_version WHERE id=$1", [intent.id])).rowCount, 0);
    const isolated = await inWorkspace("other-ws", tx => tx.execute(sql`SELECT id FROM asset_version WHERE id=${intent.id}`));
    assert.equal(isolated.rowCount, 0);
    // Globally unique UUID collisions across tenants return a controlled conflict without leaking metadata.
    const collision = await issue(otherAssetId, intent, { cookie: cookies.outsider! }, "other-ws");
    assert.equal(collision.statusCode, 409, collision.body);
    assert.ok(!collision.body.includes("retry.svg"));
    assert.ok(!collision.body.includes(checksum));
    assert.equal(await versionCount(otherAssetId), 0);
  });

  await t.test("worker verifies planned SHA-256 before publishing and exposes a nonretryable failure", async () => {
    const assetId = await makeAsset();
    const currentId = await makeReady(assetId);
    const intent = planned(currentId, { expectedChecksum: "f".repeat(64) });
    successful(await issue(assetId, intent));
    const pending = await state(intent.id);
    objects.set(pending.storage_key, bytes);
    storedObjects.push(pending.storage_key);
    await processAsset({ workspaceId: "ws", assetId, versionId: intent.id, requestId: `resume-test:${intent.id}` });
    const failed = await state(intent.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.retryable, false);
    assert.equal(failed.checksum, null);
    assert.equal(failed.expected_checksum, intent.expectedChecksum);
    assert.match(failed.error, /checksum/i);
    assert.match(failed.error, /Upload a new file/i);
    assert.equal((await assetState(assetId)).current_version_id, currentId);
    const detail = await exact(assetId, intent.id);
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().status, "failed");
    assert.equal(detail.json().retryable, false);
    assert.equal(detail.json().expectedChecksum, intent.expectedChecksum);
    const replay = await issue(assetId, intent);
    assert.ok([200, 409].includes(replay.statusCode), replay.body);
    withoutUpload(replay.json());
    assert.match(replay.json().error, /checksum|new file/i);
    assert.equal(await versionCount(assetId), 2);
    const events = await audit(intent.id);
    assert.equal(events.filter(event => event.action === "asset.version_processed").length, 0);
    assert.equal(events.filter(event => event.action === "asset.version_failed").length, 1);
  });
}
