import type { PoolClient } from "pg";
import { pool } from "./db/index.js";
import { config } from "./config.js";
import { admissionLimit, CapacityError } from "./resource-budget.js";

const local = admissionLimit(
  config.TRANSFORM_CONCURRENCY + config.TRANSFORM_QUEUE_LIMIT,
);
// Dedicated lock namespace. Session locks bound uncached transforms across all
// API replicas using this database; the local gate prevents pool waiters piling up.
export async function withTransformBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const release = local.acquire();
  let client: PoolClient | undefined;
  let slot: number | undefined;
  let broken = false;
  const abort = new AbortController();
  const onError = () => {
    broken = true;
    abort.abort(new Error("Transform database connection lost"));
  };
  try {
    const deadline = Date.now() + 2000;
    do {
      client = await pool.connect();
      client.on("error", onError);
      for (
        let candidate = 0;
        candidate < config.TRANSFORM_CONCURRENCY;
        candidate++
      ) {
        const result = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(74121, $1) AS acquired",
          [candidate],
        );
        if (result.rows[0]!.acquired) {
          slot = candidate;
          break;
        }
      }
      if (slot !== undefined) break;
      client.removeListener("error", onError);
      client.release();
      client = undefined;
      if (config.TRANSFORM_QUEUE_LIMIT === 0 || Date.now() >= deadline) break;
      await new Promise((yes) => setTimeout(yes, 50));
    } while (Date.now() < deadline);
    if (slot === undefined)
      throw new CapacityError("Image processing is busy. Retry shortly.");
    return await operation(abort.signal);
  } finally {
    if (client) {
      if (slot !== undefined && !broken) {
        try {
          await client.query("SELECT pg_advisory_unlock(74121, $1)", [slot]);
        } catch {
          broken = true;
        }
      }
      client.removeListener("error", onError);
      client.release(broken);
    }
    release();
  }
}

export function outputPixels(
  width: number,
  height: number,
  pages: number,
  resize: { w?: number; h?: number; fit?: string },
) {
  if (!resize.w && !resize.h) return width * height * pages;
  if (
    resize.w &&
    resize.h &&
    ["cover", "contain", "fill"].includes(resize.fit ?? "inside")
  )
    return resize.w * resize.h * pages;
  const ratios = [
    resize.w ? resize.w / width : undefined,
    resize.h ? resize.h / height : undefined,
  ].filter((x): x is number => x !== undefined);
  const scale =
    resize.fit === "outside" ? Math.max(...ratios) : Math.min(...ratios);
  return Math.ceil(width * scale) * Math.ceil(height * scale) * pages;
}
