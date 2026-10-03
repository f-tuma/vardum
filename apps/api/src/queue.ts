import { PgBoss } from "pg-boss";
import { config } from "./config.js";

export const assetIngestQueue = "asset-ingest";
export const assetIngestRecoveryQueue = "asset-ingest-recovery";
export const assetDeleteQueue = "asset-delete";
export const uploadCleanupQueue = "upload-cleanup";
export const deliveryRetentionQueue = "delivery-retention";
export const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  useListenNotify: true,
  // Production DDL belongs to the one-shot migrator. Local development keeps
  // its existing self-contained workflow with a schema-owning dev role.
  migrate: config.NODE_ENV === "development",
  createSchema: config.NODE_ENV === "development",
  persistQueueStats: false,
});

boss.on("error", (error) => console.error("pg-boss error", error));

let started: Promise<PgBoss> | undefined;
let stopping: Promise<void> | undefined;

export function startQueue() {
  started ??= boss.start().then(async (instance) => {
    await instance.createQueue(assetIngestQueue, {
      policy: "exclusive",
      notify: true,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 5 * 60,
      heartbeatSeconds: 30,
    });
    await instance.createQueue(assetDeleteQueue, {
      policy: "exclusive",
      notify: true,
      retryLimit: 5,
      retryDelay: 10,
      retryBackoff: true,
      expireInSeconds: 5 * 60,
    });
    await instance.createQueue(assetIngestRecoveryQueue, {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 10,
      expireInSeconds: 5 * 60,
      heartbeatSeconds: 30,
    });
    await instance.createQueue(uploadCleanupQueue, {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 30,
      expireInSeconds: 5 * 60,
      heartbeatSeconds: 30,
    });
    await instance.createQueue(deliveryRetentionQueue, {
      policy: "exclusive",
      notify: true,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 5 * 60,
    });
    return instance;
  });
  return started;
}

export function stopQueue() {
  stopping ??= started
    ? boss.stop({ graceful: true, timeout: 30_000 })
    : Promise.resolve();
  return stopping;
}
