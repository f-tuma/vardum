import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db/index.js";
import { ensureBucketCors } from "./storage.js";
import { startQueue, stopQueue } from "./queue.js";

const app = await buildApp();

async function shutdown() {
  await app.close();
  await stopQueue();
  await closeDatabase();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await startQueue();
  // Ensure the S3 bucket accepts browser uploads from any origin. Without
  // CORS, the presigned POST is blocked by the browser's preflight check.
  await ensureBucketCors().catch((error) =>
    app.log.warn({ error }, "Could not configure S3 bucket CORS"),
  );
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
