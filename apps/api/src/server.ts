import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db/index.js";
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
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
