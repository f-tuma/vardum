import {
  deleteAssetObjects,
  type AssetDeletePayload,
} from "./asset-cleanup.js";
import { processAsset, type AssetIngestPayload } from "./asset-processor.js";
import { closeDatabase, pool } from "./db/index.js";
import { config } from "./config.js";
import { assertRuntimeDatabaseRole } from "./db/runtime-role.js";
import { deleteExpiredDeliveryEvents } from "./delivery-analytics.js";
import {
  assetDeleteQueue,
  assetIngestQueue,
  deliveryRetentionQueue,
  startQueue,
  stopQueue,
} from "./queue.js";

async function shutdown() {
  await stopQueue();
  await closeDatabase();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  if (config.NODE_ENV === "production") await assertRuntimeDatabaseRole(pool);
  const queue = await startQueue();
  await queue.schedule(deliveryRetentionQueue, "0 3 * * *", null, {
    tz: "UTC",
  });
  await queue.work(deliveryRetentionQueue, async ([job]) => {
    if (job) await deleteExpiredDeliveryEvents();
  });
  await queue.work<AssetIngestPayload>(
    assetIngestQueue,
    { localConcurrency: 1 },
    async ([job]) => {
      if (job) await processAsset(job.data);
    },
  );
  await queue.work<AssetDeletePayload>(
    assetDeleteQueue,
    { localConcurrency: 1 },
    async ([job]) => {
      if (job) await deleteAssetObjects(job.data);
    },
  );
} catch (error) {
  console.error("Worker failed to start", error);
  await shutdown();
  process.exitCode = 1;
}
