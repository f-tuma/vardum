import {
  deleteAssetObjects,
  type AssetDeletePayload,
} from "./asset-cleanup.js";
import { processAsset, type AssetIngestPayload } from "./asset-processor.js";
import {
  assetDeleteQueue,
  assetIngestQueue,
  startQueue,
  stopQueue,
} from "./queue.js";

async function shutdown() {
  await stopQueue();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  const queue = await startQueue();
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
