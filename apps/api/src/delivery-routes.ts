import { videoMimeSet } from "@vardum/shared";
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { assetKey } from "./asset-routes.js";
import {
  asset,
  assetVersion,
  workspace as workspaceTable,
  workspaceSettings,
} from "./db/app-schema.js";
import { db } from "./db/index.js";
import { inWorkspace } from "./db/tenant.js";
import { recordDeliveryEvent } from "./delivery-analytics.js";
import { getImageVariant } from "./image-variant.js";
import { getObject } from "./storage.js";
import {
  canonicalizeTransformation,
  deliveryQuerySchema,
  type Transformation,
  verifyTransformation,
} from "./transformation.js";

const stableParams = z.object({
  workspaceSlug: z.string().min(1),
  "*": assetKey,
});
const rootCustomParams = z.object({ assetKey });
const immutableParams = stableParams.extend({ versionId: z.uuid() });
const customImmutableParams = z.object({ versionId: z.uuid(), "*": assetKey });
type Workspace = { id: string; slug: string };
type SignedTransformation = Transformation & { sig: string };

export function registerDeliveryRoutes(app: FastifyInstance) {
  const delivery = app.withTypeProvider<ZodTypeProvider>();

  delivery.get(
    "/w/__v/:versionId/*",
    {
      schema: {
        params: customImmutableParams,
        querystring: deliveryQuerySchema,
      },
    },
    async (request, reply) => {
      const workspace = await findCustomWorkspace(request.hostname);
      if (!workspace) return reply.code(404).send({ error: "Asset not found" });
      const transformation = signedTransformation(request.query);
      if (!validTransformation(workspace, request.params["*"], transformation))
        return reply
          .code(403)
          .send({ error: "Invalid transformation signature" });
      return deliverVersion(
        workspace,
        request.params["*"],
        request.params.versionId,
        transformation,
        request,
        reply,
      );
    },
  );

  delivery.get(
    "/w/:assetKey",
    {
      schema: { params: rootCustomParams, querystring: deliveryQuerySchema },
    },
    async (request, reply) => {
      const workspace = await findCustomWorkspace(request.hostname);
      if (!workspace) return reply.code(404).send({ error: "Asset not found" });
      return redirectCurrent(
        workspace,
        request.params.assetKey,
        signedTransformation(request.query),
        true,
        reply,
      );
    },
  );

  delivery.get(
    "/w/:workspaceSlug/__v/:versionId/*",
    { schema: { params: immutableParams, querystring: deliveryQuerySchema } },
    async (request, reply) => {
      const workspace = await findWorkspace(request.params.workspaceSlug);
      if (!workspace) return reply.code(404).send({ error: "Asset not found" });
      const transformation = signedTransformation(request.query);
      if (!validTransformation(workspace, request.params["*"], transformation))
        return reply
          .code(403)
          .send({ error: "Invalid transformation signature" });
      return deliverVersion(
        workspace,
        request.params["*"],
        request.params.versionId,
        transformation,
        request,
        reply,
      );
    },
  );

  delivery.get(
    "/w/:workspaceSlug/*",
    { schema: { params: stableParams, querystring: deliveryQuerySchema } },
    async (request, reply) => {
      const customWorkspace = await findCustomWorkspace(request.hostname);
      const workspace =
        customWorkspace ?? (await findWorkspace(request.params.workspaceSlug));
      if (!workspace) return reply.code(404).send({ error: "Asset not found" });
      const key = customWorkspace
        ? `${request.params.workspaceSlug}/${request.params["*"]}`
        : request.params["*"];
      return redirectCurrent(
        workspace,
        key,
        signedTransformation(request.query),
        Boolean(customWorkspace),
        reply,
      );
    },
  );

  delivery.get("/assets/:workspaceSlug/*", async (request, reply) =>
    reply.redirect(request.url.replace(/^\/assets\//, "/w/"), 308),
  );
}

async function redirectCurrent(
  workspace: Workspace,
  key: string,
  transformation: SignedTransformation | null,
  customDomain: boolean,
  reply: FastifyReply,
) {
  if (!validTransformation(workspace, key, transformation))
    return reply.code(403).send({ error: "Invalid transformation signature" });
  const [current] = await inWorkspace(workspace.id, (transaction) =>
    transaction
      .select({ versionId: asset.currentVersionId })
      .from(asset)
      .where(and(eq(asset.workspaceId, workspace.id), eq(asset.key, key))),
  );
  if (!current?.versionId)
    return reply.code(404).send({ error: "Asset not found" });

  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const query = transformation
    ? `?${canonicalizeTransformation(transformation)}&sig=${encodeURIComponent(transformation.sig)}`
    : "";
  const path = customDomain
    ? `/w/__v/${current.versionId}/${encodedKey}`
    : `/w/${encodeURIComponent(workspace.slug)}/__v/${current.versionId}/${encodedKey}`;
  reply.header(
    "cache-control",
    "public, max-age=60, stale-while-revalidate=300",
  );
  return reply.redirect(`${path}${query}`, 302);
}

async function deliverVersion(
  workspace: Workspace,
  key: string,
  versionId: string,
  transformation: SignedTransformation | null,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const [version] = await inWorkspace(workspace.id, (transaction) =>
    transaction
      .select({
        id: assetVersion.id,
        assetId: asset.id,
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
          eq(assetVersion.id, versionId),
          eq(assetVersion.status, "ready"),
          eq(asset.key, key),
        ),
      ),
  );
  if (!version) return reply.code(404).send({ error: "Asset not found" });
  if (transformation && videoMimeSet.has(version.mimeType)) {
    return reply
      .code(415)
      .send({ error: "Video assets cannot be transformed" });
  }

  try {
    const range = request.headers.range;
    const delivered = transformation
      ? await getImageVariant(version, transformation)
      : {
          object: await getObject(version.storageKey, range),
          mimeType: version.mimeType,
          cacheHit: null,
        };
    const { object } = delivered;
    if (!object.Body) throw new Error("S3 returned an empty body");
    const bytes = object.ContentLength ?? version.size;
    // Prefer the DB MIME type for original assets — MinIO/S3 may report a
    // generic binary type. For transformed variants, the variant's type wins.
    const mimeType = transformation
      ? (object.ContentType ?? delivered.mimeType)
      : (delivered.mimeType ?? object.ContentType);

    // ponytail: one synchronous insert per response; batch at the edge when delivery volume warrants it.
    if (request.method === "GET") {
      try {
        await recordDeliveryEvent({
          workspaceId: workspace.id,
          assetId: version.assetId,
          versionId: version.id,
          transformed: Boolean(transformation),
          cacheHit: delivered.cacheHit,
          mimeType,
          bytes,
        });
      } catch (error) {
        request.log.warn(
          { error, versionId },
          "Delivery analytics write failed",
        );
      }
    }

    reply.headers({
      "access-control-allow-origin": "*",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `inline; filename*=UTF-8''${encodeFilename(
        deliveryFilename(
          version.filename,
          transformation?.format ??
            (transformation && version.mimeType === "image/svg+xml"
              ? "png"
              : undefined),
        ),
      )}`,
      "content-length": bytes,
      // media-src: a video opened directly becomes a media document, and the
      // browser loads it through a <video> element that default-src blocks.
      "content-security-policy":
        "default-src 'none'; media-src *; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
    });
    if (object.ContentRange) reply.header("content-range", object.ContentRange);
    if (object.ETag) reply.header("etag", object.ETag);
    if (object.LastModified)
      reply.header("last-modified", object.LastModified.toUTCString());
    reply.type(mimeType);
    if (object.ContentRange) reply.code(206);
    return reply.send(object.Body);
  } catch (error) {
    request.log.error({ error, versionId }, "Asset delivery failed");
    return reply.code(502).send({ error: "Asset content unavailable" });
  }
}

function signedTransformation(query: Record<string, unknown>) {
  return "sig" in query ? (query as SignedTransformation) : null;
}

function validTransformation(
  workspace: Workspace,
  key: string,
  transformation: SignedTransformation | null,
) {
  return (
    !transformation ||
    verifyTransformation(
      workspace.slug,
      key,
      transformation,
      transformation.sig,
    )
  );
}

async function findWorkspace(slug: string) {
  const [workspace] = await db
    .select({ id: workspaceTable.id, slug: workspaceTable.slug })
    .from(workspaceTable)
    .where(eq(workspaceTable.slug, slug));
  return workspace ?? null;
}

async function findCustomWorkspace(hostname: string) {
  const [workspace] = await db
    .select({ id: workspaceTable.id, slug: workspaceTable.slug })
    .from(workspaceSettings)
    .innerJoin(
      workspaceTable,
      eq(workspaceTable.id, workspaceSettings.workspaceId),
    )
    .where(
      and(
        eq(workspaceSettings.customDomain, hostname.toLowerCase()),
        isNotNull(workspaceSettings.customDomainVerifiedAt),
      ),
    );
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
