import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { WipData } from "pg-boss";
import {
  createHealthCollector,
  registerOperationsRoutes,
} from "./operations.js";
import {
  healthMetrics,
  monitoredQueues,
  processingHealthy,
  workersResponsive,
  type OperationsHealth,
} from "./health-model.js";
import { parseConfig } from "./config.js";

const healthy = (): OperationsHealth => ({
  status: "healthy",
  database: true,
  storage: true,
  workers: { live: 1 },
  queues: monitoredQueues.map((name) => ({
    name,
    queued: 0,
    active: 0,
    failed15m: 0,
    oldestReadySeconds: 0,
    oldestActiveSeconds: 0,
  })),
});
const token = "test-monitoring-token-at-least-32-characters";

test("monitoring is disabled without a valid configured token", async () => {
  assert.equal(
    parseConfig({ NODE_ENV: "test", MONITORING_TOKEN: "" }).MONITORING_TOKEN,
    undefined,
  );
  for (const value of ["short", "a".repeat(32) + "\n", "a".repeat(257)])
    assert.throws(() =>
      parseConfig({ NODE_ENV: "test", MONITORING_TOKEN: value }),
    );
  const app = Fastify();
  registerOperationsRoutes(app, {
    collect: async () => {
      throw new Error("Must not probe");
    },
  });
  try {
    for (const path of ["health", "metrics"])
      assert.equal(
        (await app.inject(`/api/operations/${path}`)).statusCode,
        404,
      );
  } finally {
    await app.close();
  }
});

test("only the monitoring bearer token can read non-cacheable fleet aggregates", async () => {
  const app = Fastify();
  let reads = 0;
  registerOperationsRoutes(app, {
    token,
    collect: async () => {
      reads++;
      return healthy();
    },
  });
  try {
    for (const path of ["health", "metrics"]) {
      for (const headers of [
        {},
        { authorization: "Bearer wrong" },
        { "x-api-key": token },
        { cookie: `session=${token}` },
      ]) {
        const response = await app.inject({
          url: `/api/operations/${path}`,
          headers,
        });
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers["cache-control"], "private, no-store");
      }
    }
    assert.equal(reads, 0);
    const response = await app.inject({
      url: "/api/operations/health",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), healthy());
  } finally {
    await app.close();
  }
});

test("degraded health returns 503 but metrics stay scrapeable with failed probes", async () => {
  const state: OperationsHealth = {
    status: "degraded",
    database: false,
    storage: false,
    workers: null,
    queues: null,
  };
  const app = Fastify();
  registerOperationsRoutes(app, { token, collect: async () => state });
  try {
    const headers = { authorization: `Bearer ${token}` };
    assert.equal(
      (await app.inject({ url: "/api/operations/health", headers })).statusCode,
      503,
    );
    const metrics = await app.inject({
      url: "/api/operations/metrics",
      headers,
    });
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.headers["content-type"]!, /version=0.0.4/);
    assert.match(
      metrics.body,
      /vardum_dependency_up\{dependency="database"\} 0/,
    );
    assert.match(metrics.body, /vardum_queue_monitor_up 0/);
    assert.doesNotMatch(
      metrics.body,
      /vardum_workers_live|vardum_queue_queued/,
    );
    assert.ok(metrics.body.endsWith("\n"));
  } finally {
    await app.close();
  }
});

test("scrapes share bounded probes and failures replace cached healthy data", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let probes = 0;
  let unavailable = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const collect = createHealthCollector(
    {
      processing: async () => {
        probes++;
        await barrier;
        if (unavailable) throw new Error("secret DB detail");
        return { workers: { live: 1 }, queues: healthy().queues! };
      },
      storage: async () => {
        if (unavailable) throw new Error("secret S3 detail");
      },
    },
    5000,
  );
  const first = collect(),
    second = collect();
  release();
  assert.deepEqual(await first, await second);
  assert.equal(probes, 1);
  unavailable = true;
  assert.equal((await collect()).status, "healthy");
  assert.equal(
    probes,
    1,
    "completed probes are reused within the cache window",
  );
  now += 5001;
  const result = await collect();
  assert.equal(result.status, "degraded");
  assert.equal(result.workers, null);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(probes, 2);
  unavailable = false;
  now += 5001;
  assert.equal((await collect()).status, "healthy");
  assert.equal(probes, 3);
});

test("recent failures are observable while sustained queue delays degrade health", () => {
  const state = healthy();
  state.queues![0]!.failed15m = 2;
  assert.equal(processingHealthy(state), true);
  assert.match(
    healthMetrics(state),
    /vardum_queue_failed_15m\{queue="asset-ingest"\} 2/,
  );
  state.queues![0]!.oldestReadySeconds = 300;
  assert.equal(processingHealthy(state), false);
  state.queues![0]!.oldestReadySeconds = 0;
  state.queues![0]!.oldestActiveSeconds = 360;
  assert.equal(processingHealthy(state), false);
  assert.equal(
    processingHealthy({ ...healthy(), workers: { live: 0 } }),
    false,
  );
});

test("worker heartbeat requires all pollers; idle polls, active deadlines and draining are distinguished", () => {
  const now = 1_000_000;
  const workers = monitoredQueues.map(
    (name) =>
      ({
        name,
        state: "active",
        count: 0,
        lastFetchedOn: now - 30_000,
        lastJobStartedOn: null,
      }) as WipData,
  );
  assert.equal(workersResponsive(workers, now), true);
  assert.equal(workersResponsive(workers.slice(1), now), false);
  workers[0]!.lastFetchedOn = now - 76_000;
  assert.equal(workersResponsive(workers, now), false);
  workers[0]!.count = 1;
  workers[0]!.lastJobStartedOn = now - 200_000;
  assert.equal(workersResponsive(workers, now), true);
  workers[0]!.lastJobStartedOn = now - 361_000;
  assert.equal(workersResponsive(workers, now), false);
  workers[0]!.lastJobStartedOn = now;
  workers[0]!.state = "stopping";
  assert.equal(workersResponsive(workers, now), false);
});
