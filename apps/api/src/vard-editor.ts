import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeAsset } from "./authorization.js";
import { asset, assetVersion, auditEvent, vard, vardItem } from "./db/app-schema.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import { inWorkspace, inWorkspaceSnapshot, type Transaction } from "./db/tenant.js";
import { folderRulesSchema, vardOutputPath } from "./vard-folder-rules.js";
import { buildVardPayloadInTransaction } from "./vard-payload.js";
import { transformationSchema } from "./transformation.js";
import { assertVardDefinitionProtocol, VardDefinitionUpgradeError,
  vardDefinitionUpgradeFailure } from "./vard-definition-model.js";
import { deleteEditorV2, editorGetQuery, editorPayloadV2, patchEditorV2,
  replaceEditorItemsV2, VardEditorV2Error, v2DeleteQuery, v2ItemsBody,
  v2PatchBody } from "./vard-editor-v2.js";

const params = z.object({ workspaceId: z.string().min(1), vardId: z.uuid() });
const revision = z.string().regex(/^v1:[a-f0-9]{64}$/, "Invalid editor revision");
const patchBody = z.object({
  expectedRevision: revision,
  name: z.string().trim().min(1).max(80).optional(),
  isPublic: z.boolean().optional(),
  folderRules: folderRulesSchema.optional(),
}).strict().refine(
  (value) => value.name !== undefined || value.isPublic !== undefined || value.folderRules !== undefined,
  "At least one editable field is required",
);
const itemInput = z.object({
  id: z.uuid().nullable(),
  assetId: z.uuid(),
  versionId: z.uuid().nullable(),
  outputPath: vardOutputPath,
  transformation: transformationSchema.nullable().default(null),
  writable: z.boolean().default(false),
}).strict().refine(
  ({ transformation, versionId, writable }) => !writable || (!transformation && !versionId),
  "Writable items must follow the original latest version",
);
const itemsBody = z.object({
  expectedRevision: revision,
  items: z.array(itemInput).max(1000),
}).strict();
type ItemInput = z.infer<typeof itemInput>;

class EditorError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly currentRevision?: string) {
    super(message);
  }
}

export function registerVardEditorRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const url = "/api/workspaces/:workspaceId/vards/:vardId/editor";
  api.get(url, { schema: { params, querystring: editorGetQuery } }, async (request, reply) => {
    const { workspaceId, vardId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read"]);
    if (!("principal" in authorization))
      return reply.code(authorization.statusCode).send({ error: authorization.error });
    try {
      return await inWorkspaceSnapshot(workspaceId, async (tx) => {
        if ("definitionSchema" in request.query)
          return editorPayloadV2(tx, workspaceId, vardId);
        return editorPayload(tx, workspaceId, vardId);
      });
    } catch (error) { return editorFailure(reply, error); }
  });

  api.patch(url, { schema: { params, body: z.union([patchBody, v2PatchBody]) } }, async (request, reply) => {
    const { workspaceId, vardId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read", "update"]);
    if (!("principal" in authorization))
      return reply.code(authorization.statusCode).send({ error: authorization.error });
    try {
      return await inWorkspace(workspaceId, async (tx) => {
        await lockWorkspaceContent(tx, workspaceId);
        if ("definitionSchema" in request.body)
          return patchEditorV2(tx, workspaceId, vardId, request.body, authorization.principal, request.id);
        await assertVardDefinitionProtocol(tx, workspaceId, vardId, 1);
        const state = await editableState(tx, workspaceId, vardId);
        compareRevision(state.revision, request.body.expectedRevision);
        const { expectedRevision: _expectedRevision, ...fields } = request.body;
        const changed = Object.entries(fields).some(([key, value]) =>
          canonical(value) !== canonical(state.record[key as keyof typeof fields]));
        if (changed) {
          await tx.update(vard).set({
            ...fields, updatedAt: new Date(), updatedBy: authorization.principal.reference,
          }).where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
          await tx.insert(auditEvent).values({
            workspaceId, actorType: authorization.principal.actorType,
            actorId: authorization.principal.actorId, action: "vard.updated",
            targetType: "vard", targetId: vardId, metadata: fields, requestId: request.id,
          });
        }
        return editorPayload(tx, workspaceId, vardId);
      });
    } catch (error) { return editorFailure(reply, error); }
  });

  api.put(`${url}/items`, { schema: { params, body: z.union([itemsBody, v2ItemsBody]) } }, async (request, reply) => {
    const { workspaceId, vardId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read", "update"]);
    if (!("principal" in authorization))
      return reply.code(authorization.statusCode).send({ error: authorization.error });
    try {
      return await inWorkspace(workspaceId, async (tx) => {
        await lockWorkspaceContent(tx, workspaceId);
        if ("definitionSchema" in request.body)
          return replaceEditorItemsV2(tx, workspaceId, vardId, request.body, authorization.principal, request.id);
        await assertVardDefinitionProtocol(tx, workspaceId, vardId, 1);
        const state = await editableState(tx, workspaceId, vardId);
        compareRevision(state.revision, request.body.expectedRevision);
        const desired = request.body.items;
        const byId = new Map(state.items.map((item) => [item.id, item]));
        const retainedIds = new Set<string>();
        const paths = new Set<string>();
        for (const item of desired) {
          if (item.id !== null) {
            if (retainedIds.has(item.id)) throw new EditorError(400, "Duplicate manual item ID");
            if (!byId.has(item.id)) throw new EditorError(400, "Manual item ID does not belong to this Vard");
            retainedIds.add(item.id);
          }
          const path = item.outputPath.normalize("NFC").toLowerCase();
          if (paths.has(path)) throw new EditorError(400, `Duplicate output path: ${path}`);
          paths.add(path);
        }
        await validateItems(tx, workspaceId, desired, byId);
        const changed = desired.filter((item) => item.id === null ||
          canonical(itemFields(item)) !== canonical(itemFields(byId.get(item.id)!)));
        const removed = state.items.filter((item) => !retainedIds.has(item.id));
        if (changed.length || removed.length) {
          // The output-path unique index is immediate. Remove every moved row first,
          // so swaps/cycles can be inserted with their original IDs and creation data.
          const moved = changed.filter((item) => item.id !== null &&
            byId.get(item.id)!.outputPath !== item.outputPath);
          const deleteIds = [...removed.map((item) => item.id), ...moved.map((item) => item.id!)];
          if (deleteIds.length)
            await tx.delete(vardItem).where(and(eq(vardItem.vardId, vardId), inArray(vardItem.id, deleteIds)));
          const now = new Date();
          for (const item of changed) {
            const old = item.id === null ? undefined : byId.get(item.id)!;
            const fields = { ...itemFields(item), updatedAt: now, updatedBy: authorization.principal.reference };
            if (!old || old.outputPath !== item.outputPath) {
              await tx.insert(vardItem).values({
                ...fields, id: old?.id ?? randomUUID(), workspaceId, vardId,
                createdBy: old?.createdBy ?? authorization.principal.reference,
                ...(old ? { createdAt: sql`${old.createdAtText}::timestamptz` } : {}),
              });
            } else {
              await tx.update(vardItem).set(fields).where(and(eq(vardItem.vardId, vardId), eq(vardItem.id, old.id)));
            }
          }
          await tx.update(vard).set({ updatedAt: now, updatedBy: authorization.principal.reference })
            .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
          await tx.insert(auditEvent).values({
            workspaceId, actorType: authorization.principal.actorType,
            actorId: authorization.principal.actorId, action: "vard.items_updated",
            targetType: "vard", targetId: vardId, metadata: { itemCount: desired.length }, requestId: request.id,
          });
        }
        return editorPayload(tx, workspaceId, vardId);
      });
    } catch (error) { return editorFailure(reply, error); }
  });

  api.delete(url, { schema: { params, querystring: z.union([
    z.object({ expectedRevision: revision }).strict(), v2DeleteQuery,
  ]) } }, async (request, reply) => {
    const { workspaceId, vardId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["delete"]);
    if (!("principal" in authorization))
      return reply.code(authorization.statusCode).send({ error: authorization.error });
    try {
      await inWorkspace(workspaceId, async (tx) => {
        await lockWorkspaceContent(tx, workspaceId);
        if ("definitionSchema" in request.query)
          return deleteEditorV2(tx, workspaceId, vardId, request.query.expectedRevision,
            authorization.principal, request.id);
        await assertVardDefinitionProtocol(tx, workspaceId, vardId, 1);
        const state = await editableState(tx, workspaceId, vardId);
        compareRevision(state.revision, request.query.expectedRevision);
        await tx.delete(vard).where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
        await tx.insert(auditEvent).values({
          workspaceId, actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId, action: "vard.deleted",
          targetType: "vard", targetId: vardId, metadata: { name: state.record.name }, requestId: request.id,
        });
      });
      return reply.code(204).send();
    } catch (error) { return editorFailure(reply, error); }
  });
}

async function editableState(tx: Transaction, workspaceId: string, vardId: string) {
  const [record] = await tx.select({
    id: vard.id, workspaceId: vard.workspaceId, name: vard.name, isPublic: vard.isPublic,
    folderRules: vard.folderRules,
    // JS Date loses PostgreSQL microseconds. Hash the exact UTC database value.
    updatedAtText: sql<string>`to_char(${vard.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(vard).where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
  if (!record) throw new EditorError(404, "Vard not found");
  const items = await tx.select({
    id: vardItem.id, assetId: vardItem.assetId, versionId: vardItem.versionId,
    outputPath: vardItem.outputPath, transformation: vardItem.transformation, writable: vardItem.writable,
    createdBy: vardItem.createdBy,
    createdAtText: sql<string>`to_char(${vardItem.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(vardItem).where(and(eq(vardItem.workspaceId, workspaceId), eq(vardItem.vardId, vardId)))
    .orderBy(asc(vardItem.id));
  // This is state-equivalence OCC, not a monotonic mutation counter: an exact
  // restored state (including timestamps/IDs) can reuse its token. Live source
  // metadata/current versions, URLs and generated membership are deliberately absent.
  const revision = `v1:${createHash("sha256").update(canonical({ record, items })).digest("hex")}`;
  return { record, items, revision };
}

async function editorPayload(tx: Transaction, workspaceId: string, vardId: string) {
  await assertVardDefinitionProtocol(tx, workspaceId, vardId, 1);
  const state = await editableState(tx, workspaceId, vardId);
  const definition = await buildVardPayloadInTransaction(tx, workspaceId, vardId, {
    resolveFolders: false, includePinnedVersionId: true,
  });
  if (!definition) throw new EditorError(404, "Vard not found");
  return { ...definition, revision: state.revision };
}

function compareRevision(current: string, expected: string) {
  if (current !== expected) throw new EditorError(409, "Vard changed; reload before saving.", current);
}

function itemFields(item: Omit<ItemInput, "id">) {
  return { assetId: item.assetId, versionId: item.versionId, outputPath: item.outputPath,
    transformation: item.transformation, writable: item.writable };
}

async function validateItems(
  tx: Transaction,
  workspaceId: string,
  items: ItemInput[],
  persisted: ReadonlyMap<string, { assetId: string; versionId: string | null }>,
) {
  const assetIds = [...new Set(items.map((item) => item.assetId))];
  const assets = assetIds.length ? await tx.select({ id: asset.id }).from(asset)
    .where(and(eq(asset.workspaceId, workspaceId), inArray(asset.id, assetIds))) : [];
  if (assets.length !== assetIds.length) throw new EditorError(400, "Asset does not belong to workspace");
  const pinned = items.filter((item): item is ItemInput & { versionId: string } => item.versionId !== null);
  if (!pinned.length) return;
  const versions = await tx.select({
    id: assetVersion.id, assetId: assetVersion.assetId, status: assetVersion.status,
  }).from(assetVersion).where(and(eq(assetVersion.workspaceId, workspaceId),
    inArray(assetVersion.id, pinned.map((item) => item.versionId))));
  const byId = new Map(versions.map((version) => [version.id, version]));
  if (pinned.some((item) => {
    const version = byId.get(item.versionId);
    // Retain an existing literal pin even when its source becomes unavailable.
    // Ownership/existence still applies; new or reassigned pins must be ready.
    const old = item.id === null ? undefined : persisted.get(item.id);
    const retainedPin = old?.assetId === item.assetId && old.versionId === item.versionId;
    return version?.assetId !== item.assetId || (!retainedPin && version.status !== "ready");
  })) throw new EditorError(400, "Pinned version must be ready and belong to its asset");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function editorFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof VardDefinitionUpgradeError) return vardDefinitionUpgradeFailure(reply);
  if (error instanceof VardEditorV2Error) return reply.code(error.status).send({
    ...(error.code ? { code: error.code } : {}), error: error.message,
    ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
  });
  if (error instanceof EditorError) return reply.code(error.status).send(error.currentRevision ? {
    code: "vard_revision_conflict", error: error.message, currentRevision: error.currentRevision,
  } : { error: error.message });
  if (isUniqueViolation(error)) return reply.code(409).send({ error: "Vard name already exists" });
  throw error;
}
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "23505" || isUniqueViolation(candidate.cause);
}
