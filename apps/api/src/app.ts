import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { registerKnownUsageRoutes } from "./known-usage-routes.js";
import { registerAssetRoutes } from "./asset-routes.js";
import { registerAuthRoute } from "./auth-route.js";
import { registerCapabilityRoutes } from "./capability-routes.js";
import { CapacityError, registerAdmission } from "./resource-budget.js";
import { namespaceConflict } from "./asset-use-namespace.js";
import { registerAssetUseRoutes } from "./asset-use-routes.js";
import { config } from "./config.js";
import { registerDeliveryRoutes } from "./delivery-routes.js";
import { db } from "./db/index.js";
import { registerDomainRoutes } from "./domain-routes.js";
import { registerInvitationRoutes } from "./invitation-routes.js";
import { registerOrganizationRoutes } from "./organization-routes.js";
import { registerTransformationRoutes } from "./transformation-routes.js";
import { registerVardRoutes } from "./vard-routes.js";
import { registerWorkspaceRoutes } from "./workspace-routes.js";
import { registerOperationsRoutes } from "./operations.js";

// Async because @fastify/swagger only sees routes registered after its plugin
// has loaded, and every route below is added in this same call.
export async function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  }).withTypeProvider<ZodTypeProvider>();

  registerAdmission(app);
  app.setErrorHandler((error, _request, reply) => {
    if (namespaceConflict(error))
      return reply.code(409).send({ code: "library_path_conflict", error: "Path conflicts with an existing library item or folder. Linked uses are read-only upload destinations." });
    if (error instanceof CapacityError) {
      if (error.statusCode === 429 || error.statusCode === 503)
        reply.header("retry-after", "1");
      return reply
        .header("cache-control", "private, no-store")
        .code(error.statusCode)
        .send({ error: error.message });
    }
    return reply.send(error);
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cors, {
    origin: [config.WEB_URL],
    credentials: true,
  });
  // Default sensitive routes to non-cacheable, including validation and storage errors.
  // Only successful public file delivery explicitly opts into caching.
  app.addHook("onSend", async (request, reply, payload) => {
    const path = request.url.split("?")[0]!;
    const delivery = path.startsWith("/w/") || path.startsWith("/assets/");
    const sensitive =
      delivery || path.startsWith("/v/") || path.startsWith("/api/workspaces/");
    if (sensitive) {
      if (
        !delivery ||
        reply.statusCode >= 400 ||
        !reply.getHeader("cache-control")
      )
        reply.header("cache-control", "private, no-store");
      const vary = new Set(
        String(reply.getHeader("vary") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      for (const header of ["Origin", "Cookie", "X-API-Key"]) vary.add(header);
      reply.header("vary", [...vary].join(", "));
      if (delivery) reply.removeHeader("access-control-allow-credentials");
      if (
        delivery &&
        String(reply.getHeader("cache-control")).includes("no-store")
      ) {
        reply.removeHeader("access-control-allow-origin");
        reply.header("cross-origin-resource-policy", "same-origin");
      }
    }
    return payload;
  });
  // The route schemas are already Zod; this turns them into the API reference
  // instead of maintaining a second description of the same thing by hand.
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Vardum API",
        description:
          "Workspace, asset, Vard and delivery endpoints. Session cookie, or x-api-key for a workspace-scoped key.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", name: "x-api-key", in: "header" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  app.get("/api/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );

  registerAuthRoute(app);
  registerCapabilityRoutes(app);
  registerOrganizationRoutes(app);
  registerWorkspaceRoutes(app);
  registerDomainRoutes(app);
  registerInvitationRoutes(app);
  registerAssetRoutes(app);
  registerVardRoutes(app);
  registerKnownUsageRoutes(app);
  registerTransformationRoutes(app);
  registerDeliveryRoutes(app);
  registerAssetUseRoutes(app);
  registerOperationsRoutes(app);

  app.get(
    "/health",
    {
      schema: {
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );
  app.get(
    "/ready",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ready") }),
          503: z.object({ status: z.literal("unavailable") }),
        },
      },
    },
    async (_request, reply) => {
      try {
        await db.execute(sql`select 1`);
        return { status: "ready" as const };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    },
  );

  return app;
}
