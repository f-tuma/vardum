import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { smtpEnabled } from "./mail.js";

// Public deployment capabilities only. Account-specific organization policy and
// workspace domain availability stay on their existing authorized endpoints.
export function registerCapabilityRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/capabilities",
    {
      schema: {
        response: {
          200: z.object({
            passwordRecovery: z.boolean(),
            emailChange: z.boolean(),
            invitations: z.boolean(),
            folderUploadResume: z.literal(1),
          }),
        },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        passwordRecovery: smtpEnabled,
        emailChange: smtpEnabled,
        invitations: smtpEnabled,
        folderUploadResume: 1 as const,
      };
    },
  );
}
