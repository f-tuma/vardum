import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeAsset } from "./authorization.js";
import { asset } from "./db/app-schema.js";
import { organization } from "./db/auth-schema.js";
import { inWorkspace } from "./db/tenant.js";
import { transformedAssetUrl, transformationSchema } from "./transformation.js";

const params = z.object({ workspaceId: z.string().min(1), assetId: z.uuid() });

export function registerTransformationRoutes(app: FastifyInstance) {
    const api = app.withTypeProvider<ZodTypeProvider>();

    api.post(
        "/api/workspaces/:workspaceId/assets/:assetId/transform-url",
        { schema: { params, body: transformationSchema } },
        async (request, reply) => {
            const { workspaceId, assetId } = request.params;
            const authorization = await authorizeAsset(request, workspaceId, [
                "read",
            ]);
            if (!("principal" in authorization)) {
                return reply
                    .code(authorization.statusCode)
                    .send({ error: authorization.error });
            }

            const [source] = await inWorkspace(workspaceId, (transaction) =>
                transaction
                    .select({
                        key: asset.key,
                        currentVersionId: asset.currentVersionId,
                        workspaceSlug: organization.slug,
                    })
                    .from(asset)
                    .innerJoin(
                        organization,
                        eq(organization.id, asset.workspaceId),
                    )
                    .where(
                        and(
                            eq(asset.workspaceId, workspaceId),
                            eq(asset.id, assetId),
                        ),
                    ),
            );
            if (!source)
                return reply.code(404).send({ error: "Asset not found" });
            if (!source.currentVersionId) {
                return reply
                    .code(409)
                    .send({ error: "Asset has no published version" });
            }

            return {
                url: transformedAssetUrl(
                    source.workspaceSlug,
                    source.key,
                    request.body,
                ),
            };
        },
    );
}
