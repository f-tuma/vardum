import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeAsset } from "./authorization.js";
import {
  asset,
  assetVersion,
  auditEvent,
  vard,
  vardItem,
  workspace,
} from "./db/app-schema.js";
import { db } from "./db/index.js";
import { inWorkspace } from "./db/tenant.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import { registerVardEditorRoutes } from "./vard-editor.js";
import { buildVardPayload } from "./vard-payload.js";
import { registerVardImportRoutes } from "./vard-import.js";
import { transformationSchema } from "./transformation.js";

export { vardOutputPath } from "./vard-folder-rules.js";
import { folderRulesSchema, vardOutputPath } from "./vard-folder-rules.js";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const vardParams = workspaceParams.extend({ vardId: z.uuid() });
const publicVardParams = z.object({ vardId: z.uuid() });
const name = z.string().trim().min(1).max(80);
const prefix = z
  .string()
  .max(255)
  .regex(/^(?:[a-z0-9][a-z0-9._-]*\/)*$/)
  .default("");
const itemInput = z
  .object({
    assetId: z.uuid(),
    versionId: z.uuid().nullable().default(null),
    outputPath: vardOutputPath,
    transformation: transformationSchema.nullable().default(null),
    writable: z.boolean().default(false),
  })
  .refine(
    ({ transformation, versionId, writable }) =>
      !writable || (!transformation && !versionId),
    "Writable items must follow the original latest version",
  );
const replaceItemsBody = z.object({ items: z.array(itemInput).max(1000) });
const vardFields = z.object({
  name,
  isPublic: z.boolean(),
  folderRules: folderRulesSchema,
});
const vardBody = vardFields.extend({
  isPublic: z.boolean().default(false),
  folderRules: folderRulesSchema.default([]),
});
// PATCH must not inherit create defaults: Zod applies nested defaults in partials.
const updateVardBody = vardFields
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

export function registerVardRoutes(app: FastifyInstance) {
  registerVardImportRoutes(app);
  registerVardEditorRoutes(app);
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/workspaces/:workspaceId/vards",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const authorization = await authorizeAsset(
        request,
        request.params.workspaceId,
        ["read"],
      );
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const vards = await inWorkspace(
        request.params.workspaceId,
        async (transaction) => {
          const rows = await transaction
            .select({
              id: vard.id,
              name: vard.name,
              isPublic: vard.isPublic,
              updatedAt: vard.updatedAt,
              itemCount: count(vardItem.id),
            })
            .from(vard)
            .leftJoin(vardItem, eq(vardItem.vardId, vard.id))
            .where(eq(vard.workspaceId, request.params.workspaceId))
            .groupBy(vard.id)
            .orderBy(asc(vard.name));
          return { vards: rows };
        },
      );
      return vards;
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/vards",
    { schema: { params: workspaceParams, body: vardBody } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "create",
      ]);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      try {
        const created = await inWorkspace(workspaceId, async (transaction) => {
          await lockWorkspaceContent(transaction, workspaceId);
          const [record] = await transaction
            .insert(vard)
            .values({
              workspaceId,
              ...request.body,
              createdBy: authorization.principal.reference,
              updatedBy: authorization.principal.reference,
            })
            .returning({
              id: vard.id,
              name: vard.name,
              isPublic: vard.isPublic,
              folderRules: vard.folderRules,
              updatedAt: vard.updatedAt,
            });
          if (!record) throw new Error("Vard insert returned no row");
          await transaction.insert(auditEvent).values({
            workspaceId,
            actorType: authorization.principal.actorType,
            actorId: authorization.principal.actorId,
            action: "vard.created",
            targetType: "vard",
            targetId: record.id,
            metadata: {
              name: record.name,
              isPublic: record.isPublic,
              folderRules: record.folderRules,
            },
            requestId: request.id,
          });
          return record;
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (isUniqueViolation(error))
          return reply.code(409).send({ error: "Vard name already exists" });
        throw error;
      }
    },
  );

  api.get(
    "/api/workspaces/:workspaceId/vards/:vardId",
    { schema: { params: vardParams } },
    async (request, reply) => {
      const { workspaceId, vardId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "read",
      ]);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      const definition = await buildVardPayload(workspaceId, vardId, {
        resolveFolders: false,
      });
      return definition
        ? definition
        : reply.code(404).send({ error: "Vard not found" });
    },
  );

  api.patch(
    "/api/workspaces/:workspaceId/vards/:vardId",
    { schema: { params: vardParams, body: updateVardBody } },
    async (request, reply) => {
      const { workspaceId, vardId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "update",
      ]);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      try {
        const updated = await inWorkspace(workspaceId, async (transaction) => {
          await lockWorkspaceContent(transaction, workspaceId);
          const [record] = await transaction
            .update(vard)
            .set({
              ...request.body,
              updatedBy: authorization.principal.reference,
              updatedAt: new Date(),
            })
            .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)))
            .returning({
              id: vard.id,
              name: vard.name,
              isPublic: vard.isPublic,
              folderRules: vard.folderRules,
              updatedAt: vard.updatedAt,
            });
          if (!record) return null;
          await transaction.insert(auditEvent).values({
            workspaceId,
            actorType: authorization.principal.actorType,
            actorId: authorization.principal.actorId,
            action: "vard.updated",
            targetType: "vard",
            targetId: vardId,
            metadata: request.body,
            requestId: request.id,
          });
          return record;
        });
        return updated
          ? updated
          : reply.code(404).send({ error: "Vard not found" });
      } catch (error) {
        if (isUniqueViolation(error))
          return reply.code(409).send({ error: "Vard name already exists" });
        throw error;
      }
    },
  );

  api.put(
    "/api/workspaces/:workspaceId/vards/:vardId/items",
    { schema: { params: vardParams, body: replaceItemsBody } },
    async (request, reply) => {
      const { workspaceId, vardId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "update",
      ]);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const duplicatePath = duplicate(
        request.body.items.map(({ outputPath }) =>
          outputPath.normalize("NFC").toLowerCase(),
        ),
      );
      if (duplicatePath)
        return reply
          .code(400)
          .send({ error: `Duplicate output path: ${duplicatePath}` });

      const result = await inWorkspace(workspaceId, async (transaction) => {
        await lockWorkspaceContent(transaction, workspaceId);
        const [target] = await transaction
          .select({ id: vard.id })
          .from(vard)
          .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
        if (!target) return "missing" as const;

        const assetIds = [
          ...new Set(request.body.items.map((item) => item.assetId)),
        ];
        const assets = assetIds.length
          ? await transaction
              .select({ id: asset.id })
              .from(asset)
              .where(
                and(
                  eq(asset.workspaceId, workspaceId),
                  inArray(asset.id, assetIds),
                ),
              )
          : [];
        if (assets.length !== assetIds.length) return "invalid-asset" as const;

        const pinned = request.body.items.filter(
          (item): item is typeof item & { versionId: string } =>
            Boolean(item.versionId),
        );
        if (pinned.length) {
          const versions = await transaction
            .select({ id: assetVersion.id, assetId: assetVersion.assetId })
            .from(assetVersion)
            .where(
              and(
                eq(assetVersion.workspaceId, workspaceId),
                eq(assetVersion.status, "ready"),
                inArray(
                  assetVersion.id,
                  pinned.map(({ versionId }) => versionId),
                ),
              ),
            );
          const byId = new Map(
            versions.map((version) => [version.id, version]),
          );
          if (
            pinned.some(
              (item) => byId.get(item.versionId)?.assetId !== item.assetId,
            )
          )
            return "invalid-version" as const;
        }

        await transaction.delete(vardItem).where(eq(vardItem.vardId, vardId));
        if (request.body.items.length)
          await transaction.insert(vardItem).values(
            request.body.items.map((item) => ({
              workspaceId,
              vardId,
              ...item,
              createdBy: authorization.principal.reference,
              updatedBy: authorization.principal.reference,
            })),
          );
        await transaction
          .update(vard)
          .set({
            updatedAt: new Date(),
            updatedBy: authorization.principal.reference,
          })
          .where(eq(vard.id, vardId));
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "vard.items_updated",
          targetType: "vard",
          targetId: vardId,
          metadata: { itemCount: request.body.items.length },
          requestId: request.id,
        });
        return "updated" as const;
      });

      if (result === "missing")
        return reply.code(404).send({ error: "Vard not found" });
      if (result === "invalid-asset")
        return reply
          .code(400)
          .send({ error: "Asset does not belong to workspace" });
      if (result === "invalid-version")
        return reply.code(400).send({
          error: "Pinned version must be ready and belong to its asset",
        });
      return buildVardPayload(workspaceId, vardId, {
        resolveFolders: false,
      });
    },
  );

  api.delete(
    "/api/workspaces/:workspaceId/vards/:vardId",
    { schema: { params: vardParams } },
    async (request, reply) => {
      const { workspaceId, vardId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "delete",
      ]);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      const deleted = await inWorkspace(workspaceId, async (transaction) => {
        await lockWorkspaceContent(transaction, workspaceId);
        const [record] = await transaction
          .delete(vard)
          .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)))
          .returning({ id: vard.id, name: vard.name });
        if (!record) return null;
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "vard.deleted",
          targetType: "vard",
          targetId: vardId,
          metadata: { name: record.name },
          requestId: request.id,
        });
        return record;
      });
      return deleted
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Vard not found" });
    },
  );

  api.get(
    "/api/workspaces/:workspaceId/sync/assets",
    {
      schema: {
        params: workspaceParams,
        querystring: z.object({
          prefix,
          cursor: z.string().max(255).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "read",
      ]);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      return inWorkspace(workspaceId, async (transaction) => {
        const [[space], rows] = await Promise.all([
          transaction
            .select({ slug: workspace.slug })
            .from(workspace)
            .where(eq(workspace.id, workspaceId)),
          transaction
            .select({
              id: asset.id,
              key: asset.key,
              displayName: asset.displayName,
              isPublic: asset.isPublic,
              versionId: assetVersion.id,
              checksum: assetVersion.checksum,
              mimeType: assetVersion.mimeType,
              size: assetVersion.size,
              width: assetVersion.width,
              height: assetVersion.height,
              updatedAt: asset.updatedAt,
            })
            .from(asset)
            .innerJoin(
              assetVersion,
              eq(assetVersion.id, asset.currentVersionId),
            )
            .where(
              and(
                eq(asset.workspaceId, workspaceId),
                eq(assetVersion.status, "ready"),
                sql`starts_with(${asset.key}, ${request.query.prefix})`,
                request.query.cursor
                  ? gt(asset.key, request.query.cursor)
                  : undefined,
              ),
            )
            .orderBy(asc(asset.key))
            .limit(request.query.limit),
        ]);
        return {
          workspaceSlug: space?.slug,
          assets: rows,
          nextCursor:
            rows.length === request.query.limit
              ? (rows.at(-1)?.key ?? null)
              : null,
        };
      });
    },
  );

  api.get(
    "/api/workspaces/:workspaceId/vards/:vardId/manifest",
    { schema: { params: vardParams } },
    async (request, reply) => {
      const { workspaceId, vardId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "read",
      ]);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      const manifest = await buildVardPayload(workspaceId, vardId);
      return manifest
        ? manifest
        : reply.code(404).send({ error: "Vard not found" });
    },
  );

  api.get(
    "/v/:vardId",
    { schema: { params: publicVardParams } },
    async (request, reply) => {
      const [record] = await db
        .select({ workspaceId: vard.workspaceId })
        .from(vard)
        .where(
          and(eq(vard.id, request.params.vardId), eq(vard.isPublic, true)),
        );
      if (!record) return reply.code(404).send({ error: "Vard not found" });
      const authorization = await authorizeAsset(request, record.workspaceId, [
        "read",
      ]);
      const manifest = await buildVardPayload(
        record.workspaceId,
        request.params.vardId,
        { anonymous: !("principal" in authorization) },
      );
      return manifest
        ? manifest
        : reply.code(404).send({ error: "Vard not found" });
    },
  );
}

function duplicate(values: string[]) {
  const seen = new Set<string>();
  return values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "23505" || isUniqueViolation(candidate.cause);
}
