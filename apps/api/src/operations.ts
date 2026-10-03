import { createHash, timingSafeEqual } from "node:crypto";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type {} from "@fastify/swagger";
import { Pool } from "pg";
import { config } from "./config.js";
import { storage } from "./storage.js";
import {
  heartbeatMaxAgeSeconds,
  healthMetrics,
  monitoredQueues,
  processingHealthy,
  type OperationsHealth,
  type QueueHealth,
} from "./health-model.js";

export function monitoringPool() {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 2500,
    statement_timeout: 2000,
    idleTimeoutMillis: 10_000,
  });
}

// pg-boss 12 schema: read aggregate metadata only, never data/output payloads.
export async function readProcessingHealth(pool: Pool) {
  const result = await pool.query<QueueHealth & { live: number }>(
    `
    SELECT q.name,
      count(j.id) FILTER (WHERE j.state IN ('created','retry'))::int AS queued,
      count(j.id) FILTER (WHERE j.state='active')::int AS active,
      count(j.id) FILTER (WHERE j.state='failed')::int AS "failed15m",
      coalesce(extract(epoch FROM now() - min(j.start_after) FILTER
        (WHERE j.state IN ('created','retry') AND j.start_after <= now())),0)::float8 AS "oldestReadySeconds",
      coalesce(extract(epoch FROM now() - min(j.started_on) FILTER
        (WHERE j.state='active')),0)::float8 AS "oldestActiveSeconds",
      (SELECT count(*)::int FROM worker_heartbeat WHERE seen_at > now() - $2::int * interval '1 second') AS live
    FROM pgboss.queue q LEFT JOIN pgboss.job j ON j.name=q.name AND
      (j.state IN ('created','retry','active') OR (j.state='failed' AND j.completed_on >= now() - interval '15 minutes'))
    WHERE q.name=ANY($1::text[]) GROUP BY q.name ORDER BY q.name
  `,
    [monitoredQueues, heartbeatMaxAgeSeconds],
  );
  if (result.rows.length !== monitoredQueues.length)
    throw new Error("Missing operational queues");
  return {
    workers: { live: result.rows[0]!.live },
    queues: result.rows.map(({ live: _live, ...queue }) => queue),
  };
}

export function createHealthCollector(
  probes: {
    processing: () => Promise<{
      workers: { live: number };
      queues: QueueHealth[];
    }>;
    storage: () => Promise<unknown>;
  },
  cacheMs = 5000,
) {
  let cached: { value: OperationsHealth; until: number } | undefined;
  let pending: Promise<OperationsHealth> | undefined;
  return () => {
    if (cached && Date.now() < cached.until)
      return Promise.resolve(cached.value);
    return (pending ??= (async () => {
      const [database, bucket] = await Promise.allSettled([
        probes.processing(),
        probes.storage(),
      ]);
      const state = {
        database: database.status === "fulfilled",
        storage: bucket.status === "fulfilled",
        workers:
          database.status === "fulfilled" ? database.value.workers : null,
        queues: database.status === "fulfilled" ? database.value.queues : null,
      };
      const value: OperationsHealth = {
        ...state,
        status: processingHealthy(state) ? "healthy" : "degraded",
      };
      cached = { value, until: Date.now() + cacheMs };
      return value;
    })().finally(() => {
      pending = undefined;
    }));
  };
}

export function registerOperationsRoutes(
  app: FastifyInstance,
  options?: {
    token?: string;
    collect: () => Promise<OperationsHealth>;
  },
) {
  const token = options ? options.token : config.MONITORING_TOKEN;
  const pool = options ? null : monitoringPool();
  pool?.on("error", () => app.log.warn("Operational database connection lost"));
  if (pool) app.addHook("onClose", () => pool.end());
  const collect =
    options?.collect ??
    createHealthCollector({
      processing: () => readProcessingHealth(pool!),
      storage: () =>
        storage.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }), {
          abortSignal: AbortSignal.timeout(2000),
        }),
    });
  const digest = (value: string) => createHash("sha256").update(value).digest();
  for (const kind of ["health", "metrics"] as const) {
    app.get(
      `/api/operations/${kind}`,
      { schema: { hide: true } },
      async (request, reply) => {
        reply
          .header("cache-control", "private, no-store")
          .header("vary", "Authorization");
        if (!token) return reply.code(404).send({ error: "Not found" });
        if (
          !timingSafeEqual(
            digest(request.headers.authorization ?? ""),
            digest(`Bearer ${token}`),
          )
        )
          return reply.code(401).send({ error: "Unauthorized" });
        const health = await collect();
        if (kind === "metrics")
          return reply
            .type("text/plain; version=0.0.4; charset=utf-8")
            .send(healthMetrics(health));
        return reply.code(health.status === "healthy" ? 200 : 503).send(health);
      },
    );
  }
}
