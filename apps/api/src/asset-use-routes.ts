import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeAsset } from "./authorization.js";
import { assetKey } from "./asset-key.js";
import { createUseSchema, useCompatibilityIssue, useOutputMime, useSettingsSchema } from "./asset-use-model.js";
import { asset, assetFolder, assetUse, assetVersion, auditEvent, workspace } from "./db/app-schema.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import { useRows, useIssue } from "./asset-use-query.js";
import { inWorkspace } from "./db/tenant.js";
import { canonicalizeTransformation, transformedVersionUrl } from "./transformation.js";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const useParams = workspaceParams.extend({ useId: z.uuid() });
const revision = z.number().int().positive();
const prefix = z.string().max(255).regex(/^(?:[a-z0-9][a-z0-9._-]*\/)*$/).default("");
export function registerAssetUseRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get("/api/workspaces/:workspaceId/asset-uses", {
    schema: { params: workspaceParams, querystring: z.object({
      prefix, search: z.string().trim().max(255).default(""), sourceAssetId: z.uuid().optional(),
      cursor: assetKey.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict() },
  }, async (request, reply) => {
    const { workspaceId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read"]);
    if (!("principal" in authorization)) return reply.code(authorization.statusCode).send({ error: authorization.error });
    const query = request.query;
    return inWorkspace(workspaceId, async (tx) => {
      const rows = await useRows(tx, workspaceId).where(and(
        eq(assetUse.workspaceId, workspaceId),
        query.sourceAssetId ? eq(assetUse.sourceAssetId, query.sourceAssetId) : undefined,
        query.cursor ? gt(assetUse.key, query.cursor) : undefined,
        sql`starts_with(${assetUse.key}, ${query.prefix})`,
        query.search ? sql`(${assetUse.key} ilike ${literal(query.search)} escape '\\' or ${assetUse.displayName} ilike ${literal(query.search)} escape '\\')`
          : query.sourceAssetId ? undefined : sql`position('/' in substring(${assetUse.key} from length(${query.prefix}) + 1)) = 0`,
      )).orderBy(asc(assetUse.key)).limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const [info] = await tx.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, workspaceId));
      return {
        uses: page.map((row) => ({ ...row, kind: "use" as const, availabilityError: useIssue(row),
          // Authenticated previews use the app origin, never a cookie-less CDN.
          previewUrl: useIssue(row) || !row.currentVersionId || !info ? null : row.transformation
            ? transformedVersionUrl(info.slug, row.sourceKey, row.currentVersionId, row.transformation)
            : `/w/${encodeURIComponent(info.slug)}/__v/${row.currentVersionId}/${row.sourceKey.split("/").map(encodeURIComponent).join("/")}`,
        })),
        nextCursor: rows.length > query.limit ? page.at(-1)!.key : null,
      };
    });
  });

  api.post("/api/workspaces/:workspaceId/asset-uses", {
    schema: { params: workspaceParams, body: createUseSchema },
  }, async (request, reply) => {
    const { workspaceId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read", "create"]);
    if (!("principal" in authorization)) return reply.code(authorization.statusCode).send({ error: authorization.error });
    const input = request.body;
    const result = await inWorkspace(workspaceId, async (tx) => {
      await lockWorkspaceContent(tx, workspaceId);
      const [source] = await tx.select({ mimeType: assetVersion.mimeType, width: assetVersion.width, height: assetVersion.height }).from(asset).innerJoin(assetVersion, and(
        eq(assetVersion.id, asset.currentVersionId), eq(assetVersion.assetId, asset.id),
        eq(assetVersion.workspaceId, workspaceId), eq(assetVersion.status, "ready"),
      )).where(and(eq(asset.workspaceId, workspaceId), eq(asset.id, input.sourceAssetId)));
      if (!source) return { status: 409 as const, error: "Select a source with a ready current version in this workspace" };
      const outputMimeType = useOutputMime(source.mimeType, input.transformation);
      const error = useCompatibilityIssue(input.key, outputMimeType, source.mimeType, input.transformation, source);
      if (error) return { status: 422 as const, error };
      const [total] = await tx.select({ count: count() }).from(assetUse).where(eq(assetUse.workspaceId, workspaceId));
      if (total!.count >= 1000) return { status: 409 as const, error: "Workspace supports at most 1,000 linked uses" };
      const [row] = await tx.insert(assetUse).values({ ...input, workspaceId, outputMimeType,
        createdBy: authorization.principal.reference, updatedBy: authorization.principal.reference,
      }).returning();
      // Materialize the containing folders for the source-only browser and old
      // clients. Originals-only folder expansion still reads only asset rows.
      const segments = input.key.split("/").slice(0, -1);
      if (segments.length) await tx.insert(assetFolder).values(segments.map((_part, i) => ({
        workspaceId, prefix: `${segments.slice(0, i + 1).join("/")}/`, createdBy: authorization.principal.reference,
      }))).onConflictDoNothing();
      await tx.insert(auditEvent).values({ workspaceId,
        actorType: authorization.principal.actorType, actorId: authorization.principal.actorId,
        action: "asset_use.created", targetType: "asset_use", targetId: row!.id,
        metadata: { key: row!.key, sourceAssetId: input.sourceAssetId }, requestId: request.id,
      });
      return { status: 201 as const, row };
    });
    return "error" in result ? reply.code(result.status).send({ error: result.error }) : reply.code(201).send(result.row);
  });

  api.patch("/api/workspaces/:workspaceId/asset-uses/:useId", {
    schema: { params: useParams, body: useSettingsSchema.extend({ expectedRevision: revision }).strict() },
  }, async (request, reply) => {
    const { workspaceId, useId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read", "update"]);
    if (!("principal" in authorization)) return reply.code(authorization.statusCode).send({ error: authorization.error });
    const result = await inWorkspace(workspaceId, async (tx) => {
      await lockWorkspaceContent(tx, workspaceId);
      const [row] = await useRows(tx, workspaceId).where(and(eq(assetUse.workspaceId, workspaceId), eq(assetUse.id, useId)));
      if (!row) return { status: 404 as const, error: "Linked use not found" };
      if (row.revision !== request.body.expectedRevision) return { status: 409 as const, error: "Linked use changed; reload before saving" };
      const { displayName, transformation } = request.body;
      const outputMimeType = useOutputMime(row.sourceMimeType ?? row.outputMimeType, transformation);
      const error = useCompatibilityIssue(row.key, outputMimeType, row.sourceMimeType, transformation, { width: row.sourceWidth, height: row.sourceHeight });
      if (error) return { status: 422 as const, error };
      if (displayName === row.displayName && (transformation === null ? row.transformation === null : row.transformation !== null && canonicalizeTransformation(transformation) === canonicalizeTransformation(row.transformation)) && outputMimeType === row.outputMimeType)
        return { status: 200 as const, row: { id: row.id, revision: row.revision } };
      const [updated] = await tx.update(assetUse).set({ displayName, transformation, outputMimeType,
        revision: row.revision + 1, updatedBy: authorization.principal.reference,
      }).where(eq(assetUse.id, useId)).returning({ id: assetUse.id, revision: assetUse.revision });
      await tx.insert(auditEvent).values({ workspaceId,
        actorType: authorization.principal.actorType, actorId: authorization.principal.actorId,
        action: "asset_use.updated", targetType: "asset_use", targetId: useId,
        metadata: { key: row.key, sourceAssetId: row.sourceAssetId, revision: updated!.revision }, requestId: request.id,
      });
      return { status: 200 as const, row: updated };
    });
    return "error" in result ? reply.code(result.status).send({ error: result.error }) : result.row;
  });

  api.delete("/api/workspaces/:workspaceId/asset-uses/:useId", {
    schema: { params: useParams, querystring: z.object({ expectedRevision: z.coerce.number().int().positive() }).strict() },
  }, async (request, reply) => {
    const { workspaceId, useId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["delete"]);
    if (!("principal" in authorization)) return reply.code(authorization.statusCode).send({ error: authorization.error });
    const result = await inWorkspace(workspaceId, async (tx) => {
      await lockWorkspaceContent(tx, workspaceId);
      const [row] = await tx.select().from(assetUse).where(and(eq(assetUse.workspaceId, workspaceId), eq(assetUse.id, useId)));
      if (!row) return { status: 404 as const, error: "Linked use not found" };
      if (row.revision !== request.query.expectedRevision) return { status: 409 as const, error: "Linked use changed; reload before removing" };
      await tx.delete(assetUse).where(eq(assetUse.id, useId));
      await tx.insert(auditEvent).values({ workspaceId,
        actorType: authorization.principal.actorType, actorId: authorization.principal.actorId,
        action: "asset_use.deleted", targetType: "asset_use", targetId: useId,
        metadata: { key: row.key, sourceAssetId: row.sourceAssetId }, requestId: request.id,
      });
      return null;
    });
    return result ? reply.code(result.status).send({ error: result.error }) : reply.code(204).send();
  });
}

function literal(search: string) {
  return `%${search.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
}
