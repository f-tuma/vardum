import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
) {
  const deadline = Date.now() + 20_000;
  let value: T;
  do {
    value = await read();
    if (matches(value)) return value;
    await pause(50);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ingest: ${JSON.stringify(value)}`);
}

// Only used inside private-delivery's disposable PostgreSQL and HTTP S3 fixture.
export async function checkIngestRecovery(
  t: TestContext,
  fixture: {
    admin: Pool;
    app: FastifyInstance;
    objects: Map<string, Buffer>;
    keyHeaders: Record<string, Record<string, string>>;
    cookies: Record<string, string>;
    setStorageFailure: (failed: boolean) => void;
    setReadHook: (hook: (key: string) => Promise<void>) => void;
  },
) {
  const {
    admin,
    app,
    objects,
    keyHeaders,
    cookies,
    setStorageFailure,
    setReadHook,
  } = fixture;
  const { boss, assetIngestQueue } = await import("../src/queue.js");
  const { inWorkspace } = await import("../src/db/tenant.js");
  const { enqueueAssetIngest, reconcileAssetIngest } =
    await import("../src/asset-ingest.js");
  const { processAsset } = await import("../src/asset-processor.js");
  const bytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>',
  );
  const assets: string[] = [];
  const children: ChildProcess[] = [];
  const attempts = new Map<string, number>();
  t.beforeEach(() => {
    setStorageFailure(false);
    setReadHook(async () => {});
  });
  let workerId: string | undefined;
  let workerLogs = "";
  const start = async () => {
    workerId = await boss.work(
      assetIngestQueue,
      { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (!job) return;
        attempts.set(job.id, (attempts.get(job.id) ?? 0) + 1);
        await processAsset(job.data, { jobId: job.id, signal: job.signal });
      },
    );
  };
  const stop = async () => {
    if (workerId)
      await boss.offWork(assetIngestQueue, { id: workerId, wait: true });
    workerId = undefined;
  };
  async function kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }
  t.after(async () => {
    setStorageFailure(false);
    setReadHook(async () => {});
    await stop();
    await Promise.all(children.map(kill));
    await boss.updateQueue(assetIngestQueue, {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 300,
    });
    await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [assets]);
    if (t.error) console.error(workerLogs);
  });
  await boss.updateQueue(assetIngestQueue, {
    retryLimit: 1,
    retryDelay: 1,
    retryBackoff: false,
    expireInSeconds: 10,
  });
  const state = async (versionId: string) =>
    (
      await admin.query(
        "SELECT v.*,a.current_version_id FROM asset_version v JOIN asset a ON a.id=v.asset_id WHERE v.id=$1",
        [versionId],
      )
    ).rows[0];
  async function seed(body = bytes, workspaceId = "ws", enqueue = true) {
    const assetId = randomUUID();
    const versionId = randomUUID();
    const currentId = randomUUID();
    const storageKey = `recovery/${versionId}`;
    assets.push(assetId);
    objects.set(storageKey, body);
    await admin.query(
      "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,$2,$3,'Recovery fixture','fixture','fixture')",
      [assetId, workspaceId, storageKey],
    );
    await admin.query(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,created_by,updated_by) VALUES($1,$2,$3,1,'ready',$4,'old.svg','image/svg+xml',1,'fixture','fixture'),($5,$2,$3,2,'pending',$6,'retry.svg','image/svg+xml',$7,'fixture','fixture')",
      [
        currentId,
        workspaceId,
        assetId,
        `${storageKey}/old`,
        versionId,
        storageKey,
        body.length,
      ],
    );
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
      currentId,
      assetId,
    ]);
    const payload = {
      workspaceId,
      assetId,
      versionId,
      requestId: `recovery-test:${versionId}`,
    };
    const jobId = enqueue
      ? await inWorkspace(workspaceId, (tx) =>
          enqueueAssetIngest(tx, payload, "fixture"),
        )
      : null;
    return { ...payload, storageKey, currentId, jobId };
  }
  const retry = (
    item: Awaited<ReturnType<typeof seed>>,
    headers = keyHeaders.write!,
    workspaceId = item.workspaceId,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/assets/${item.assetId}/versions/${item.versionId}/retry`,
      headers,
    });

  await t.test("queue and processing state roll back together", async () => {
    const item = await seed(bytes, "ws", false);
    await assert.rejects(
      inWorkspace("ws", async (tx) => {
        await enqueueAssetIngest(tx, item, "fixture");
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await state(item.versionId)).status, "pending");
    assert.equal(
      (await boss.findJobs(assetIngestQueue, { key: item.versionId })).length,
      0,
    );
  });

  await t.test("temporary S3 outage is retried automatically", async () => {
    setStorageFailure(true);
    const item = await seed();
    await start();
    await until(
      () => boss.getJobById(assetIngestQueue, item.jobId!),
      (job) => job?.state === "retry",
    );
    await reconcileAssetIngest();
    assert.equal((await state(item.versionId)).status, "processing");
    setStorageFailure(false);
    const ready = await until(
      () => state(item.versionId),
      (row) => row.status === "ready",
    );
    assert.ok(attempts.get(item.jobId!)! >= 2);
    assert.equal(
      ready.checksum,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(ready.current_version_id, item.versionId);
  });

  await t.test(
    "exhaustion is visible and concurrent authorized retries create one job",
    async () => {
      setStorageFailure(true);
      const item = await seed();
      await until(
        () => boss.getJobById(assetIngestQueue, item.jobId!),
        (job) => job?.state === "failed",
      );
      await reconcileAssetIngest();
      await reconcileAssetIngest();
      const failed = await state(item.versionId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.retryable, true);
      assert.match(failed.error, /repeated attempts/);
      assert.equal(failed.current_version_id, item.currentId);
      const history = await app.inject({
        url: `/api/workspaces/ws/assets/${item.assetId}/versions`,
        headers: keyHeaders.read,
      });
      assert.equal(history.json().versions[0].retryable, true);
      assert.equal((await retry(item, {})).statusCode, 401);
      assert.equal((await retry(item, keyHeaders.read)).statusCode, 401);
      assert.equal(
        (await retry(item, { cookie: cookies.viewer! })).statusCode,
        403,
      );
      assert.equal(
        (await retry(item, { cookie: cookies.outsider! })).statusCode,
        403,
      );
      assert.equal(
        (await retry(item, { cookie: cookies.outsider! }, "other-ws"))
          .statusCode,
        404,
      );
      await stop();
      const responses = await Promise.all([retry(item), retry(item)]);
      assert.deepEqual(
        responses.map((r) => r.statusCode),
        [202, 202],
      );
      const queued = (
        await boss.findJobs(assetIngestQueue, { key: item.versionId })
      ).filter((job) => ["created", "retry", "active"].includes(job.state));
      assert.equal(queued.length, 1);
      assert.notEqual(queued[0]!.id, item.jobId);
      assert.equal((await state(item.versionId)).number, 2);
      await processAsset(item, { jobId: item.jobId! }); // An old delivery must be ignored.
      assert.equal((await state(item.versionId)).ingest_attempt_id, null);
      const counts = await admin.query(
        "SELECT action,count(*)::int AS count FROM audit_event WHERE target_id=$1 GROUP BY action",
        [item.versionId],
      );
      assert.equal(
        counts.rows.find((row) => row.action === "asset.version_failed").count,
        1,
      );
      assert.equal(
        counts.rows.find((row) => row.action === "asset.version_retried").count,
        1,
      );
      setStorageFailure(false);
      await start();
      const ready = await until(
        () => state(item.versionId),
        (row) => row.status === "ready",
      );
      assert.equal(ready.error, null);
      assert.equal(ready.retryable, false);
    },
  );

  await t.test(
    "invalid files cannot be retried or replace the current version",
    async () => {
      const item = await seed(Buffer.from("not an image"));
      const failed = await until(
        () => state(item.versionId),
        (row) => row.status === "failed",
      );
      assert.equal(failed.retryable, false);
      assert.match(failed.error, /Upload a new file/);
      assert.equal(failed.current_version_id, item.currentId);
      assert.equal((await retry(item)).statusCode, 409);
    },
  );

  await t.test(
    "missing and legacy jobs are reconciled across workspaces",
    async () => {
      await stop();
      const missing = await seed(bytes, "other-ws", false);
      await admin.query(
        "UPDATE asset_version SET status='processing',ingest_job_id=$1 WHERE id=$2",
        [randomUUID(), missing.versionId],
      );
      const legacy = await seed();
      await admin.query(
        "UPDATE asset_version SET ingest_job_id=NULL WHERE id=$1",
        [legacy.versionId],
      );
      await reconcileAssetIngest();
      assert.equal((await state(missing.versionId)).retryable, true);
      assert.equal((await state(legacy.versionId)).status, "processing");
      assert.equal((await state(legacy.versionId)).ingest_job_id, legacy.jobId);
      await boss.cancel(assetIngestQueue, legacy.jobId!);
      await reconcileAssetIngest();
      assert.equal((await state(legacy.versionId)).retryable, true);
    },
  );

  await t.test(
    "an expired attempt cannot finish over its replacement",
    async () => {
      const item = await seed();
      const releases: Array<() => void> = [];
      setReadHook((key) =>
        key === item.storageKey
          ? new Promise<void>((resolve) => releases.push(resolve))
          : Promise.resolve(),
      );
      try {
        const first = processAsset(item, { jobId: item.jobId! });
        await until(
          async () => releases.length,
          (count) => count === 1,
        );
        const firstAttempt = (await state(item.versionId)).ingest_attempt_id;
        const second = processAsset(item, { jobId: item.jobId! });
        await until(
          async () => releases.length,
          (count) => count === 2,
        );
        assert.notEqual(
          (await state(item.versionId)).ingest_attempt_id,
          firstAttempt,
        );
        releases[0]!();
        await first;
        assert.equal((await state(item.versionId)).status, "processing");
        releases[1]!();
        await second;
        assert.equal((await state(item.versionId)).status, "ready");
      } finally {
        releases.forEach((release) => release());
        setReadHook(async () => {});
        await boss.cancel(assetIngestQueue, item.jobId!);
      }
    },
  );

  await t.test(
    "killed worker is recovered on restart and the same version can finish",
    async () => {
      await boss.updateQueue(assetIngestQueue, {
        retryLimit: 0,
        expireInSeconds: 2,
      });
      const item = await seed();
      let releaseRead: (() => void) | undefined;
      setReadHook((key) =>
        key === item.storageKey
          ? new Promise<void>((resolve) => {
              releaseRead = resolve;
            })
          : Promise.resolve(),
      );
      const launch = () => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("../src/worker.ts", import.meta.url)),
          ],
          {
            env: { ...process.env, NODE_ENV: "production" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.push(child);
        child.stdout?.on("data", (chunk) => {
          workerLogs += chunk;
        });
        child.stderr?.on("data", (chunk) => {
          workerLogs += chunk;
        });
        return child;
      };
      const first = launch();
      try {
        await until(async () => Boolean(releaseRead), Boolean);
        assert.equal((await state(item.versionId)).status, "processing");
        await kill(first);
        releaseRead?.();
        setReadHook(async () => {});
        await pause(2200);
        await boss.supervise(assetIngestQueue);
        const job = await boss.getJobById(assetIngestQueue, item.jobId!);
        assert.equal(job?.state, "failed");
        const replacement = launch();
        const failed = await until(
          () => state(item.versionId),
          (row) => row.status === "failed",
        );
        assert.equal(failed.retryable, true);
        assert.equal(failed.current_version_id, item.currentId);
        assert.equal((await retry(item)).statusCode, 202);
        await until(
          () => state(item.versionId),
          (row) => row.status === "ready",
        );
        await kill(replacement);
      } finally {
        releaseRead?.();
        setReadHook(async () => {});
        await kill(first);
      }
    },
  );
}
