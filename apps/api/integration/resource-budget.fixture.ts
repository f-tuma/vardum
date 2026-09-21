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
    setDeleteFailure: (value: boolean) => void;
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
      await admin.query("UPDATE asset_version SET status='ready' WHERE id=$1", [
        ready,
      ]);
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
