import { videoMimeSet } from "@vardum/shared";
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeAsset } from "./authorization.js";
import { assetKey } from "./asset-routes.js";
import {
  asset,
  assetVersion,
  assetUse,
  workspace as workspaceTable,
  workspaceSettings,
} from "./db/app-schema.js";
import { db } from "./db/index.js";
import { inWorkspace } from "./db/tenant.js";
import { useRows, useIssue } from "./asset-use-query.js";
import { recordDeliveryEvent } from "./delivery-analytics.js";
import { CapacityError } from "./resource-budget.js";
import { getImageVariant } from "./image-variant.js";
import { getObject } from "./storage.js";
import {
  canonicalizeTransformation,
  deliveryQuerySchema,
  type Transformation,
  verifyTransformation,
  transformedVersionUrl,
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
        request,
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
        request,
        reply,
      );
    },
  );

  delivery.get(
    "/assets/:workspaceSlug/__v/:versionId/*",
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
        true,
      );
    },
  );

  delivery.get(
    "/assets/:workspaceSlug/*",
    { schema: { params: stableParams, querystring: deliveryQuerySchema } },
    async (request, reply) => {
      const workspace = await findWorkspace(request.params.workspaceSlug);
      if (!workspace) return reply.code(404).send({ error: "Asset not found" });
      let [target] = await inWorkspace(workspace.id, (transaction) =>
        transaction
          .select({ isPublic: asset.isPublic })
          .from(asset)
          .where(
            and(
              eq(asset.workspaceId, workspace.id),
              eq(asset.key, request.params["*"]),
            ),
          ),
      );
      if (!target) [target] = await inWorkspace(workspace.id, (transaction) =>
        useRows(transaction, workspace.id).where(and(eq(assetUse.workspaceId, workspace.id), eq(assetUse.key, request.params["*"]))));
      if (!target) return reply.code(404).send({ error: "Asset not found" });
      if (!(await canDeliver(target.isPublic, workspace.id, request, reply)))
        return reply;
      return reply.redirect(request.url.replace(/^\/assets\//, "/w/"), 308);
    },
  );
}

async function redirectCurrent(
  workspace: Workspace,
  key: string,
  transformation: SignedTransformation | null,
  customDomain: boolean,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!validTransformation(workspace, key, transformation))
    return reply.code(403).send({ error: "Invalid transformation signature" });
  const [current] = await inWorkspace(workspace.id, (transaction) =>
    transaction
      .select({ versionId: asset.currentVersionId, isPublic: asset.isPublic })
      .from(asset)
      .where(and(eq(asset.workspaceId, workspace.id), eq(asset.key, key))),
  );
  if (!current) {
    const [use] = await inWorkspace(workspace.id, (transaction) =>
      useRows(transaction, workspace.id).where(and(eq(assetUse.workspaceId, workspace.id), eq(assetUse.key, key))));
    if (!use) return reply.code(404).send({ error: "Asset not found" });
    if (!(await canDeliver(use.isPublic, workspace.id, request, reply))) return reply;
    if (transformation) return reply.code(400).send({ error: "Linked use URLs already have saved settings; edit the use instead of adding transformations" });
    const issue = useIssue(use);
    if (issue || !use.currentVersionId)
      return reply.code(422).send({ code: "linked_use_unavailable", error: issue ?? "Source unavailable" });
    let path = use.transformation
      ? transformedVersionUrl(workspace.slug, use.sourceKey, use.currentVersionId, use.transformation)
      : `/w/${encodeURIComponent(workspace.slug)}/__v/${use.currentVersionId}/${use.sourceKey.split("/").map(encodeURIComponent).join("/")}`;
    if (customDomain) path = path.replace(`/w/${encodeURIComponent(workspace.slug)}/`, "/w/");
    reply.header("cache-control", use.isPublic ? "public, max-age=60, stale-while-revalidate=300" : "private, no-store");
    return reply.redirect(path, 302);
  }
  if (
    current &&
    !(await canDeliver(current.isPublic, workspace.id, request, reply))
  )
    return reply;
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
    current.isPublic
      ? "public, max-age=60, stale-while-revalidate=300"
      : "private, no-store",
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
  legacyRedirect = false,
) {
  const [version] = await inWorkspace(workspace.id, (transaction) =>
    transaction
      .select({
        id: assetVersion.id,
        assetId: asset.id,
        isPublic: asset.isPublic,
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
  if (!(await canDeliver(version.isPublic, workspace.id, request, reply)))
    return reply;
  if (legacyRedirect)
    return reply.redirect(request.url.replace(/^\/assets\//, "/w/"), 308);
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
    // Prefer the DB MIME type for original assets — RustFS/S3 may report a
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
      ...(version.isPublic ? { "access-control-allow-origin": "*" } : {}),
      "accept-ranges": "bytes",
      "cache-control": version.isPublic
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
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
      // A directly opened private video needs its real origin for the media
      // document's cookie-bearing range requests and same-origin CORP check.
      // Scripts remain forbidden; SVG/image documents keep the opaque sandbox.
      "content-security-policy":
        !version.isPublic && videoMimeSet.has(version.mimeType)
          ? "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox allow-same-origin"
          : "default-src 'none'; media-src *; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": version.isPublic
        ? "cross-origin"
        : "same-origin",
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
    if (error instanceof CapacityError) {
      if (error.statusCode === 503) reply.header("retry-after", "1");
      return reply.code(error.statusCode).send({ error: error.message });
    }
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
  format?: Transformation["format"],
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

async function canDeliver(
  isPublic: boolean,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (isPublic) return true;
  const authorization = await authorizeAsset(request, workspaceId, ["read"]);
  if ("principal" in authorization) return true;
  reply.code(authorization.statusCode).send({ error: authorization.error });
  return false;
}
