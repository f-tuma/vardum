import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { registerAssetRoutes } from "./asset-routes.js";
import { registerAuthRoute } from "./auth-route.js";
import { config } from "./config.js";
import { registerDeliveryRoutes } from "./delivery-routes.js";
import { registerInvitationRoutes } from "./invitation-routes.js";
import { registerTransformationRoutes } from "./transformation-routes.js";
import { registerWorkspaceRoutes } from "./workspace-routes.js";

export function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cors, {
    origin: [
      config.WEB_URL,
      ...(config.NODE_ENV === "development" ? ["https://vite.f-tuma.dev"] : []),
    ],
    credentials: true,
  });
  registerAuthRoute(app);
  registerWorkspaceRoutes(app);
  registerInvitationRoutes(app);
  registerAssetRoutes(app);
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

  return app;
}
