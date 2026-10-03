import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { WipData } from "pg-boss";
import { config } from "./config.js";
import {
  heartbeatIntervalMs,
  heartbeatMaxAgeSeconds,
  workersResponsive,
} from "./health-model.js";
import { monitoringPool } from "./operations.js";

// Container-local liveness; global liveness is the independently expiring DB row.
export async function startWorkerMonitoring(workers: () => WipData[]) {
  const pool = monitoringPool();
  pool.on("error", () =>
    console.warn("Worker heartbeat database connection lost"),
  );
  const id = randomUUID();
  let lastSuccess = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;
  let priorHealthy: boolean | undefined;
  const beat = async () => {
    let healthy = false;
    try {
      if (!workersResponsive(workers()))
        throw new Error("Worker pollers are not responsive");
      await pool.query(
        `INSERT INTO worker_heartbeat(id,seen_at) VALUES($1,now())
        ON CONFLICT(id) DO UPDATE SET seen_at=now()`,
        [id],
      );
      await pool.query(
        "DELETE FROM worker_heartbeat WHERE seen_at < now() - interval '1 day'",
      );
      lastSuccess = Date.now();
      healthy = true;
    } catch {
      lastSuccess = 0;
      // Do not claim liveness for stopped pollers even while the event loop runs.
      await pool
        .query("DELETE FROM worker_heartbeat WHERE id=$1", [id])
        .catch(() => {});
    }
    if (healthy !== priorHealthy) {
      console[healthy ? "log" : "warn"](
        JSON.stringify({
          event: "worker.health",
          status: healthy ? "healthy" : "unhealthy",
        }),
      );
      priorHealthy = healthy;
    }
  };
  const tick = () => {
    pending = beat().finally(() => {
      pending = undefined;
      if (!stopped) timer = setTimeout(tick, heartbeatIntervalMs);
    });
  };
  const server = createServer((req, res) => {
    const healthy =
      !stopped &&
      Date.now() - lastSuccess < heartbeatMaxAgeSeconds * 1000 &&
      workersResponsive(workers());
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.statusCode =
      req.method !== "GET" || req.url !== "/health" ? 404 : healthy ? 200 : 503;
    res.end(
      JSON.stringify({
        status: res.statusCode === 200 ? "healthy" : "unavailable",
      }),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.WORKER_HEALTH_PORT, "127.0.0.1", resolve);
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pending;
    await pool
      .query("DELETE FROM worker_heartbeat WHERE id=$1", [id])
      .catch(() => {});
    await pool.end();
  };
}
