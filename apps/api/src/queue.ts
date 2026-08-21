import { PgBoss } from "pg-boss";
import { config } from "./config.js";

export const assetIngestQueue = "asset-ingest";
export const assetDeleteQueue = "asset-delete";
export const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  useListenNotify: true,
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
