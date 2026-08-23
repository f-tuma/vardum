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
  await app.listen({ host: config.HOST, port: config.PORT });
  // Configure S3 bucket CORS after the server is listening so a slow or
  // unreachable S3 endpoint never blocks startup or trips the health check.
  ensureBucketCors().catch((error) =>
    app.log.warn({ error }, "Could not configure S3 bucket CORS"),
  );
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
