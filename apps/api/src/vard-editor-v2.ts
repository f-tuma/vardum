import { createHash, randomUUID } from "node:crypto";
import type { VardEditorDefinitionV2, VardEditorItemInputV2 } from "@vardum/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { asset, assetUse, assetVersion, auditEvent, vard, vardItem } from "./db/app-schema.js";
import { useRows, useIssue } from "./asset-use-query.js";
import type { AuthorizationResult } from "./authorization.js";
import type { Transaction } from "./db/tenant.js";
import { folderRulesSchema, vardOutputPath } from "./vard-folder-rules.js";
import { buildVardPayloadInTransaction } from "./vard-payload.js";
import { transformationSchema } from "./transformation.js";

export const v2Revision = z.string().regex(/^v2:[a-f0-9]{64}$/, "Invalid editor revision");
const sourceBinding = z.object({
  kind: z.literal("source"),
  assetId: z.uuid(),
  versionId: z.uuid().nullable(),
  transformation: transformationSchema.nullable(),
  writable: z.boolean(),
}).strict().refine(
  ({ transformation, versionId, writable }) => !writable || (!transformation && !versionId),
  "Writable items must follow the original latest version",
);
const useBinding = z.object({ kind: z.literal("use"), assetUseId: z.uuid() }).strict();
export const v2ItemInput = z.object({
  id: z.uuid().nullable(), outputPath: vardOutputPath,
  binding: z.discriminatedUnion("kind", [sourceBinding, useBinding]),
}).strict();
export const v2ItemsBody = z.object({
  definitionSchema: z.literal(2), expectedRevision: v2Revision,
  items: z.array(v2ItemInput).max(1000),
}).strict();
export const v2PatchBody = z.object({
  definitionSchema: z.literal(2), expectedRevision: v2Revision,
  name: z.string().trim().min(1).max(80).optional(),
  isPublic: z.boolean().optional(), folderRules: folderRulesSchema.optional(),
  returnToSourceOnly: z.literal(true).optional(),
}).strict().refine((value) => value.name !== undefined || value.isPublic !== undefined ||
  value.folderRules !== undefined || value.returnToSourceOnly === true,
"At least one editable field is required");
const queryDiscriminator = z.literal("2").transform(() => 2 as const);
export const editorGetQuery = z.union([
  z.object({}).strict(), z.object({ definitionSchema: queryDiscriminator }).strict(),
]);
export const v2DeleteQuery = z.object({
  definitionSchema: queryDiscriminator, expectedRevision: v2Revision,
}).strict();
export type V2ItemInput = VardEditorItemInputV2;

export class VardEditorV2Error extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly currentRevision?: string,
    readonly code?: string,
  ) { super(message); }
}

export function canonicalDefinition(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDefinition).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalDefinition((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Literal configuration only. Live use/source state must never enter the token. */
export async function editableStateV2(tx: Transaction, workspaceId: string, vardId: string) {
  const [record] = await tx.select({
    id: vard.id, workspaceId: vard.workspaceId, name: vard.name, isPublic: vard.isPublic,
    folderRules: vard.folderRules, definitionSchema: vard.definitionSchema,
    updatedAt: vard.updatedAt, createdBy: vard.createdBy, updatedBy: vard.updatedBy,
    createdAtText: sql<string>`to_char(${vard.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    updatedAtText: sql<string>`to_char(${vard.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(vard).where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
  if (!record) throw new VardEditorV2Error(404, "Vard not found");
  const items = await tx.select({
    id: vardItem.id, assetId: vardItem.assetId, assetUseId: vardItem.assetUseId,
    versionId: vardItem.versionId, outputPath: vardItem.outputPath,
    transformation: vardItem.transformation, writable: vardItem.writable,
    definitionSchema: vardItem.definitionSchema, createdBy: vardItem.createdBy,
    updatedBy: vardItem.updatedBy,
    createdAtText: sql<string>`to_char(${vardItem.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    updatedAtText: sql<string>`to_char(${vardItem.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(vardItem).where(and(eq(vardItem.workspaceId, workspaceId), eq(vardItem.vardId, vardId)))
    .orderBy(asc(vardItem.id));
  if (items.some((item) => item.definitionSchema !== record.definitionSchema ||
    (item.assetUseId !== null && record.definitionSchema !== 2)))
    throw new Error("Inconsistent Vard definition format");
  const { updatedAt: _date, definitionSchema: storedDefinitionSchema, ...literalRecord } = record;
  const revision = `v2:${createHash("sha256").update(canonicalDefinition({
    definitionSchema: 2, storedDefinitionSchema, record: literalRecord,
    items: items.map((item) => ({ ...item, kind: item.assetUseId ? "use" : "source" })),
  })).digest("hex")}`;
  return { record, items, revision };
}

export async function editorPayloadV2(tx: Transaction, workspaceId: string, vardId: string): Promise<VardEditorDefinitionV2> {
  const state = await editableStateV2(tx, workspaceId, vardId);
  const payload = await buildVardPayloadInTransaction(tx, workspaceId, vardId, {
    resolveFolders: false, includePinnedVersionId: true, includeEditorDiagnostics: true,
  });
  if (!payload) throw new VardEditorV2Error(404, "Vard not found");
  const byId = new Map(payload.items.map((item) => [item.id, item]));
  return {
    definitionSchema: 2 as const, storedDefinitionSchema: state.record.definitionSchema,
    revision: state.revision, id: state.record.id, workspaceId,
    name: state.record.name, isPublic: state.record.isPublic,
    updatedAt: state.record.updatedAt.toISOString(), folderRules: state.record.folderRules,
    items: state.items.map((item) => {
      const output = byId.get(item.id);
      if (!output) throw new Error("Vard output is missing its canonical source");
      const { id: _id, outputPath: _path, linkedUse, availabilityError,
        bindingIdentity: _bindingIdentity, ...resolved } = output;
      return {
        id: item.id, outputPath: item.outputPath,
        binding: item.assetUseId
          ? { kind: "use" as const, assetUseId: item.assetUseId }
          : { kind: "source" as const, assetId: item.assetId, versionId: item.versionId,
            transformation: item.transformation, writable: item.writable },
        resolved: { ...resolved, availabilityError: availabilityError ?? null },
        linkedUse: linkedUse ?? null,
      };
    }),
  };
}

export function compareRevisionV2(current: string, expected: string) {
  if (current !== expected)
    throw new VardEditorV2Error(409, "Vard changed; reload before saving.", current, "vard_revision_conflict");
}

type EditorPrincipal = Extract<AuthorizationResult, { principal: unknown }>["principal"];

/** The route must already hold the workspace content guard on this transaction. */
export async function patchEditorV2(
  tx: Transaction, workspaceId: string, vardId: string,
  body: z.infer<typeof v2PatchBody>, principal: EditorPrincipal, requestId: string,
) {
  const state = await editableStateV2(tx, workspaceId, vardId);
  compareRevisionV2(state.revision, body.expectedRevision);
  const { definitionSchema: _wire, expectedRevision: _expected,
    returnToSourceOnly, ...fields } = body;
  const proposedRules = fields.folderRules ?? state.record.folderRules;
  if (returnToSourceOnly && (state.items.some((item) => item.assetUseId !== null) ||
    proposedRules.some((rule) => "includeUses" in rule && rule.includeUses === true)))
    throw new VardEditorV2Error(409,
      "Remove live library bindings before returning to a source-only definition.",
      undefined, "vard_definition_has_bindings");
  const definitionSchema = returnToSourceOnly ? 1 : state.record.definitionSchema;
  const changed = definitionSchema !== state.record.definitionSchema ||
    Object.entries(fields).some(([key, value]) => canonicalDefinition(value) !==
      canonicalDefinition(state.record[key as keyof typeof state.record]));
  if (changed) {
    await tx.update(vard).set({ ...fields, definitionSchema,
      updatedAt: new Date(), updatedBy: principal.reference,
    }).where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
    await tx.insert(auditEvent).values({ workspaceId,
      actorType: principal.actorType, actorId: principal.actorId,
      action: "vard.updated", targetType: "vard", targetId: vardId,
      metadata: { ...fields, ...(definitionSchema !== state.record.definitionSchema
        ? { storedDefinitionSchema: definitionSchema } : {}) }, requestId,
    });
  }
  return editorPayloadV2(tx, workspaceId, vardId);
}

type StoredItemV2 = Awaited<ReturnType<typeof editableStateV2>>["items"][number];
type LiteralItemV2 = Pick<StoredItemV2,
  "assetId" | "assetUseId" | "versionId" | "outputPath" | "transformation" | "writable">;

/** Resolve source identities without copying any live recipe into the definition. */
async function validateItemsV2(
  tx: Transaction, workspaceId: string, items: V2ItemInput[],
  persisted: ReadonlyMap<string, StoredItemV2>,
) {
  const sourceInputs = items.filter((item) => item.binding.kind === "source");
  const sourceIds = [...new Set(sourceInputs.map((item) => {
    if (item.binding.kind !== "source") throw new Error("Unexpected Vard binding");
    return item.binding.assetId;
  }))];
  const sources = sourceIds.length ? await tx.select({ id: asset.id }).from(asset)
    .where(and(eq(asset.workspaceId, workspaceId), inArray(asset.id, sourceIds))) : [];
  if (sources.length !== sourceIds.length)
    throw new VardEditorV2Error(400, "Asset does not belong to workspace");
  const pinned = sourceInputs.flatMap((item) => item.binding.kind === "source" &&
    item.binding.versionId !== null ? [{ item, binding: item.binding }] : []);
  if (pinned.length) {
    const versions = await tx.select({
      id: assetVersion.id, assetId: assetVersion.assetId, status: assetVersion.status,
    }).from(assetVersion).where(and(eq(assetVersion.workspaceId, workspaceId),
      inArray(assetVersion.id, pinned.map(({ binding }) => binding.versionId!))));
    const byId = new Map(versions.map((version) => [version.id, version]));
    if (pinned.some(({ item, binding }) => {
      const version = byId.get(binding.versionId!);
      const old = item.id === null ? undefined : persisted.get(item.id);
      const retainedPin = old?.assetUseId === null && old.assetId === binding.assetId &&
        old.versionId === binding.versionId;
      return version?.assetId !== binding.assetId || (!retainedPin && version.status !== "ready");
    })) throw new VardEditorV2Error(400, "Pinned version must be ready and belong to its asset");
  }

  const useIds = [...new Set(items.flatMap((item) =>
    item.binding.kind === "use" ? [item.binding.assetUseId] : []))];
  const uses = useIds.length ? await useRows(tx, workspaceId).where(and(
    eq(assetUse.workspaceId, workspaceId), inArray(assetUse.id, useIds),
  )) : [];
  const byUseId = new Map(uses.map((use) => [use.id, use]));
  return items.map((item): { id: string | null } & LiteralItemV2 => {
    if (item.binding.kind === "source") return {
      id: item.id, outputPath: item.outputPath, assetUseId: null,
      assetId: item.binding.assetId, versionId: item.binding.versionId,
      transformation: item.binding.transformation, writable: item.binding.writable,
    };
    const use = byUseId.get(item.binding.assetUseId);
    if (!use) throw new VardEditorV2Error(400, "Linked use does not belong to workspace");
    const old = item.id === null ? undefined : persisted.get(item.id);
    const retainedUse = old?.assetUseId === use.id && old.assetId === use.sourceAssetId;
    if (!retainedUse && (!use.currentVersionId || useIssue(use)))
      throw new VardEditorV2Error(409, "Select a linked use with a usable ready current source", undefined,
        "linked_use_unavailable");
    return { id: item.id, outputPath: item.outputPath, assetUseId: use.id,
      assetId: use.sourceAssetId, versionId: null, transformation: null, writable: false };
  });
}

function literalItemFields(item: LiteralItemV2): LiteralItemV2 {
  return { assetId: item.assetId, assetUseId: item.assetUseId, versionId: item.versionId,
    outputPath: item.outputPath, transformation: item.transformation, writable: item.writable };
}

/** The route must already hold the workspace content guard on this transaction. */
export async function replaceEditorItemsV2(
  tx: Transaction, workspaceId: string, vardId: string,
  body: z.infer<typeof v2ItemsBody>, principal: EditorPrincipal, requestId: string,
) {
  const state = await editableStateV2(tx, workspaceId, vardId);
  compareRevisionV2(state.revision, body.expectedRevision);
  const byId = new Map(state.items.map((item) => [item.id, item]));
  const retainedIds = new Set<string>();
  const paths = new Set<string>();
  for (const item of body.items) {
    if (item.id !== null) {
      if (retainedIds.has(item.id)) throw new VardEditorV2Error(400, "Duplicate manual item ID");
      if (!byId.has(item.id)) throw new VardEditorV2Error(400, "Manual item ID does not belong to this Vard");
      retainedIds.add(item.id);
    }
    const path = item.outputPath.normalize("NFC").toLowerCase();
    if (paths.has(path)) throw new VardEditorV2Error(400, `Duplicate output path: ${path}`);
    paths.add(path);
  }
  const desired = await validateItemsV2(tx, workspaceId, body.items, byId);
  const changed = desired.filter((item) => item.id === null ||
    canonicalDefinition(literalItemFields(item)) !==
      canonicalDefinition(literalItemFields(byId.get(item.id)!)));
  const removed = state.items.filter((item) => !retainedIds.has(item.id));
  if (changed.length || removed.length) {
    const definitionSchema = desired.some((item) => item.assetUseId !== null)
      ? 2 : state.record.definitionSchema;
    // The composite parent FK upgrades every old child before any bound insert.
    if (definitionSchema !== state.record.definitionSchema)
      await tx.update(vard).set({ definitionSchema })
        .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
    const moved = changed.filter((item) => item.id !== null &&
      byId.get(item.id)!.outputPath !== item.outputPath);
    const deleteIds = [...removed.map((item) => item.id), ...moved.map((item) => item.id!)];
    if (deleteIds.length) await tx.delete(vardItem).where(and(
      eq(vardItem.workspaceId, workspaceId), eq(vardItem.vardId, vardId), inArray(vardItem.id, deleteIds),
    ));
    const now = new Date();
    for (const item of changed) {
      const old = item.id === null ? undefined : byId.get(item.id)!;
      const fields = { ...literalItemFields(item), definitionSchema,
        updatedAt: now, updatedBy: principal.reference };
      if (!old || old.outputPath !== item.outputPath) await tx.insert(vardItem).values({
        ...fields, id: old?.id ?? randomUUID(), workspaceId, vardId,
        createdBy: old?.createdBy ?? principal.reference,
        ...(old ? { createdAt: sql`${old.createdAtText}::timestamptz` } : {}),
      });
      else await tx.update(vardItem).set(fields).where(and(
        eq(vardItem.workspaceId, workspaceId), eq(vardItem.vardId, vardId), eq(vardItem.id, old.id),
      ));
    }
    await tx.update(vard).set({ updatedAt: now, updatedBy: principal.reference })
      .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
    await tx.insert(auditEvent).values({ workspaceId,
      actorType: principal.actorType, actorId: principal.actorId,
      action: "vard.items_updated", targetType: "vard", targetId: vardId,
      metadata: { itemCount: desired.length }, requestId,
    });
  }
  return editorPayloadV2(tx, workspaceId, vardId);
}

/** The route must already hold the workspace content guard on this transaction. */
export async function deleteEditorV2(
  tx: Transaction, workspaceId: string, vardId: string,
  expectedRevision: string, principal: EditorPrincipal, requestId: string,
) {
  const state = await editableStateV2(tx, workspaceId, vardId);
  compareRevisionV2(state.revision, expectedRevision);
  await tx.delete(vard).where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
  await tx.insert(auditEvent).values({ workspaceId,
    actorType: principal.actorType, actorId: principal.actorId,
    action: "vard.deleted", targetType: "vard", targetId: vardId,
    metadata: { name: state.record.name }, requestId,
  });
}
