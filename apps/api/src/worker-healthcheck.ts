import { config } from "./config.js";

try {
  const response = await fetch(
    `http://127.0.0.1:${config.WORKER_HEALTH_PORT}/health`,
    { signal: AbortSignal.timeout(3000) },
  );
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
export {};
