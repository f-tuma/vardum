import { supportedMimeTypes, type VardFolderRuleV2 } from "@vardum/shared";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { assetKey } from "./asset-key.js";
import { authorizeAsset, type AssetAction } from "./authorization.js";
import { asset, assetVersion, auditEvent, vard, vardItem } from "./db/app-schema.js";
import { conflictsWithUse } from "./asset-use-namespace.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import { inWorkspace, type Transaction } from "./db/tenant.js";
import { maximumUploadSize } from "./upload-limits.js";
import { MAX_VARD_OUTPUTS, validateResolvedOutputs, vardOutputPath, resolveFolderMembership,
  VardResolutionError, type FolderMembershipItem, type FolderSourceCandidate,
  type FolderUseCandidate } from "./vard-folder-rules.js";
import { loadFolderMembers } from "./vard-folder-members.js";

export const vardImportFile = z.object({
  assetId: z.uuid().transform((value) => value.toLowerCase()),
  key: assetKey,
  outputPath: vardOutputPath,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.enum(supportedMimeTypes),
  size: z.number().int().positive(),
}).strict().refine(({ mimeType, size }) => size <= maximumUploadSize(mimeType), {
  message: "File is larger than the upload limit for its type", path: ["size"],
});
export const vardImportPlanBody = z.object({
  files: z.array(vardImportFile).min(1).max(MAX_VARD_OUTPUTS),
}).strict();
export const vardImportBody = z.object({
  files: z.array(vardImportFile.safeExtend({
    versionId: z.uuid().transform((value) => value.toLowerCase()),
  })).min(1).max(MAX_VARD_OUTPUTS),
}).strict();
type ImportFile = z.infer<typeof vardImportFile>;
type Source = FolderSourceCandidate;
type Mapping = FolderMembershipItem;
type Rule = VardFolderRuleV2;

/** Existing manual rows and generated outputs must form one valid union. */
export function resolveImportOutputs(
  manual: Mapping[], sources: Source[], rules: Rule[], uses: FolderUseCandidate[] = [],
) {
  return new Map(resolveFolderMembership(manual, sources, uses, rules)
    .map((item) => [item.outputPath, item]));
}

/** Validate the full prospective union before admitting any additions. */
export function importMappings(
  manual: Mapping[], sources: Source[], rules: Rule[], files: ImportFile[], uses: FolderUseCandidate[] = [],
) {
  const resolved = resolveImportOutputs(manual, sources, rules, uses);
  const mappings = files.map((file) => {
    const existing = resolved.get(file.outputPath);
    if (existing) {
      if (existing.bindingKind === "use")
        throw new VardResolutionError("Linked uses are read-only upload destinations; select the source asset instead");
      if (existing.assetId !== file.assetId)
        throw new VardResolutionError("Import output path belongs to another asset");
      return { mappingAction: "keep" as const, mappingId: existing.id };
    }
    resolved.set(file.outputPath, { id: "", assetId: file.assetId, outputPath: file.outputPath,
      bindingKind: "source", assetUseId: null });
    return { mappingAction: "add" as const, mappingId: null };
  });
  // Validate the whole union once, including spelling and file/directory collisions.
  validateResolvedOutputs([...resolved.keys()]);
  return mappings;
}

async function importContext(tx: Transaction, workspaceId: string, vardId: string) {
  const [target] = await tx.select({ folderRules: vard.folderRules, definitionSchema: vard.definitionSchema }).from(vard)
    .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
  if (!target) return null;
  const rows = await tx.select({ id: vardItem.id, assetId: vardItem.assetId, outputPath: vardItem.outputPath,
    assetUseId: vardItem.assetUseId })
    .from(vardItem).where(and(eq(vardItem.workspaceId, workspaceId), eq(vardItem.vardId, vardId)))
    .orderBy(asc(vardItem.outputPath)).limit(MAX_VARD_OUTPUTS + 1);
  const manual: Mapping[] = rows.map((row) => ({ ...row, bindingKind: row.assetUseId ? "use" : "source" }));
  const members = await loadFolderMembers(tx, workspaceId, target.folderRules);
  // Current invalid definitions must be repaired through the editor endpoints.
  resolveImportOutputs(manual, members.sources, target.folderRules, members.uses);
  return { ...target, manual, sources: members.sources, uses: members.uses };
}

export function assertImportIdentities(files: ImportFile[]) {
  if (new Set(files.map((file) => file.assetId)).size !== files.length ||
      new Set(files.map((file) => file.key)).size !== files.length)
    throw new VardResolutionError("Import files must have distinct asset identities and keys");
}

function projectSources(sources: Source[], files: ImportFile[]) {
  const projected = new Map(sources.map((source) => [source.assetId, source]));
  for (const file of files) projected.set(file.assetId, file);
  return [...projected.values()];
}

export function registerVardImportRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ workspaceId: z.string().min(1), vardId: z.uuid() });
  api.post("/api/workspaces/:workspaceId/vards/:vardId/items/import-plan", {
    schema: { params, body: vardImportPlanBody },
  }, async (request, reply) => {
    const { workspaceId, vardId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read", "update"]);
    if (!("principal" in authorization))
      return reply.code(authorization.statusCode).send({ error: authorization.error });
    try {
      const result = await inWorkspace(workspaceId, async (tx) => {
        await lockWorkspaceContent(tx, workspaceId);
        assertImportIdentities(request.body.files);
        for (const file of request.body.files)
          if (await conflictsWithUse(tx, workspaceId, file.key))
            throw new VardResolutionError("Linked uses are read-only upload destinations; select the source asset instead");
        const context = await importContext(tx, workspaceId, vardId);
        if (!context) return null;
        const rows = await tx.select({
          id: asset.id, key: asset.key, currentVersionId: asset.currentVersionId, archivedAt: asset.archivedAt,
          versionId: assetVersion.id, status: assetVersion.status, checksum: assetVersion.checksum,
          mimeType: assetVersion.mimeType, size: assetVersion.size,
          unfinished: sql<boolean>`exists (select 1 from ${assetVersion} av where av.asset_id = ${asset.id}
            and av.workspace_id = ${workspaceId} and (av.status in ('pending', 'processing')
            or (av.status = 'failed' and av.retryable)))`,
        }).from(asset).leftJoin(assetVersion, and(eq(assetVersion.id, asset.currentVersionId),
          eq(assetVersion.assetId, asset.id), eq(assetVersion.workspaceId, workspaceId))).where(and(
          eq(asset.workspaceId, workspaceId),
          or(inArray(asset.id, request.body.files.map((file) => file.assetId)),
            inArray(asset.key, request.body.files.map((file) => file.key))),
        ));
        const byId = new Map(rows.map((row) => [row.id, row]));
        const byKey = new Map(rows.map((row) => [row.key, row]));
        const mappings = importMappings(context.manual, projectSources(context.sources, request.body.files),
          context.folderRules, request.body.files, context.uses);
        return { files: request.body.files.map((file, index) => {
          const existing = byId.get(file.assetId);
          if ((existing && existing.key !== file.key) || (byKey.get(file.key)?.id ?? file.assetId) !== file.assetId)
            throw new VardResolutionError("Asset identity or key changed since the folder plan");
          const ready = existing?.status === "ready";
          const skip = ready && !existing.unfinished && existing.checksum === file.checksum &&
            existing.mimeType === file.mimeType && existing.size === file.size;
          if (existing?.archivedAt && !skip)
            throw new VardResolutionError("Asset is archived; unarchive it before importing changes");
          return { ...file, versionId: ready ? existing.versionId : null,
            libraryAction: existing ? (skip ? "skip" as const : "update" as const) : "new" as const,
            ...mappings[index]! };
        }) };
      });
      if (!result) return reply.code(404).send({ error: "Vard not found" });
      // Complete preflight permissions before the caller can begin uploads. No domain writes occur.
      const actions: AssetAction[] = [];
      if (result.files.some((file) => file.libraryAction === "new")) actions.push("create");
      if (result.files.some((file) => file.libraryAction !== "skip")) actions.push("publish");
      if (actions.length) {
        const additional = await authorizeAsset(request, workspaceId, actions);
        if (!("principal" in additional))
          return reply.code(additional.statusCode).send({ error: additional.error });
      }
      return result;
    } catch (error) {
      if (error instanceof VardResolutionError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  api.post("/api/workspaces/:workspaceId/vards/:vardId/items/import", {
    schema: { params, body: vardImportBody },
  }, async (request, reply) => {
    const { workspaceId, vardId } = request.params;
    const authorization = await authorizeAsset(request, workspaceId, ["read", "update"]);
    if (!("principal" in authorization))
      return reply.code(authorization.statusCode).send({ error: authorization.error });
    try {
      const result = await inWorkspace(workspaceId, async (tx) => {
        await lockWorkspaceContent(tx, workspaceId);
        assertImportIdentities(request.body.files);
        for (const file of request.body.files)
          if (await conflictsWithUse(tx, workspaceId, file.key))
            throw new VardResolutionError("Linked uses are read-only upload destinations; select the source asset instead");
        const context = await importContext(tx, workspaceId, vardId);
        if (!context) return null;
        // Refuse use destinations before any source identity/checksum shortcut.
        const mappings = importMappings(context.manual, context.sources, context.folderRules,
          request.body.files, context.uses);
        const rows = await tx.select({
          assetId: asset.id, key: asset.key, versionId: assetVersion.id,
          checksum: assetVersion.checksum, mimeType: assetVersion.mimeType, size: assetVersion.size,
        }).from(asset).innerJoin(assetVersion, eq(assetVersion.id, asset.currentVersionId)).where(and(
          eq(asset.workspaceId, workspaceId), eq(assetVersion.workspaceId, workspaceId),
          eq(assetVersion.assetId, asset.id), eq(assetVersion.status, "ready"),
          inArray(asset.id, request.body.files.map((file) => file.assetId)),
        ));
        const byId = new Map(rows.map((row) => [row.assetId, row]));
        for (const file of request.body.files) {
          const current = byId.get(file.assetId);
          if (!current || current.key !== file.key || current.versionId !== file.versionId ||
              current.checksum !== file.checksum || current.mimeType !== file.mimeType || current.size !== file.size)
            throw new VardResolutionError("Asset must still belong to the workspace with the exact current ready source from the import");
        }
        const additions = request.body.files.filter((_file, index) => mappings[index]!.mappingAction === "add");
        const inserted = additions.length ? await tx.insert(vardItem).values(additions.map((file) => ({
          workspaceId, vardId, assetId: file.assetId, outputPath: file.outputPath,
          definitionSchema: context.definitionSchema,
          versionId: null, transformation: null, writable: false,
          createdBy: authorization.principal.reference, updatedBy: authorization.principal.reference,
        }))).returning({ id: vardItem.id, outputPath: vardItem.outputPath }) : [];
        const insertedIds = new Map(inserted.map((item) => [item.outputPath, item.id]));
        if (inserted.length) {
          await tx.update(vard).set({ updatedAt: new Date(), updatedBy: authorization.principal.reference })
            .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
          await tx.insert(auditEvent).values({
            workspaceId, actorType: authorization.principal.actorType, actorId: authorization.principal.actorId,
            action: "vard.items_imported", targetType: "vard", targetId: vardId,
            metadata: { added: inserted.length, assetIds: additions.map((file) => file.assetId) }, requestId: request.id,
          });
        }
        return { files: request.body.files.map((file, index) => ({
          assetId: file.assetId, key: file.key, outputPath: file.outputPath,
          mappingId: mappings[index]!.mappingId ?? insertedIds.get(file.outputPath)!,
          mappingAction: mappings[index]!.mappingAction === "add" ? "added" as const : "kept" as const,
        })), added: inserted.length, kept: request.body.files.length - inserted.length };
      });
      return result ?? reply.code(404).send({ error: "Vard not found" });
    } catch (error) {
      if (error instanceof VardResolutionError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
