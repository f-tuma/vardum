import type { FastifyInstance } from "fastify";
import { config } from "./config.js";

export class CapacityError extends Error {
  constructor(
    message: string,
    public statusCode = 503,
  ) {
    super(message);
  }
}

// No waiting queue: overload must not turn into unbounded memory/DB-pool growth.
export function admissionLimit(maximum: number) {
  let active = 0;
  return {
    get active() {
      return active;
    },
    acquire() {
      if (active >= maximum)
        throw new CapacityError("Server is busy. Retry shortly.");
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
        }
      };
    },
  };
}

export function registerAdmission(app: FastifyInstance) {
  const all = admissionLimit(config.API_MAX_INFLIGHT);
  const delivery = admissionLimit(config.DELIVERY_MAX_INFLIGHT);
  let tokens = config.DELIVERY_REQUESTS_PER_SECOND;
  let last = performance.now();
  app.addHook("onRequest", async (request, reply) => {
    // Fastify decodes static route segments before matching. The matched
    // template covers encoded aliases, custom domains and generated HEAD routes.
    const path = request.routeOptions.url;
    if (
      path &&
      [
        "/health",
        "/ready",
        "/api/operations/health",
        "/api/operations/metrics",
      ].includes(path)
    )
      return;
    let releaseAll: (() => void) | undefined;
    let releaseDelivery: (() => void) | undefined;
    const release = () => {
      releaseDelivery?.();
      releaseAll?.();
    };
    try {
      releaseAll = all.acquire();
      if (path?.startsWith("/w/") || path?.startsWith("/assets/")) {
        releaseDelivery = delivery.acquire();
        const now = performance.now();
        tokens = Math.min(
          config.DELIVERY_REQUESTS_PER_SECOND,
          tokens + ((now - last) * config.DELIVERY_REQUESTS_PER_SECOND) / 1000,
        );
        last = now;
        if (tokens < 1)
          throw new CapacityError(
            "Delivery rate limit reached. Retry shortly.",
            429,
          );
        tokens--;
      }
      // Keep admission through the complete stream, including disconnects.
      reply.raw.once("finish", release);
      reply.raw.once("close", release);
    } catch (error) {
      release();
      if (!(error instanceof CapacityError)) throw error;
      return reply
        .header("retry-after", "1")
        .header("cache-control", "private, no-store")
        .code(error.statusCode)
        .send({ error: error.message });
    }
  });
}
