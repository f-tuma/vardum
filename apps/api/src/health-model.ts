import type { WipData } from "pg-boss";

export const monitoredQueues = [
  "asset-ingest",
  "asset-delete",
  "asset-ingest-recovery",
  "delivery-retention",
  "upload-cleanup",
] as const;
export const heartbeatIntervalMs = 15_000;
export const heartbeatMaxAgeSeconds = 60;
export const queueWaitLimitSeconds = 300;
export const activeLimitSeconds = 360;

export type QueueHealth = {
  name: string;
  queued: number;
  active: number;
  failed15m: number;
  oldestReadySeconds: number;
  oldestActiveSeconds: number;
};
export type OperationsHealth = {
  status: "healthy" | "degraded";
  database: boolean;
  storage: boolean;
  workers: { live: number } | null;
  queues: QueueHealth[] | null;
};

export function workersResponsive(workers: WipData[], now = Date.now()) {
  return monitoredQueues.every((name) =>
    workers.some(
      (worker) =>
        worker.name === name &&
        worker.state === "active" &&
        (worker.count > 0
          ? worker.lastJobStartedOn !== null &&
            now - worker.lastJobStartedOn < activeLimitSeconds * 1000
          : worker.lastFetchedOn !== null &&
            now - worker.lastFetchedOn < 75_000),
    ),
  );
}

export function processingHealthy(health: Omit<OperationsHealth, "status">) {
  return (
    health.database &&
    health.storage &&
    (health.workers?.live ?? 0) > 0 &&
    health.queues?.length === monitoredQueues.length &&
    health.queues.every(
      (queue) =>
        queue.oldestReadySeconds < queueWaitLimitSeconds &&
        queue.oldestActiveSeconds < activeLimitSeconds,
    )
  );
}

export function healthMetrics(health: OperationsHealth) {
  const lines: string[] = [];
  const gauge = (
    name: string,
    help: string,
    samples: Array<[string, number]>,
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples)
      lines.push(`${name}${labels} ${value}`);
  };
  gauge("vardum_dependency_up", "Latest bounded dependency probe succeeded.", [
    ['{dependency="database"}', Number(health.database)],
    ['{dependency="storage"}', Number(health.storage)],
  ]);
  gauge(
    "vardum_queue_monitor_up",
    "Worker and queue state was successfully collected.",
    [["", Number(health.queues !== null && health.workers !== null)]],
  );
  // Missing observations are omitted, never reported as healthy zeroes.
  if (health.workers)
    gauge(
      "vardum_workers_live",
      "Responsive worker processes with a recent database heartbeat.",
      [["", health.workers.live]],
    );
  if (health.queues) {
    for (const [suffix, key, help] of [
      ["queued", "queued", "Jobs waiting or deferred for automatic retry."],
      ["active", "active", "Jobs currently claimed by workers."],
      [
        "failed_15m",
        "failed15m",
        "Terminal queue failures during the last 15 minutes; a sliding window, not a counter.",
      ],
      [
        "oldest_ready_seconds",
        "oldestReadySeconds",
        "Age since a waiting job became eligible; future retries excluded.",
      ],
      [
        "oldest_active_seconds",
        "oldestActiveSeconds",
        "Age of the oldest claimed job.",
      ],
    ] as const)
      gauge(
        `vardum_queue_${suffix}`,
        help,
        health.queues.map((queue) => [
          `{queue=${JSON.stringify(queue.name)}}`,
          queue[key],
        ]),
      );
  }
  return lines.join("\n") + "\n";
}
