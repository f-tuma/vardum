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
import { registerAssetRoutes } from "./asset-routes.js";
import { registerAuthRoute } from "./auth-route.js";
import { config } from "./config.js";
import { registerDeliveryRoutes } from "./delivery-routes.js";
import { db } from "./db/index.js";
import { registerDomainRoutes } from "./domain-routes.js";
import { registerInvitationRoutes } from "./invitation-routes.js";
import { registerOrganizationRoutes } from "./organization-routes.js";
import { registerTransformationRoutes } from "./transformation-routes.js";
import { registerVardRoutes } from "./vard-routes.js";
import { registerWorkspaceRoutes } from "./workspace-routes.js";

// Async because @fastify/swagger only sees routes registered after its plugin
// has loaded, and every route below is added in this same call.
export async function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cors, {
    origin: [
      config.WEB_URL,
      ...(config.NODE_ENV === "development" ? ["https://vite.f-tuma.dev"] : []),
    ],
    credentials: true,
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
  registerOrganizationRoutes(app);
  registerWorkspaceRoutes(app);
  registerDomainRoutes(app);
  registerInvitationRoutes(app);
  registerAssetRoutes(app);
  registerVardRoutes(app);
  registerTransformationRoutes(app);
  registerDeliveryRoutes(app);

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
