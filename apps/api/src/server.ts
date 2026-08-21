import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startQueue, stopQueue } from "./queue.js";

const app = buildApp();

async function shutdown() {
  await app.close();
  await stopQueue();
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
