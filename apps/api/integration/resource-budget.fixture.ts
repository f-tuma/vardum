import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export async function checkResourceBudgets(
  t: TestContext,
  fixture: {
    admin: Pool;
    app: FastifyInstance;
    objects: Map<string, Buffer>;
    keyHeaders: Record<string, Record<string, string>>;
    setDeleteFailure: (value: boolean | ((key: string) => boolean)) => void;
    setReadHook: (hook: (key: string) => Promise<void>) => void;
  },
) {
  const { admin, app, objects, keyHeaders } = fixture;
  const { config } = await import("../src/config.js");
  const { cleanupPendingUploads } = await import("../src/upload-lifecycle.js");
  const { withTransformBudget } = await import("../src/transform-budget.js");
  const previous = {
    bytes: config.WORKSPACE_STORAGE_MB,
    pending: config.WORKSPACE_PENDING_UPLOADS,
  };
  const assets: string[] = [];
  const headers = keyHeaders.write!;
  const makeAsset = async () => {
    const id = randomUUID();
    assets.push(id);
    await admin.query(
      "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1::uuid,'ws',$1::text,'Budget fixture','fixture','fixture')",
      [id],
    );
    return id;
  };
  const issue = (assetId: string, size: number) =>
    app.inject({
      method: "POST",
      url: `/api/workspaces/ws/assets/${assetId}/versions`,
      headers,
      payload: { filename: "test.png", mimeType: "image/png", size },
    });
  const state = async (id: string) =>
    (await admin.query("SELECT * FROM asset_version WHERE id=$1", [id]))
      .rows[0];
  t.after(async () => {
    config.WORKSPACE_STORAGE_MB = previous.bytes;
    config.WORKSPACE_PENDING_UPLOADS = previous.pending;
    fixture.setDeleteFailure(false);
    fixture.setReadHook(async () => {});
    await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [assets]);
  });

  await t.test(
    "concurrent uploads to different assets cannot over-reserve workspace bytes",
    async () => {
      config.WORKSPACE_STORAGE_MB = 1;
      const ids = await Promise.all([makeAsset(), makeAsset()]);
      const responses = await Promise.all(ids.map((id) => issue(id, 700_000)));
      assert.deepEqual(responses.map((x) => x.statusCode).sort(), [201, 413]);
      const usage = await app.inject({
        url: "/api/workspaces/ws/storage-usage",
        headers,
      });
      assert.equal(usage.statusCode, 200);
      assert.ok(usage.json().reservedBytes <= 1024 ** 2);
      assert.equal(
        (
          await app.inject({
            url: "/api/workspaces/ws/storage-usage",
            headers: keyHeaders.other!,
          })
        ).statusCode,
        401,
      );
      await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [ids]);
      config.WORKSPACE_STORAGE_MB = previous.bytes;
    },
  );

  await t.test(
    "pending count is reserved atomically and import cannot bypass storage quota",
    async () => {
      const count = Number(
        (
          await admin.query(
            "SELECT count(*) FROM asset_version WHERE workspace_id='ws' AND status IN ('pending','processing')",
          )
        ).rows[0].count,
      );
      config.WORKSPACE_PENDING_UPLOADS = count + 1;
      const ids = await Promise.all([makeAsset(), makeAsset()]);
      const responses = await Promise.all(ids.map((id) => issue(id, 10)));
      assert.deepEqual(responses.map((x) => x.statusCode).sort(), [201, 429]);
      await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [ids]);
      config.WORKSPACE_PENDING_UPLOADS = previous.pending;
      config.WORKSPACE_STORAGE_MB = 1;
      const filler = await makeAsset();
      await admin.query(
        "INSERT INTO asset_version(workspace_id,asset_id,number,size,storage_key,filename,mime_type,created_by,updated_by) VALUES ('ws',$1::uuid,1,1048576,$1::text,'full.png','image/png','fixture','fixture')",
        [filler],
      );
      const imported = await app.inject({
        method: "POST",
        url: "/api/workspaces/ws/imports",
        headers,
        payload: { source: "incoming/", prefix: "budget-import/" },
      });
      assert.equal(imported.statusCode, 413, imported.body);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*) FROM asset WHERE key LIKE 'budget-import/%'",
          )
        ).rows[0].count,
        "0",
      );
      const duplicate = await makeAsset();
      await admin.query(
        "UPDATE asset SET key='budget-import/import.png' WHERE id=$1",
        [duplicate],
      );
      const repeated = await app.inject({
        method: "POST",
        url: "/api/workspaces/ws/imports",
        headers,
        payload: { source: "incoming/", prefix: "budget-import/" },
      });
      assert.equal(repeated.statusCode, 200, repeated.body);
      assert.equal(repeated.json().imported, 0);
      assert.equal(repeated.json().skipped, 1);
      await admin.query("DELETE FROM asset WHERE id=$1", [duplicate]);
      await admin.query("DELETE FROM asset WHERE id=$1", [filler]);
      config.WORKSPACE_STORAGE_MB = previous.bytes;
    },
  );

  await t.test(
    "cleanup progresses past a full batch of failed keys within and across workspaces, then recovers reservations",
    async (cleanupTest) => {
      const suffix = randomUUID();
      const earlyWorkspace = `000-budget-${suffix}`;
      const lateWorkspace = `zzz-budget-${suffix}`;
      const earlyAsset = randomUUID();
      const lateAsset = randomUUID();
      const earlyVersions = Array.from({ length: 102 }, () => randomUUID());
      const lateVersion = randomUUID();
      const failedKeys = new Set(earlyVersions.slice(0, 101).map(id => `budget-fair/${id}`));
      const earlyHealthyKey = `budget-fair/${earlyVersions.at(-1)}`;
      const lateHealthyKey = `budget-fair/${lateVersion}`;
      const attempts: string[] = [];
      const now = new Date();
      cleanupTest.after(async () => {
        fixture.setDeleteFailure(false);
        await admin.query("DELETE FROM workspace WHERE id=ANY($1::text[])", [[earlyWorkspace, lateWorkspace]]);
        for (const key of [...failedKeys, earlyHealthyKey, lateHealthyKey]) objects.delete(key);
      });
      await admin.query(
        "INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) SELECT id,'org',id,id,'fixture','fixture' FROM unnest($1::text[]) AS id",
        [[earlyWorkspace, lateWorkspace]],
      );
      for (const [assetId, workspaceId] of [[earlyAsset, earlyWorkspace], [lateAsset, lateWorkspace]])
        await admin.query(
          "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,$2,'cleanup','Cleanup fixture','fixture','fixture')",
          [assetId, workspaceId],
        );
      await admin.query(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,size,storage_key,filename,mime_type,created_at,created_by,updated_by) SELECT id,$2,$3,number,10,'budget-fair/'||id,'test.png','image/png',$4::timestamptz-interval '2 days'+number*interval '1 second','fixture','fixture' FROM unnest($1::uuid[]) WITH ORDINALITY AS versions(id,number)",
        [earlyVersions, earlyWorkspace, earlyAsset, now],
      );
      await admin.query(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,size,storage_key,filename,mime_type,created_at,created_by,updated_by) VALUES ($1,$2,$3,1,10,$4,'test.png','image/png',$5::timestamptz-interval '2 days','fixture','fixture')",
        [lateVersion, lateWorkspace, lateAsset, lateHealthyKey, now],
      );
      for (const key of [...failedKeys, earlyHealthyKey, lateHealthyKey]) objects.set(key, Buffer.alloc(10));
      fixture.setDeleteFailure(key => {
        attempts.push(key);
        return failedKeys.has(key);
      });
      await assert.rejects(cleanupPendingUploads(now), /delete/);
      assert.equal(attempts.length, 100, "one run inspects at most the default key batch");
      assert.equal((await state(earlyVersions[0]!)).upload_cleaned_at, null);
      assert.equal((await state(earlyVersions.at(-1)!)).status, "pending");
      assert.equal((await state(lateVersion)).status, "pending");

      const firstAttempts = attempts.length;
      // A fresh module instance has no in-memory sweep cursor to inherit.
      const { cleanupPendingUploads: restartedCleanup } = await import(
        `../src/upload-lifecycle.js?worker-restart=${suffix}`
      );
      await assert.rejects(restartedCleanup(new Date(now.getTime() + 1000)), /delete/);
      assert.ok(attempts.length - firstAttempts <= 100);
      assert.ok(!objects.has(lateHealthyKey), "later workspace is served while earliest workspace deletes still fail");
      assert.ok(!objects.has(earlyHealthyKey), "new rows in the earliest workspace are served ahead of previously failed attempts");
      assert.ok([...failedKeys].every(key => attempts.includes(key)), "every failed key receives an attempt across runs");
      assert.ok((await state(lateVersion)).upload_cleaned_at);
      const { inWorkspace } = await import("../src/db/tenant.js");
      const { workspaceUsage } = await import("../src/upload-lifecycle.js");
      assert.equal((await inWorkspace(earlyWorkspace, tx => workspaceUsage(tx, earlyWorkspace))).reservedBytes, 1010);
      for (const id of earlyVersions.slice(0, 101)) {
        const version = await state(id);
        assert.equal(version.status, "failed");
        assert.equal(version.upload_cleaned_at, null);
        assert.ok(objects.has(version.storage_key));
      }

      fixture.setDeleteFailure(key => { attempts.push(key); return false; });
      for (let run = 2; run < 4; run++) {
        const previousAttempts: number = attempts.length;
        await cleanupPendingUploads(new Date(now.getTime() + run * 1000));
        assert.ok(attempts.length - previousAttempts <= 100);
      }
      assert.equal((await inWorkspace(earlyWorkspace, tx => workspaceUsage(tx, earlyWorkspace))).reservedBytes, 0);
      for (const id of earlyVersions) assert.ok((await state(id)).upload_cleaned_at);
      assert.ok([...failedKeys].every(key => !objects.has(key)));
      assert.ok(attempts.filter(key => key === `budget-fair/${earlyVersions[0]}`).length >= 2, "failed reservations are retried after storage recovers");
    },
  );

  await t.test(
    "cleanup bounds directory visits and reaches work beyond a hundred empty workspaces",
    async (cleanupTest) => {
      const suffix = randomUUID();
      const emptyWorkspaces = Array.from({ length: 101 }, (_, index) =>
        `000-empty-${suffix}-${String(index).padStart(3, "0")}`,
      );
      const lastWorkspace = `zzz-cleanup-${suffix}`;
      const workspaces = [...emptyWorkspaces, lastWorkspace];
      const assetId = randomUUID();
      const versionId = randomUUID();
      const key = `budget-directory/${versionId}`;
      const now = new Date();
      cleanupTest.after(async () => {
        await admin.query("DELETE FROM workspace WHERE id=ANY($1::text[])", [workspaces]);
        objects.delete(key);
      });
      await admin.query(
        "INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) SELECT id,'org',id,id,'fixture','fixture' FROM unnest($1::text[]) AS id",
        [workspaces],
      );
      await admin.query(
        "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,$2,'cleanup','Cleanup fixture','fixture','fixture')",
        [assetId, lastWorkspace],
      );
      await admin.query(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,size,storage_key,filename,mime_type,created_at,created_by,updated_by) VALUES ($1,$2,$3,1,10,$4,'test.png','image/png',$5::timestamptz-interval '2 days','fixture','fixture')",
        [versionId, lastWorkspace, assetId, key, now],
      );
      objects.set(key, Buffer.alloc(10));
      assert.equal(await cleanupPendingUploads(now), 0);
      assert.ok(objects.has(key));
      assert.equal(
        (await admin.query("SELECT count(*)::int AS count FROM workspace WHERE id=ANY($1::text[]) AND upload_cleanup_at IS NOT NULL", [workspaces])).rows[0].count,
        100,
        "empty directory visits are bounded independently of key operations",
      );
      assert.equal(await cleanupPendingUploads(new Date(now.getTime() + 1000)), 1);
      assert.ok(!objects.has(key));
      assert.ok((await state(versionId)).upload_cleaned_at);
    },
  );

  await t.test(
    "cleanup preserves active/ready versions, retries partial deletes and rejects late finalize",
    async () => {
      const id = await makeAsset();
      const expired = (await issue(id, 10)).json().id;
      const recent = (await issue(id, 10)).json().id;
      const processing = (await issue(id, 10)).json().id;
      const ready = (await issue(id, 10)).json().id;
      await admin.query(
        "UPDATE asset_version SET created_at=now()-interval '2 days' WHERE id=ANY($1::uuid[])",
        [[expired, processing, ready]],
      );
      await admin.query(
        "UPDATE asset_version SET status='processing' WHERE id=$1",
        [processing],
      );
      // Synthetic publication for this quota-only fixture must obey the same
      // attempt/key fencing as real ingest (image processing is tested above).
      const readyAttempt = randomUUID();
      await admin.query("UPDATE asset_version SET status='processing',ingest_attempt_id=$2 WHERE id=$1", [ready, readyAttempt]);
      await admin.query("UPDATE asset_version SET status='ready',storage_key='originals/'||workspace_id||'/'||asset_id||'/'||id||'/sealed/'||ingest_attempt_id||'/source',ingest_attempt_id=NULL WHERE id=$1", [ready]);
      await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
        ready,
        id,
      ]);
      for (const version of [expired, recent, processing, ready])
        objects.set((await state(version)).storage_key, Buffer.alloc(10));
      fixture.setDeleteFailure(true);
      await assert.rejects(cleanupPendingUploads(), /delete/);
      assert.equal((await state(expired)).status, "failed");
      assert.equal((await state(expired)).upload_cleaned_at, null);
      assert.ok(objects.has((await state(expired)).storage_key));
      fixture.setDeleteFailure(false);
      await cleanupPendingUploads();
      assert.ok((await state(expired)).upload_cleaned_at);
      assert.equal((await state(expired)).retryable, false);
      assert.ok(!objects.has((await state(expired)).storage_key));
      for (const version of [recent, processing, ready])
        assert.ok(objects.has((await state(version)).storage_key));
      for (const action of ["finalize", "retry"]) {
        const result = await app.inject({
          method: "POST",
          url: `/api/workspaces/ws/assets/${id}/versions/${expired}/${action}`,
          headers,
        });
        assert.equal(result.statusCode, 409, result.body);
      }
      // An upload already in flight can finish after expiry. Retained tombstones
      // re-sweep the exact key, never a prefix or a published version.
      objects.set((await state(expired)).storage_key, Buffer.alloc(10));
      await admin.query(
        "UPDATE asset_version SET upload_sweep_at=now()-interval '2 days' WHERE id=$1",
        [expired],
      );
      await cleanupPendingUploads();
      assert.ok(!objects.has((await state(expired)).storage_key));
      assert.equal(
        (
          await admin.query(
            "SELECT current_version_id FROM asset WHERE id=$1",
            [id],
          )
        ).rows[0].current_version_id,
        ready,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*) FROM audit_event WHERE target_id=$1 AND action='asset.upload_expired'",
            [expired],
          )
        ).rows[0].count,
        "1",
      );
    },
  );

  await t.test(
    "finalize checks expiry even before the cleanup worker runs",
    async () => {
      const id = await makeAsset();
      const version = (await issue(id, 10)).json().id;
      await admin.query(
        "UPDATE asset_version SET created_at=now()-interval '2 days' WHERE id=$1",
        [version],
      );
      const result = await app.inject({
        method: "POST",
        url: `/api/workspaces/ws/assets/${id}/versions/${version}/finalize`,
        headers,
      });
      assert.equal(result.statusCode, 409, result.body);
      assert.equal((await state(version)).status, "failed");
    },
  );

  await t.test(
    "cleanup skips a locked pending version that transitions to processing",
    async () => {
      const id = await makeAsset();
      const version = (await issue(id, 10)).json().id;
      await admin.query(
        "UPDATE asset_version SET created_at=now()-interval '2 days' WHERE id=$1",
        [version],
      );
      const source = (await state(version)).storage_key;
      objects.set(source, Buffer.alloc(10));
      const finalizer = await admin.connect();
      try {
        await finalizer.query("BEGIN");
        await finalizer.query(
          "SELECT id FROM asset_version WHERE id=$1 FOR UPDATE",
          [version],
        );
        await cleanupPendingUploads();
        await finalizer.query(
          "UPDATE asset_version SET status='processing' WHERE id=$1",
          [version],
        );
        await finalizer.query("COMMIT");
        await cleanupPendingUploads();
        assert.equal((await state(version)).status, "processing");
        assert.equal((await state(version)).upload_expired_at, null);
        assert.ok(objects.has(source));
      } finally {
        await finalizer.query("ROLLBACK");
        finalizer.release();
      }
    },
  );

  await t.test(
    "HTTP transform saturation, deduplication, cached reads and pixel limits",
    async () => {
      const id = await makeAsset();
      const version = randomUUID();
      const key = `budget/${version}`;
      const bytes = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1"><rect width="1000" height="1" fill="red"/></svg>',
      );
      objects.set(key, bytes);
      await admin.query(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,size,storage_key,filename,mime_type,created_by,updated_by) VALUES ($1,'ws',$2,1,'ready',$3,$4,'wide.svg','image/svg+xml','fixture','fixture')",
        [version, id, bytes.length, key],
      );
      const { transformedVersionUrl } =
        await import("../src/transformation.js");
      const url = (w: number) =>
        transformedVersionUrl("demo", id, version, { w, format: "png" });
      const request = (target: string) =>
        app.inject({ url: target, headers }).then((x) => x);
      assert.equal((await request(url(8))).statusCode, 200);
      let entered = 0;
      let unblock!: () => void;
      const gate = new Promise<void>((yes) => {
        unblock = yes;
      });
      fixture.setReadHook(async (source) => {
        if (source === key) {
          entered++;
          await gate;
        }
      });
      const first = request(url(16));
      const second = request(url(32));
      try {
        const deadline = Date.now() + 5000;
        while (entered < 2 && Date.now() < deadline)
          await new Promise((yes) => setTimeout(yes, 10));
        assert.equal(entered, 2);
        const denied = await request(url(64));
        assert.equal(denied.statusCode, 503, denied.body);
        assert.equal(denied.headers["retry-after"], "1");
        assert.equal(denied.headers["cache-control"], "private, no-store");
        assert.equal((await request(url(8))).statusCode, 200);
        const duplicate = request(url(16));
        unblock();
        for (const response of await Promise.all([first, second, duplicate]))
          assert.equal(response.statusCode, 200, response.body);
        assert.equal(entered, 2);
      } finally {
        unblock();
        await Promise.allSettled([first, second]);
        fixture.setReadHook(async () => {});
      }
      const oversized = await request(
        transformedVersionUrl("demo", id, version, { h: 4096, format: "png" }),
      );
      assert.equal(oversized.statusCode, 422, oversized.body);
      assert.equal((await request(url(64))).statusCode, 200);
    },
  );

  await t.test(
    "database-wide transform slots reject saturation and release after failure",
    async () => {
      const blocker = await admin.connect();
      try {
        for (let slot = 0; slot < config.TRANSFORM_CONCURRENCY; slot++)
          await blocker.query("SELECT pg_advisory_lock(74121,$1)", [slot]);
        let called = false;
        await assert.rejects(
          withTransformBudget(async () => {
            called = true;
          }),
          /busy/,
        );
        assert.equal(called, false);
      } finally {
        await blocker.query("SELECT pg_advisory_unlock_all()");
        blocker.release();
      }
      await assert.rejects(
        withTransformBudget(async () => {
          throw new Error("encoder failed");
        }),
        /encoder failed/,
      );
      assert.equal(
        await withTransformBudget(async () => "recovered"),
        "recovered",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=74121",
          )
        ).rows[0].count,
        "0",
      );
    },
  );
}
