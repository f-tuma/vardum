import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { assetKey } from "./asset-routes.js";
import { asset, assetVersion } from "./db/app-schema.js";
import { organization } from "./db/auth-schema.js";
import { db } from "./db/index.js";
import { inWorkspace } from "./db/tenant.js";
import { getImageVariant } from "./image-variant.js";
import { getObject } from "./storage.js";
import {
  canonicalizeTransformation,
  deliveryQuerySchema,
  verifyTransformation,
} from "./transformation.js";

const stableParams = z.object({
  workspaceSlug: z.string().min(1),
  "*": assetKey,
});
const immutableParams = stableParams.extend({ versionId: z.uuid() });

export function registerDeliveryRoutes(app: FastifyInstance) {
  const delivery = app.withTypeProvider<ZodTypeProvider>();

  delivery.get(
    "/assets/:workspaceSlug/*",
    { schema: { params: stableParams, querystring: deliveryQuerySchema } },
    async (request, reply) => {
      const workspace = await findWorkspace(request.params.workspaceSlug);
      if (!workspace) return reply.code(404).send({ error: "Asset not found" });
      const assetKey = request.params["*"];
      const transformation = "sig" in request.query ? request.query : null;
      if (
        transformation &&
        !verifyTransformation(
          workspace.slug,
          assetKey,
          transformation,
          transformation.sig,
        )
      ) {
        return reply
          .code(403)
          .send({ error: "Invalid transformation signature" });
      }

      const [current] = await inWorkspace(workspace.id, (transaction) =>
        transaction
          .select({ versionId: asset.currentVersionId })
          .from(asset)
          .where(
            and(eq(asset.workspaceId, workspace.id), eq(asset.key, assetKey)),
          ),
      );
      if (!current?.versionId) {
        return reply.code(404).send({ error: "Asset not found" });
      }

      const key = assetKey.split("/").map(encodeURIComponent).join("/");
      const query = transformation
        ? `?${canonicalizeTransformation(transformation)}&sig=${encodeURIComponent(transformation.sig)}`
        : "";
      reply.header(
        "cache-control",
        "public, max-age=60, stale-while-revalidate=300",
      );
      return reply.redirect(
        `/assets/${encodeURIComponent(workspace.slug)}/__v/${current.versionId}/${key}${query}`,
        302,
      );
    },
  );

  delivery.get(
    "/assets/:workspaceSlug/__v/:versionId/*",
    { schema: { params: immutableParams, querystring: deliveryQuerySchema } },
    async (request, reply) => {
      const workspace = await findWorkspace(request.params.workspaceSlug);
      if (!workspace) return reply.code(404).send({ error: "Asset not found" });
      const assetKey = request.params["*"];
      const transformation = "sig" in request.query ? request.query : null;
      if (
        transformation &&
        !verifyTransformation(
          workspace.slug,
          assetKey,
          transformation,
          transformation.sig,
        )
      ) {
        return reply
          .code(403)
          .send({ error: "Invalid transformation signature" });
      }

      const [version] = await inWorkspace(workspace.id, (transaction) =>
        transaction
          .select({
            id: assetVersion.id,
            storageKey: assetVersion.storageKey,
            filename: assetVersion.filename,
            mimeType: assetVersion.mimeType,
            size: assetVersion.size,
          })
          .from(assetVersion)
          .innerJoin(asset, eq(asset.id, assetVersion.assetId))
          .where(
            and(
              eq(assetVersion.workspaceId, workspace.id),
              eq(assetVersion.id, request.params.versionId),
              eq(assetVersion.status, "ready"),
              eq(asset.key, assetKey),
            ),
          ),
      );
      if (!version) return reply.code(404).send({ error: "Asset not found" });

      try {
        const delivered = transformation
          ? await getImageVariant(version, transformation)
          : {
              object: await getObject(version.storageKey),
              mimeType: version.mimeType,
            };
        const { object } = delivered;
        if (!object.Body) throw new Error("S3 returned an empty body");

        reply.headers({
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=31536000, immutable",
          "content-disposition": `inline; filename*=UTF-8''${encodeFilename(deliveryFilename(version.filename, transformation?.format))}`,
          "content-length": object.ContentLength ?? version.size,
          "content-security-policy": "sandbox",
          "cross-origin-resource-policy": "cross-origin",
          "x-content-type-options": "nosniff",
        });
        if (object.ETag) reply.header("etag", object.ETag);
        if (object.LastModified)
          reply.header("last-modified", object.LastModified.toUTCString());
        reply.type(object.ContentType ?? delivered.mimeType);

        return reply.send(object.Body);
      } catch (error) {
        request.log.error(
          { error, versionId: request.params.versionId },
          "Asset delivery failed",
        );
        return reply.code(502).send({ error: "Asset content unavailable" });
      }
    },
  );
}

async function findWorkspace(slug: string) {
  const [workspace] = await db
    .select({ id: organization.id, slug: organization.slug })
    .from(organization)
    .where(eq(organization.slug, slug));
  return workspace ?? null;
}

function deliveryFilename(
  filename: string,
  format?: "avif" | "jpeg" | "png" | "webp",
) {
  if (!format) return filename;
  const basename = filename.replace(/\.[^.]+$/, "");
  return `${basename}.${format === "jpeg" ? "jpg" : format}`;
}

function encodeFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
