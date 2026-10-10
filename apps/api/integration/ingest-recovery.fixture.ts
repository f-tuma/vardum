import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
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
  const { boss, assetIngestQueue, assetIngestRecoveryQueue } =
    await import("../src/queue.js");
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
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
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
      const startedAt = Date.now();
      let phase = "reserve worker health port";
      let target: Awaited<ReturnType<typeof seed>> | undefined;
      let releaseRead: (() => void) | undefined;
      let recoveryBlockerId: string | null = null;
      const portReservation = createServer();
      const childStates: Array<{
        child: ChildProcess;
        label: string;
        launchedAt: string;
        stdout: string;
        stderr: string;
        stdoutBytes: number;
        stderrBytes: number;
        error?: ReturnType<typeof errorSummary>;
        exit?: { code: number | null; signal: string | null; elapsedMs: number };
      }> = [];
      const safeText = (value: unknown, limit = 4096) =>
        String(value)
          .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[redacted URL]")
          .replace(
            /\b(?:connectionString|(?:PGBOSS_)?DATABASE_URL)\s*[:=]\s*[^\n]+/gi,
            "[redacted connection string]",
          )
          .slice(-limit);
      function errorSummary(error: unknown) {
        return error instanceof Error
          ? { name: error.name, message: safeText(error.message, 2048) }
          : { message: safeText(error, 2048) };
      }
      // Project metadata explicitly: never log job data/output or process env.
      const jobColumns = `id,name,state,priority,retry_count,retry_limit,
        retry_delay,retry_backoff,expire_seconds,heartbeat_seconds,heartbeat_on,
        created_on,start_after,started_on,completed_on,blocked,
        started_on + expire_seconds * interval '1 second' AS expires_on`;
      const diagnosticQuery = (query: { text: string; values: unknown[] }) => {
        const options = { ...query, query_timeout: 2000 };
        return admin.query(options);
      };
      const snapshot = async (label: string) => {
        const reads = {
          version: target
            ? diagnosticQuery({
                text: `SELECT v.id,v.asset_id,v.status,v.retryable,v.ingest_job_id,
                  v.ingest_attempt_id,v.updated_at,a.current_version_id
                  FROM asset_version v JOIN asset a ON a.id=v.asset_id WHERE v.id=$1`,
                values: [target.versionId],
              })
            : Promise.resolve({ rows: [] }),
          queues: diagnosticQuery({
            text: `SELECT name,policy,retry_limit,retry_delay,retry_backoff,
              expire_seconds,heartbeat_seconds,notify,monitor_on,maintain_on,updated_on
              FROM pgboss.queue WHERE name=ANY($1::text[]) ORDER BY name`,
            values: [[assetIngestQueue, assetIngestRecoveryQueue]],
          }),
          jobCounts: diagnosticQuery({
            text: `SELECT name,state,count(*)::int AS count,
              min(created_on) AS oldest_created_on,max(created_on) AS newest_created_on
              FROM pgboss.job WHERE name=ANY($1::text[])
              GROUP BY name,state ORDER BY name,state`,
            values: [[assetIngestQueue, assetIngestRecoveryQueue]],
          }),
          liveJobs: diagnosticQuery({
            text: `WITH ranked AS (
              SELECT ${jobColumns},
                row_number() OVER (PARTITION BY name ORDER BY created_on,id) AS oldest_rank,
                row_number() OVER (PARTITION BY name ORDER BY created_on DESC,id DESC) AS newest_rank
              FROM pgboss.job WHERE name=ANY($1::text[])
                AND state IN ('created','retry','active')
            ) SELECT * FROM ranked WHERE oldest_rank<=3 OR newest_rank<=3
              ORDER BY name,created_on,id LIMIT 12`,
            values: [[assetIngestQueue, assetIngestRecoveryQueue]],
          }),
          targetJobs: target
            ? diagnosticQuery({
                text: `SELECT ${jobColumns} FROM pgboss.job WHERE name=$1 AND (
                  singleton_key=$2 OR id=$3 OR
                  id=(SELECT ingest_job_id FROM asset_version WHERE id=$2::uuid)
                ) ORDER BY created_on DESC,id DESC LIMIT 10`,
                values: [assetIngestQueue, target.versionId, target.jobId],
              })
            : Promise.resolve({ rows: [] }),
          recoveryBlocker: recoveryBlockerId
            ? diagnosticQuery({
                text: `SELECT ${jobColumns} FROM pgboss.job WHERE name=$1 AND id=$2`,
                values: [assetIngestRecoveryQueue, recoveryBlockerId],
              })
            : Promise.resolve({ rows: [] }),
        };
        const results = await Promise.allSettled(Object.values(reads));
        return {
          label,
          capturedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          ...Object.fromEntries(
            Object.keys(reads).map((name, index) => {
              const result = results[index]!;
              return [
                name,
                result.status === "fulfilled"
                  ? result.value.rows
                  : { diagnosticError: errorSummary(result.reason) },
              ];
            }),
          ),
        };
      };
      let beforeFirstLaunch: Awaited<ReturnType<typeof snapshot>> | undefined;
      const launch = (label: string, port: number) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("../src/worker.ts", import.meta.url)),
          ],
          {
            env: {
              ...process.env,
              NODE_ENV: "production",
              WORKER_HEALTH_PORT: String(port),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.push(child);
        const childState: (typeof childStates)[number] = {
          child,
          label,
          launchedAt: new Date().toISOString(),
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
        };
        childStates.push(childState);
        child.on("error", (error) => {
          childState.error = errorSummary(error);
        });
        child.on("exit", (code, signal) => {
          childState.exit = { code, signal, elapsedMs: Date.now() - startedAt };
        });
        child.stdout?.on("data", (chunk) => {
          childState.stdoutBytes += Buffer.byteLength(chunk);
          childState.stdout = (childState.stdout + chunk).slice(-4096);
          workerLogs = safeText(workerLogs + chunk, 16384);
        });
        child.stderr?.on("data", (chunk) => {
          childState.stderrBytes += Buffer.byteLength(chunk);
          childState.stderr = (childState.stderr + chunk).slice(-4096);
          workerLogs = safeText(workerLogs + chunk, 16384);
        });
        return child;
      };
      try {
        // Keep disposable worker processes independent of a running dev worker.
        await new Promise<void>((resolve) =>
          portReservation.listen(0, "127.0.0.1", resolve),
        );
        const address = portReservation.address();
        assert.ok(address && typeof address !== "string");
        await new Promise<void>((resolve, reject) =>
          portReservation.close((error) => (error ? reject(error) : resolve())),
        );
        phase = "configure ingest expiration and seed target";
        await boss.updateQueue(assetIngestQueue, {
          retryLimit: 0,
          expireInSeconds: 300,
        });
        const item = await seed();
        target = item;
        // Earlier fixtures may leave deferred retries. This scenario tests
        // recovery, so claim its own job first without changing other jobs.
        const prioritized = await admin.query(
          "UPDATE pgboss.job SET priority=1 WHERE name=$1 AND id=$2 AND state='created' RETURNING id",
          [assetIngestQueue, item.jobId],
        );
        assert.equal(prioritized.rowCount, 1);
        phase = "hold an abandoned recovery job active";
        // Keep the owned blocker active throughout the permitted retry wait;
        // neither production queue settings nor other jobs are changed.
        recoveryBlockerId = await boss.send(assetIngestRecoveryQueue, {}, {
          heartbeatSeconds: 300,
        });
        assert.ok(recoveryBlockerId);
        const [recoveryBlocker] = await boss.fetch(assetIngestRecoveryQueue, {
          includeMetadata: true,
        });
        assert.equal(recoveryBlocker?.id, recoveryBlockerId);
        assert.equal(recoveryBlocker?.state, "active");
        setReadHook((key) =>
          key === item.storageKey
            ? new Promise<void>((resolve) => {
                releaseRead = resolve;
              })
            : Promise.resolve(),
        );
        phase = "snapshot before first worker launch";
        beforeFirstLaunch = await snapshot("before first worker launch");
        phase = "launch first worker and wait for target storage read";
        const first = launch("first", address.port);
        await until(async () => Boolean(releaseRead), Boolean);
        phase = "verify first worker claimed target";
        const claimed = await state(item.versionId);
        assert.equal(claimed.status, "processing");
        assert.ok(claimed.ingest_attempt_id);
        phase = "kill first worker";
        await kill(first);
        releaseRead?.();
        setReadHook(async () => {});
        phase = "expire only the killed ingest job and supervise ingest";
        const expired = await admin.query(
          `UPDATE pgboss.job
            SET started_on=now()-(expire_seconds+1)*interval '1 second'
            WHERE name=$1 AND id=$2 AND state='active' RETURNING id`,
          [assetIngestQueue, item.jobId],
        );
        assert.equal(expired.rowCount, 1);
        await admin.query(
          "UPDATE pgboss.queue SET monitor_on=now()-interval '61 seconds' WHERE name=$1",
          [assetIngestQueue],
        );
        await boss.supervise(assetIngestQueue);
        const job = await boss.getJobById(assetIngestQueue, item.jobId!);
        assert.equal(job?.state, "failed");
        assert.equal(
          (await boss.getJobById(assetIngestRecoveryQueue, recoveryBlockerId))
            ?.state,
          "active",
        );
        phase = "launch replacement and wait for recovery reconciliation";
        const replacement = launch("replacement", address.port);
        const failed = await until(
          () => state(item.versionId),
          (row) => row.status === "failed",
        );
        phase = "verify recovered version is retryable and remains non-current";
        assert.equal(failed.id, item.versionId);
        assert.equal(failed.number, 2);
        assert.equal(failed.retryable, true);
        assert.equal(failed.current_version_id, item.currentId);
        assert.equal(failed.ingest_job_id, item.jobId);
        assert.equal(failed.ingest_attempt_id, null);
        assert.equal(
          (await boss.getJobById(assetIngestRecoveryQueue, recoveryBlockerId))
            ?.state,
          "active",
        );
        phase = "request authorized retry";
        assert.equal((await retry(item)).statusCode, 202);
        // A fresh process may miss NOTIFY while its listener connects. Its
        // production fallback poll is 30s, longer than the helper's default.
        phase = "wait for retried target to become ready";
        const ready = await until(
          () => state(item.versionId),
          (row) => row.status === "ready",
          60_000,
        );
        assert.equal(ready.id, item.versionId);
        assert.equal(ready.number, 2);
        assert.equal(ready.current_version_id, item.versionId);
        assert.equal(
          ready.checksum,
          createHash("sha256").update(bytes).digest("hex"),
        );
        assert.equal(ready.retryable, false);
        assert.equal(ready.error, null);
        assert.notEqual(ready.ingest_job_id, item.jobId);
        assert.equal(
          (await boss.getJobById(assetIngestRecoveryQueue, recoveryBlockerId))
            ?.state,
          "active",
        );
        phase = "kill replacement worker";
        await kill(replacement);
      } catch (error) {
        try {
          console.error(
            "SIGKILL ingest recovery failure diagnostics",
            JSON.stringify(
              {
                phase,
                elapsedMs: Date.now() - startedAt,
                failure: errorSummary(error),
                readHookReached: Boolean(releaseRead),
                recoveryBlockerId,
                target: target
                  ? {
                      versionId: target.versionId,
                      assetId: target.assetId,
                      initialJobId: target.jobId,
                      initialCurrentVersionId: target.currentId,
                    }
                  : null,
                beforeFirstLaunch,
                atFailure: await snapshot("at failure before cleanup"),
                children: childStates.map(({ child, ...childState }) => ({
                  ...childState,
                  pid: child.pid,
                  exitCode: child.exitCode,
                  signalCode: child.signalCode,
                  killed: child.killed,
                  stdout: safeText(childState.stdout),
                  stderr: safeText(childState.stderr),
                })),
              },
              null,
              2,
            ),
          );
        } catch (diagnosticError) {
          console.error(
            "SIGKILL ingest recovery diagnostics failed",
            errorSummary(diagnosticError),
          );
        }
        throw error;
      } finally {
        releaseRead?.();
        setReadHook(async () => {});
        await Promise.all(childStates.map(({ child }) => kill(child)));
        if (recoveryBlockerId)
          await boss.cancel(assetIngestRecoveryQueue, recoveryBlockerId);
        if (portReservation.listening)
          await new Promise<void>((resolve, reject) =>
            portReservation.close((error) => (error ? reject(error) : resolve())),
          );
      }
    },
  );
}
