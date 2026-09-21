import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";

export async function checkOperations(
  t: TestContext,
  admin: Pool,
  runtime: Pool,
) {
  const { readProcessingHealth, monitoringPool, createHealthCollector } =
    await import("../src/operations.js");
  const { boss, assetIngestQueue } = await import("../src/queue.js");
  const ids = [randomUUID(), randomUUID()];
  const jobs: string[] = [];
  t.after(async () => {
    await admin.query("DELETE FROM worker_heartbeat WHERE id=ANY($1::uuid[])", [
      ids,
    ]);
    await admin.query("DELETE FROM pgboss.job WHERE id=ANY($1::uuid[])", [
      jobs,
    ]);
  });
  await t.test(
    "runtime reads aggregate metadata, live replicas and eligible wait ages",
    async () => {
      await runtime.query(
        "INSERT INTO worker_heartbeat(id,seen_at) VALUES($1,now()),($2,now()-interval '61 seconds')",
        ids,
      );
      const initial = await readProcessingHealth(runtime);
      assert.equal(initial.workers.live, 1);
      assert.equal(initial.queues.length, 4);
      const waiting = await boss.send(
        assetIngestQueue,
        { secret: "not a metric" },
        { singletonKey: randomUUID() },
      );
      const deferred = await boss.send(
        assetIngestQueue,
        {},
        { singletonKey: randomUUID(), startAfter: 3600 },
      );
      assert.ok(waiting && deferred);
      jobs.push(waiting, deferred);
      await admin.query(
        "UPDATE pgboss.job SET start_after=now()-interval '6 minutes' WHERE id=$1",
        [waiting],
      );
      const pending = (await readProcessingHealth(runtime)).queues.find(
        (q) => q.name === assetIngestQueue,
      )!;
      assert.equal(pending.queued, 2);
      assert.ok(
        pending.oldestReadySeconds >= 360 && pending.oldestReadySeconds < 365,
      );
      await boss.cancel(assetIngestQueue, waiting);
      const later = (await readProcessingHealth(runtime)).queues.find(
        (q) => q.name === assetIngestQueue,
      )!;
      assert.equal(later.queued, 1);
      assert.equal(
        later.oldestReadySeconds,
        0,
        "deferred jobs do not trigger a stalled queue alert",
      );
      await admin.query(
        "UPDATE pgboss.job SET state='failed',completed_on=now() WHERE id=$1",
        [waiting],
      );
      const failures = (await readProcessingHealth(runtime)).queues.find(
        (q) => q.name === assetIngestQueue,
      )!;
      assert.equal(failures.failed15m, 1);
      assert.doesNotMatch(JSON.stringify(failures), /secret|not a metric/);
      await admin.query(
        "UPDATE pgboss.job SET completed_on=now()-interval '16 minutes' WHERE id=$1",
        [waiting],
      );
      assert.equal(
        (await readProcessingHealth(runtime)).queues.find(
          (q) => q.name === assetIngestQueue,
        )!.failed15m,
        0,
      );
      await runtime.query(
        "UPDATE worker_heartbeat SET seen_at=now() WHERE id=$1",
        [ids[1]],
      );
      assert.equal((await readProcessingHealth(runtime)).workers.live, 2);
      await runtime.query(
        "UPDATE worker_heartbeat SET seen_at=now()-interval '61 seconds' WHERE id=$1",
        [ids[0]],
      );
      assert.equal((await readProcessingHealth(runtime)).workers.live, 1);
      await runtime.query("DELETE FROM worker_heartbeat WHERE id=$1", [ids[1]]);
      assert.equal((await readProcessingHealth(runtime)).workers.live, 0);
    },
  );
  await t.test(
    "blocked database probes time out and never return cached healthy state",
    async () => {
      const bounded = monitoringPool();
      const blocker = await admin.connect();
      const collect = createHealthCollector(
        {
          processing: () => readProcessingHealth(bounded),
          storage: async () => {},
        },
        0,
      );
      try {
        assert.equal((await collect()).database, true);
        await blocker.query("BEGIN");
        await blocker.query("LOCK worker_heartbeat IN ACCESS EXCLUSIVE MODE");
        const began = Date.now();
        const state = await collect();
        assert.equal(state.database, false);
        assert.equal(state.queues, null);
        assert.equal(state.workers, null);
        assert.ok(
          Date.now() - began < 5000,
          "SQL timeout bounds a stalled probe",
        );
        await blocker.query("ROLLBACK");
        assert.equal((await collect()).database, true);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await bounded.end();
      }
    },
  );
}
