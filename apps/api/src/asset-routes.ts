import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, isNotNull, max, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { fromDrizzle } from "pg-boss";
import { z } from "zod";
import {
  importedAssetKey,
  importedMimeType,
  importSource,
  reservedPrefixes,
} from "./asset-import.js";
import { supportedMimeTypes } from "./asset-processor.js";
import { authorizeAsset } from "./authorization.js";
import {
  asset,
  assetFolder,
  assetVersion,
  auditEvent,
  deliveryEvent,
  workspace as workspaceTable,
  workspaceSettings,
} from "./db/app-schema.js";
import { apikey, user } from "./db/auth-schema.js";
import { inWorkspace } from "./db/tenant.js";
import { deliverySummary } from "./delivery-analytics.js";
import { assetDeleteQueue, assetIngestQueue, boss } from "./queue.js";
import {
  copyObject,
  createUpload,
  headObject,
  inspectUpload,
  listObjectPage,
} from "./storage.js";
import { transformedAssetUrl, type Transformation } from "./transformation.js";

// ponytail: single-request uploads are capped at 100 MiB; add multipart above this ceiling.
const maximumUploadSize = 100 * 1024 * 1024;
const thumbnailTransformation = {
  w: 640,
  h: 400,
  fit: "cover",
  format: "webp",
  q: 72,
} satisfies Transformation;
const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const folderName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((value) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""),
  )
  .pipe(
    z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
  );
const assetPrefix = z
  .string()
  .max(255)
  .regex(/^(?:[a-z0-9][a-z0-9._-]*\/)*$/)
  .default("");
const folderPath = z
  .string()
  .min(2)
  .max(255)
  .regex(/^(?:[a-z0-9][a-z0-9._-]*\/)+$/);
const createFolderBody = z
  .object({
    prefix: assetPrefix,
    name: folderName,
  })
  .refine(({ prefix, name }) => `${prefix}${name}/`.length <= 255, {
    message: "Folder path is too long",
  });
const assetParams = workspaceParams.extend({ assetId: z.uuid() });
const versionParams = assetParams.extend({ versionId: z.uuid() });
export const assetKey = z
  .string()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/);
const uploadBody = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\u0000-\u001f]+$/),
  mimeType: z.enum(supportedMimeTypes),
  size: z.number().int().min(1).max(maximumUploadSize),
});

const auditColumns = {
  id: auditEvent.id,
  action: auditEvent.action,
  targetType: auditEvent.targetType,
  targetId: auditEvent.targetId,
  metadata: auditEvent.metadata,
  actorType: auditEvent.actorType,
  actorId: auditEvent.actorId,
  actorName: user.name,
  actorEmail: user.email,
  apiKeyName: apikey.name,
  createdAt: auditEvent.createdAt,
};

// Keyset cursor over (created_at, id): stable while new events keep arriving,
// which offset paging is not.
export const auditCursor = z.string().regex(/^[^|]+\|[0-9a-f-]{36}$/);

export function encodeAuditCursor(event: { createdAt: Date; id: string }) {
  return `${event.createdAt.toISOString()}|${event.id}`;
}

export function decodeAuditCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const [createdAt, id] = cursor.split("|");
  const after = new Date(createdAt!);
  return Number.isNaN(after.getTime()) ? "invalid" : { after, id: id! };
}

function toAuditEvent({
  actorName,
  actorEmail,
  apiKeyName,
  actorType,
  actorId,
  ...event
}: {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  actorType: "user" | "api_key" | "system";
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  apiKeyName: string | null;
  createdAt: Date;
}) {
  return {
    ...event,
    actor: {
      type: actorType,
      id: actorId,
      name:
        actorName ??
        apiKeyName ??
        (actorType === "system"
          ? "System"
          : actorType === "api_key"
            ? "API key"
            : "Unknown user"),
      email: actorEmail,
    },
  };
}

export function registerAssetRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/workspaces/:workspaceId/overview",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "read",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      return inWorkspace(workspaceId, async (transaction) => {
        const now = new Date();
        const [[assets], [versions], [storage], activity, delivery] =
          await Promise.all([
            transaction
              .select({ count: count() })
              .from(asset)
              .where(eq(asset.workspaceId, workspaceId)),
            transaction
              .select({ count: count() })
              .from(assetVersion)
              .where(eq(assetVersion.workspaceId, workspaceId)),
            transaction
              .select({
                bytes:
                  sql<number>`coalesce(sum(${assetVersion.size}), 0)`.mapWith(
                    Number,
                  ),
              })
              .from(assetVersion)
              .where(
                and(
                  eq(assetVersion.workspaceId, workspaceId),
                  eq(assetVersion.status, "ready"),
                ),
              ),
            transaction
              .select(auditColumns)
              .from(auditEvent)
              .leftJoin(
                user,
                and(
                  eq(auditEvent.actorType, "user"),
                  eq(auditEvent.actorId, user.id),
                ),
              )
              .leftJoin(
                apikey,
                and(
                  eq(auditEvent.actorType, "api_key"),
                  eq(auditEvent.actorId, apikey.id),
                ),
              )
              .where(eq(auditEvent.workspaceId, workspaceId))
              .orderBy(desc(auditEvent.createdAt))
              .limit(6),
            deliverySummary(
              transaction,
              eq(deliveryEvent.workspaceId, workspaceId),
              now,
            ),
          ]);

        return {
          assets: assets?.count ?? 0,
          versions: versions?.count ?? 0,
          storageBytes: storage?.bytes ?? 0,
          delivery,
          activity: activity.map(toAuditEvent),
        };
      });
    },
  );

  // The overview shows the newest handful; this is the whole trail, paged.
  api.get(
    "/api/workspaces/:workspaceId/audit",
    {
      schema: {
        params: workspaceParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: auditCursor.optional(),
          action: z.string().max(64).optional(),
          actorType: z.enum(["user", "api_key", "system"]).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "read",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const { limit, cursor, action, actorType } = request.query;
      const position = decodeAuditCursor(cursor);
      if (position === "invalid")
        return reply.code(400).send({ error: "Invalid cursor" });

      return inWorkspace(workspaceId, async (transaction) => {
        const rows = await transaction
          .select(auditColumns)
          .from(auditEvent)
          .leftJoin(
            user,
            and(
              eq(auditEvent.actorType, "user"),
              eq(auditEvent.actorId, user.id),
            ),
          )
          .leftJoin(
            apikey,
            and(
              eq(auditEvent.actorType, "api_key"),
              eq(auditEvent.actorId, apikey.id),
            ),
          )
          .where(
            and(
              eq(auditEvent.workspaceId, workspaceId),
              action ? eq(auditEvent.action, action) : undefined,
              actorType ? eq(auditEvent.actorType, actorType) : undefined,
              position
                ? sql`(${auditEvent.createdAt}, ${auditEvent.id}) < (${position.after}, ${position.id})`
                : undefined,
            ),
          )
          .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
          .limit(limit + 1);

        const page = rows.slice(0, limit);
        const last = rows.length > limit ? page.at(-1) : undefined;
        return {
          events: page.map(toAuditEvent),
          nextCursor: last ? encodeAuditCursor(last) : null,
        };
      });
    },
  );

  // Adopt objects that are already in the bucket. One page per call, so a large
  // prefix is a loop the caller can watch rather than one request that hangs.
  api.post(
    "/api/workspaces/:workspaceId/imports",
    {
      schema: {
        params: workspaceParams,
        body: z.object({
          source: importSource,
          prefix: assetPrefix,
          token: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "create",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const { source, prefix, token, limit } = request.body;
      const page = await listObjectPage(source, token, limit);
      let imported = 0;
      let skipped = 0;

      for (const object of page.objects) {
        if (
          reservedPrefixes.some((reserved) =>
            object.key.startsWith(reserved),
          ) ||
          object.size > maximumUploadSize
        ) {
          skipped += 1;
          continue;
        }

        const key = importedAssetKey(prefix, source, object.key);
        // The extension decides the declared type; S3 metadata is the fallback,
        // and ingest still checks the bytes either way.
        let mimeType = key ? importedMimeType(object.key, undefined) : null;
        if (key && !mimeType) {
          const head = await headObject(object.key).catch(() => null);
          mimeType = importedMimeType(object.key, head?.ContentType);
        }
        if (!key || !mimeType) {
          skipped += 1;
          continue;
        }

        const assetId = randomUUID();
        const versionId = randomUUID();
        const storageKey = `originals/${workspaceId}/${assetId}/${versionId}/source`;
        const filename = object.key.split("/").at(-1) ?? key;

        const created = await inWorkspace(workspaceId, async (transaction) => {
          const [row] = await transaction
            .insert(asset)
            .values({
              id: assetId,
              workspaceId,
              key,
              displayName: filename,
              createdBy: authorization.principal.reference,
              updatedBy: authorization.principal.reference,
            })
            .onConflictDoNothing()
            .returning({ id: asset.id });
          if (!row) return false;

          await transaction.insert(assetVersion).values({
            id: versionId,
            workspaceId,
            assetId,
            number: 1,
            storageKey,
            filename,
            mimeType,
            size: object.size,
            createdBy: authorization.principal.reference,
            updatedBy: authorization.principal.reference,
          });
          await transaction.insert(auditEvent).values([
            {
              workspaceId,
              actorType: authorization.principal.actorType,
              actorId: authorization.principal.actorId,
              action: "asset.created",
              targetType: "asset",
              targetId: assetId,
              metadata: { key, displayName: filename, source: object.key },
              requestId: request.id,
            },
            {
              workspaceId,
              actorType: authorization.principal.actorType,
              actorId: authorization.principal.actorId,
              action: "asset.version_created",
              targetType: "asset_version",
              targetId: versionId,
              metadata: {
                assetId,
                key,
                displayName: filename,
                number: 1,
                filename,
                mimeType,
                size: object.size,
                source: object.key,
              },
              requestId: request.id,
            },
          ]);
          return true;
        });
        if (!created) {
          skipped += 1;
          continue;
        }

        try {
          await copyObject(object.key, storageKey, mimeType);
        } catch (error) {
          // Roll the record back rather than leave a version whose object never
          // arrives; the cascade takes the version with it.
          request.log.warn(
            { error, key: object.key },
            "Asset import copy failed",
          );
          await inWorkspace(workspaceId, (transaction) =>
            transaction.delete(asset).where(eq(asset.id, assetId)),
          );
          skipped += 1;
          continue;
        }

        await inWorkspace(workspaceId, async (transaction) => {
          await boss.send(
            assetIngestQueue,
            { workspaceId, assetId, versionId, requestId: request.id },
            { db: fromDrizzle(transaction, sql), singletonKey: versionId },
          );
          await transaction
            .update(assetVersion)
            .set({
              status: "processing",
              updatedBy: authorization.principal.reference,
            })
            .where(eq(assetVersion.id, versionId));
        });
        imported += 1;
      }

      return { imported, skipped, nextToken: page.nextToken };
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/folders",
    {
      schema: {
        params: workspaceParams,
        body: createFolderBody,
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "create",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const prefix = `${request.body.prefix}${request.body.name}/`;
      await inWorkspace(workspaceId, async (transaction) => {
        const [created] = await transaction
          .insert(assetFolder)
          .values({
            workspaceId,
            prefix,
            createdBy: authorization.principal.reference,
          })
          .onConflictDoNothing()
          .returning({ id: assetFolder.id });
        if (!created) return;

        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "folder.created",
          targetType: "folder",
          targetId: created.id,
          metadata: { prefix },
          requestId: request.id,
        });
      });

      return reply.code(201).send({ name: request.body.name, prefix });
    },
  );

  api.delete(
    "/api/workspaces/:workspaceId/folders",
    {
      schema: {
        params: workspaceParams,
        querystring: z.object({ prefix: folderPath }),
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const { prefix } = request.query;
      const authorization = await authorizeAsset(request, workspaceId, [
        "delete",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const result = await inWorkspace(workspaceId, async (transaction) => {
        const [[stored], [assets], [children]] = await Promise.all([
          transaction
            .select({ id: assetFolder.id })
            .from(assetFolder)
            .where(
              and(
                eq(assetFolder.workspaceId, workspaceId),
                eq(assetFolder.prefix, prefix),
              ),
            ),
          transaction
            .select({ count: count() })
            .from(asset)
            .where(
              and(
                eq(asset.workspaceId, workspaceId),
                sql`starts_with(${asset.key}, ${prefix})`,
              ),
            ),
          transaction
            .select({ count: count() })
            .from(assetFolder)
            .where(
              and(
                eq(assetFolder.workspaceId, workspaceId),
                sql`starts_with(${assetFolder.prefix}, ${prefix})`,
                sql`${assetFolder.prefix} <> ${prefix}`,
              ),
            ),
        ]);

        if ((assets?.count ?? 0) > 0 || (children?.count ?? 0) > 0)
          return "not-empty" as const;
        if (!stored) return "missing" as const;

        await transaction
          .delete(assetFolder)
          .where(eq(assetFolder.id, stored.id));
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "folder.deleted",
          targetType: "folder",
          targetId: stored.id,
          metadata: { prefix },
          requestId: request.id,
        });
        return "deleted" as const;
      });

      if (result === "not-empty")
        return reply
          .code(409)
          .send({ error: "Folder must be empty before it can be deleted" });
      if (result === "missing")
        return reply.code(404).send({ error: "Folder not found" });
      return reply.code(204).send();
    },
  );

  // ponytail: capped list; add cursor pagination when workspaces exceed 100 assets.
  api.get(
    "/api/workspaces/:workspaceId/assets",
    {
      schema: {
        params: workspaceParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          prefix: assetPrefix,
          search: z.string().trim().max(255).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "read",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const listing = await inWorkspace(workspaceId, async (transaction) => {
        const prefix = request.query.prefix;
        // A search spans every folder under the prefix and returns a flat list;
        // browsing stays one level deep so folders stay meaningful.
        const search = request.query.search;
        const needle = search
          ? `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
          : null;
        const remainder = sql<string>`substring(${asset.key} from length(${prefix}) + 1)`;
        const startsWithPrefix = sql`starts_with(${asset.key}, ${prefix})`;
        const folderName = sql<string>`split_part(${remainder}, '/', 1)`;
        const explicitRemainder = sql<string>`substring(${assetFolder.prefix} from length(${prefix}) + 1)`;
        const explicitFolderName = sql<string>`split_part(${explicitRemainder}, '/', 1)`;
        const [workspace] = await transaction
          .select({
            slug: workspaceTable.slug,
            customDomain: workspaceSettings.customDomain,
          })
          .from(workspaceTable)
          .leftJoin(
            workspaceSettings,
            and(
              eq(workspaceSettings.workspaceId, workspaceTable.id),
              isNotNull(workspaceSettings.customDomainVerifiedAt),
            ),
          )
          .where(eq(workspaceTable.id, workspaceId));
        const assets = await transaction
          .select({
            id: asset.id,
            key: asset.key,
            displayName: asset.displayName,
            currentVersionId: asset.currentVersionId,
            mimeType: assetVersion.mimeType,
            size: assetVersion.size,
            width: assetVersion.width,
            height: assetVersion.height,
            updatedAt: asset.updatedAt,
          })
          .from(asset)
          .leftJoin(assetVersion, eq(assetVersion.id, asset.currentVersionId))
          .where(
            and(
              eq(asset.workspaceId, workspaceId),
              startsWithPrefix,
              needle
                ? sql`(${asset.key} ilike ${needle} escape '\\' or ${asset.displayName} ilike ${needle} escape '\\')`
                : sql`position('/' in ${remainder}) = 0`,
            ),
          )
          .orderBy(asc(asset.key))
          .limit(request.query.limit);
        const assetFolders = needle
          ? []
          : await transaction
              .selectDistinct({ name: folderName })
              .from(asset)
              .where(
                and(
                  eq(asset.workspaceId, workspaceId),
                  startsWithPrefix,
                  sql`position('/' in ${remainder}) > 0`,
                ),
              )
              .limit(100);
        const explicitFolders = needle
          ? []
          : await transaction
              .selectDistinct({ name: explicitFolderName })
              .from(assetFolder)
              .where(
                and(
                  eq(assetFolder.workspaceId, workspaceId),
                  sql`starts_with(${assetFolder.prefix}, ${prefix})`,
                  sql`length(${assetFolder.prefix}) > length(${prefix})`,
                ),
              )
              .limit(100);
        const latest = await transaction
          .selectDistinctOn([assetVersion.assetId], {
            assetId: assetVersion.assetId,
            id: assetVersion.id,
            status: assetVersion.status,
            error: assetVersion.error,
          })
          .from(assetVersion)
          .where(eq(assetVersion.workspaceId, workspaceId))
          .orderBy(assetVersion.assetId, desc(assetVersion.number));
        const latestByAsset = new Map(
          latest.map((version) => [version.assetId, version]),
        );

        return {
          folders: [
            ...new Set(
              [...assetFolders, ...explicitFolders].map(({ name }) => name),
            ),
          ]
            .map((name) => ({ name, prefix: `${prefix}${name}/` }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          assets: assets.map((item) => {
            const latestVersion = latestByAsset.get(item.id);
            return {
              ...item,
              latestVersionId: latestVersion?.id ?? null,
              status: latestVersion?.status ?? null,
              error: latestVersion?.error ?? null,
              customDomain: workspace?.customDomain ?? null,
              thumbnailUrl:
                workspace && item.currentVersionId
                  ? transformedAssetUrl(
                      workspace.slug,
                      item.key,
                      thumbnailTransformation,
                      workspace.customDomain,
                    )
                  : null,
            };
          }),
        };
      });

      return listing;
    },
  );

  api.get(
    "/api/workspaces/:workspaceId/assets/:assetId",
    { schema: { params: assetParams } },
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

      const result = await inWorkspace(workspaceId, async (transaction) => {
        const [workspace] = await transaction
          .select({
            slug: workspaceTable.slug,
            customDomain: workspaceSettings.customDomain,
          })
          .from(workspaceTable)
          .leftJoin(
            workspaceSettings,
            and(
              eq(workspaceSettings.workspaceId, workspaceTable.id),
              isNotNull(workspaceSettings.customDomainVerifiedAt),
            ),
          )
          .where(eq(workspaceTable.id, workspaceId));
        const [item] = await transaction
          .select({
            id: asset.id,
            key: asset.key,
            displayName: asset.displayName,
            currentVersionId: asset.currentVersionId,
            mimeType: assetVersion.mimeType,
            size: assetVersion.size,
            width: assetVersion.width,
            height: assetVersion.height,
            updatedAt: asset.updatedAt,
          })
          .from(asset)
          .leftJoin(assetVersion, eq(assetVersion.id, asset.currentVersionId))
          .where(
            and(eq(asset.workspaceId, workspaceId), eq(asset.id, assetId)),
          );
        if (!item) return null;
        const [latest] = await transaction
          .select({
            id: assetVersion.id,
            status: assetVersion.status,
            error: assetVersion.error,
          })
          .from(assetVersion)
          .where(
            and(
              eq(assetVersion.workspaceId, workspaceId),
              eq(assetVersion.assetId, assetId),
            ),
          )
          .orderBy(desc(assetVersion.number))
          .limit(1);
        return {
          ...item,
          latestVersionId: latest?.id ?? null,
          status: latest?.status ?? null,
          error: latest?.error ?? null,
          customDomain: workspace?.customDomain ?? null,
          thumbnailUrl:
            workspace && item.currentVersionId
              ? transformedAssetUrl(
                  workspace.slug,
                  item.key,
                  thumbnailTransformation,
                  workspace.customDomain,
                )
              : null,
        };
      });

      return result ?? reply.code(404).send({ error: "Asset not found" });
    },
  );

  api.delete(
    "/api/workspaces/:workspaceId/assets/:assetId",
    { schema: { params: assetParams } },
    async (request, reply) => {
      const { workspaceId, assetId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "delete",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const deleted = await inWorkspace(workspaceId, async (transaction) => {
        const [target] = await transaction
          .select({ key: asset.key, displayName: asset.displayName })
          .from(asset)
          .where(and(eq(asset.workspaceId, workspaceId), eq(asset.id, assetId)))
          .for("update");
        if (!target) return null;
        const versions = await transaction
          .select({ id: assetVersion.id, storageKey: assetVersion.storageKey })
          .from(assetVersion)
          .where(
            and(
              eq(assetVersion.workspaceId, workspaceId),
              eq(assetVersion.assetId, assetId),
            ),
          );

        await transaction
          .delete(asset)
          .where(
            and(eq(asset.workspaceId, workspaceId), eq(asset.id, assetId)),
          );
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "asset.deleted",
          targetType: "asset",
          targetId: assetId,
          metadata: { key: target.key, displayName: target.displayName },
          requestId: request.id,
        });
        await boss.send(
          assetDeleteQueue,
          {
            versionIds: versions.map(({ id }) => id),
            storageKeys: versions.map(({ storageKey }) => storageKey),
          },
          { db: fromDrizzle(transaction, sql), singletonKey: assetId },
        );
        return target;
      });

      return deleted
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Asset not found" });
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/assets",
    {
      schema: {
        params: workspaceParams,
        body: z.object({
          key: assetKey,
          displayName: z.string().min(1).max(255),
        }),
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "create",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      try {
        const created = await inWorkspace(workspaceId, async (transaction) => {
          const [row] = await transaction
            .insert(asset)
            .values({
              workspaceId,
              key: request.body.key,
              displayName: request.body.displayName,
              createdBy: authorization.principal.reference,
              updatedBy: authorization.principal.reference,
            })
            .returning({
              id: asset.id,
              key: asset.key,
              displayName: asset.displayName,
            });

          if (!row) throw new Error("Asset insert returned no row");
          await transaction.insert(auditEvent).values({
            workspaceId,
            actorType: authorization.principal.actorType,
            actorId: authorization.principal.actorId,
            action: "asset.created",
            targetType: "asset",
            targetId: row.id,
            metadata: { key: row.key, displayName: row.displayName },
            requestId: request.id,
          });

          return row;
        });

        return reply.code(201).send(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "Asset key already exists" });
        }
        throw error;
      }
    },
  );

  api.get(
    "/api/workspaces/:workspaceId/assets/:assetId/delivery",
    { schema: { params: assetParams } },
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

      return inWorkspace(workspaceId, async (transaction) => {
        const [target] = await transaction
          .select({ id: asset.id })
          .from(asset)
          .where(
            and(eq(asset.workspaceId, workspaceId), eq(asset.id, assetId)),
          );
        if (!target) return reply.code(404).send({ error: "Asset not found" });

        return deliverySummary(
          transaction,
          and(
            eq(deliveryEvent.workspaceId, workspaceId),
            eq(deliveryEvent.assetId, assetId),
          ),
        );
      });
    },
  );

  api.get(
    "/api/workspaces/:workspaceId/assets/:assetId/versions",
    {
      schema: {
        params: assetParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
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

      return inWorkspace(workspaceId, async (transaction) => {
        const [target] = await transaction
          .select({ currentVersionId: asset.currentVersionId })
          .from(asset)
          .where(
            and(eq(asset.workspaceId, workspaceId), eq(asset.id, assetId)),
          );
        if (!target) return reply.code(404).send({ error: "Asset not found" });

        const versions = await transaction
          .select({
            id: assetVersion.id,
            number: assetVersion.number,
            status: assetVersion.status,
            filename: assetVersion.filename,
            mimeType: assetVersion.mimeType,
            size: assetVersion.size,
            width: assetVersion.width,
            height: assetVersion.height,
            checksum: assetVersion.checksum,
            error: assetVersion.error,
            createdAt: assetVersion.createdAt,
            createdBy: assetVersion.createdBy,
          })
          .from(assetVersion)
          .where(
            and(
              eq(assetVersion.workspaceId, workspaceId),
              eq(assetVersion.assetId, assetId),
            ),
          )
          .orderBy(desc(assetVersion.number))
          .limit(request.query.limit);

        return {
          currentVersionId: target.currentVersionId,
          versions: versions.map((version) => ({
            ...version,
            current: version.id === target.currentVersionId,
          })),
        };
      });
    },
  );

  // Versions are immutable, so going back is moving the pointer, not restoring
  // bytes. The old current version stays exactly where it was.
  api.post(
    "/api/workspaces/:workspaceId/assets/:assetId/versions/:versionId/restore",
    { schema: { params: versionParams } },
    async (request, reply) => {
      const { workspaceId, assetId, versionId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "publish",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const result = await inWorkspace(workspaceId, async (transaction) => {
        const [target] = await transaction
          .select({
            key: asset.key,
            displayName: asset.displayName,
            currentVersionId: asset.currentVersionId,
          })
          .from(asset)
          .where(and(eq(asset.workspaceId, workspaceId), eq(asset.id, assetId)))
          .for("update");
        if (!target) return { error: "Asset not found" as const };

        const [version] = await transaction
          .select({
            id: assetVersion.id,
            number: assetVersion.number,
            status: assetVersion.status,
          })
          .from(assetVersion)
          .where(
            and(
              eq(assetVersion.workspaceId, workspaceId),
              eq(assetVersion.assetId, assetId),
              eq(assetVersion.id, versionId),
            ),
          );
        if (!version) return { error: "Version not found" as const };
        if (version.status !== "ready")
          return { conflict: "Only a ready version can be restored" as const };
        if (target.currentVersionId === versionId)
          return { currentVersionId: versionId, number: version.number };

        await transaction
          .update(asset)
          .set({
            currentVersionId: versionId,
            updatedBy: authorization.principal.reference,
          })
          .where(eq(asset.id, assetId));
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "asset.version_restored",
          targetType: "asset_version",
          targetId: versionId,
          metadata: {
            assetId,
            key: target.key,
            displayName: target.displayName,
            number: version.number,
            previousVersionId: target.currentVersionId,
          },
          requestId: request.id,
        });

        return { currentVersionId: versionId, number: version.number };
      });

      if ("error" in result)
        return reply.code(404).send({ error: result.error });
      if ("conflict" in result)
        return reply.code(409).send({ error: result.conflict });
      return result;
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/assets/:assetId/versions",
    { schema: { params: assetParams, body: uploadBody } },
    async (request, reply) => {
      const { workspaceId, assetId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "update",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const versionId = randomUUID();
      const storageKey = `originals/${workspaceId}/${assetId}/${versionId}/source`;
      const version = await inWorkspace(workspaceId, async (transaction) => {
        const [target] = await transaction
          .select({
            id: asset.id,
            key: asset.key,
            displayName: asset.displayName,
          })
          .from(asset)
          .where(and(eq(asset.workspaceId, workspaceId), eq(asset.id, assetId)))
          .for("update");
        if (!target) return null;

        const [latest] = await transaction
          .select({ number: max(assetVersion.number) })
          .from(assetVersion)
          .where(eq(assetVersion.assetId, assetId));
        const number = (latest?.number ?? 0) + 1;

        await transaction.insert(assetVersion).values({
          id: versionId,
          workspaceId,
          assetId,
          number,
          storageKey,
          filename: request.body.filename,
          mimeType: request.body.mimeType,
          size: request.body.size,
          createdBy: authorization.principal.reference,
          updatedBy: authorization.principal.reference,
        });
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "asset.version_created",
          targetType: "asset_version",
          targetId: versionId,
          metadata: {
            assetId,
            key: target.key,
            displayName: target.displayName,
            number,
            filename: request.body.filename,
            mimeType: request.body.mimeType,
            size: request.body.size,
          },
          requestId: request.id,
        });

        return { id: versionId, number, status: "pending" as const };
      });
      if (!version) return reply.code(404).send({ error: "Asset not found" });

      const upload = await createUpload(
        storageKey,
        request.body.mimeType,
        request.body.size,
      );
      return reply.code(201).send({
        ...version,
        upload: {
          method: "POST" as const,
          url: upload.url,
          fields: upload.fields,
        },
      });
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/assets/:assetId/versions/:versionId/finalize",
    { schema: { params: versionParams } },
    async (request, reply) => {
      const { workspaceId, assetId, versionId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "publish",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const pending = await inWorkspace(workspaceId, async (transaction) => {
        const [row] = await transaction
          .select()
          .from(assetVersion)
          .where(
            and(
              eq(assetVersion.workspaceId, workspaceId),
              eq(assetVersion.assetId, assetId),
              eq(assetVersion.id, versionId),
            ),
          );
        return row ?? null;
      });
      if (!pending) return reply.code(404).send({ error: "Version not found" });
      if (pending.status === "ready" || pending.status === "processing") {
        return reply.code(pending.status === "ready" ? 200 : 202).send({
          id: versionId,
          status: pending.status,
        });
      }
      if (pending.status === "failed") {
        return reply
          .code(409)
          .send({ error: pending.error ?? "Version processing failed" });
      }

      let uploaded: Awaited<ReturnType<typeof inspectUpload>>;
      try {
        uploaded = await inspectUpload(pending.storageKey);
      } catch {
        return reply.code(409).send({ error: "Upload not found" });
      }
      if (
        uploaded.ContentLength !== pending.size ||
        uploaded.ContentType !== pending.mimeType
      ) {
        return reply
          .code(409)
          .send({ error: "Uploaded object does not match the version" });
      }

      const status = await inWorkspace(workspaceId, async (transaction) => {
        const [current] = await transaction
          .select({
            status: assetVersion.status,
            number: assetVersion.number,
            filename: assetVersion.filename,
            key: asset.key,
            displayName: asset.displayName,
          })
          .from(assetVersion)
          .innerJoin(asset, eq(asset.id, assetVersion.assetId))
          .where(eq(assetVersion.id, versionId))
          .for("update");
        if (!current) return null;
        if (current.status !== "pending") return current.status;

        await boss.send(
          assetIngestQueue,
          { workspaceId, assetId, versionId, requestId: request.id },
          {
            db: fromDrizzle(transaction, sql),
            singletonKey: versionId,
          },
        );
        await transaction
          .update(assetVersion)
          .set({
            status: "processing",
            updatedBy: authorization.principal.reference,
          })
          .where(eq(assetVersion.id, versionId));
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "asset.version_queued",
          targetType: "asset_version",
          targetId: versionId,
          metadata: {
            assetId,
            key: current.key,
            displayName: current.displayName,
            number: current.number,
            filename: current.filename,
          },
          requestId: request.id,
        });

        return "processing" as const;
      });

      if (!status) return reply.code(404).send({ error: "Version not found" });
      if (status === "failed") {
        return reply.code(409).send({ error: "Version processing failed" });
      }
      return reply
        .code(status === "ready" ? 200 : 202)
        .send({ id: versionId, status });
    },
  );
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
