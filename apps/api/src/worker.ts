import {
  deleteAssetObjects,
  type AssetDeletePayload,
} from "./asset-cleanup.js";
import { processAsset, type AssetIngestPayload } from "./asset-processor.js";
import { cleanupPendingUploads } from "./upload-lifecycle.js";
import { reconcileAssetIngest } from "./asset-ingest.js";
import { closeDatabase, pool } from "./db/index.js";
import { config } from "./config.js";
import { assertRuntimeDatabaseRole } from "./db/runtime-role.js";
import { deleteExpiredDeliveryEvents } from "./delivery-analytics.js";
import { startWorkerMonitoring } from "./worker-monitoring.js";
import {
  assetDeleteQueue,
  assetIngestQueue,
  assetIngestRecoveryQueue,
  deliveryRetentionQueue,
  uploadCleanupQueue,
  startQueue,
  stopQueue,
} from "./queue.js";

let stopMonitoring: (() => Promise<void>) | undefined;
async function shutdown() {
  await stopMonitoring?.();
  await stopQueue();
  await closeDatabase();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  if (config.NODE_ENV === "production") await assertRuntimeDatabaseRole(pool);
  const queue = await startQueue();
  // A killed worker can leave the exclusive recovery queue occupied. Scan
  // directly before local workers start, independently of that queue's lease.
  await reconcileAssetIngest();
  await queue.schedule(uploadCleanupQueue, "* * * * *");
  await queue.work(uploadCleanupQueue, async () => {
    await cleanupPendingUploads();
  });
  await queue.send(uploadCleanupQueue, {});
  await queue.schedule(assetIngestRecoveryQueue, "* * * * *");
  await queue.work(assetIngestRecoveryQueue, async () => {
    await reconcileAssetIngest();
  });
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
      if (job)
        await processAsset(job.data, { jobId: job.id, signal: job.signal });
    },
  );
  await queue.work<AssetDeletePayload>(
    assetDeleteQueue,
    { localConcurrency: 1 },
    async ([job]) => {
      if (job) await deleteAssetObjects(job.data);
    },
  );
  stopMonitoring = await startWorkerMonitoring(() => queue.getWipData());
} catch (error) {
  console.error("Worker failed to start", error);
  await shutdown();
  process.exitCode = 1;
}
