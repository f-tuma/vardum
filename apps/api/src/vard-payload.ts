import { and, asc, eq, inArray } from "drizzle-orm";
import { asset, assetUse, assetVersion, vard, vardItem, workspace, type VardTransformation } from "./db/app-schema.js";
import { inWorkspaceSnapshot, type Transaction } from "./db/tenant.js";
import { useCompatibilityIssue } from "./asset-use-model.js";
import { useIssue, useRows } from "./asset-use-query.js";
import { canonicalizeTransformation, transformedVersionUrl } from "./transformation.js";
import { resolveFolderMembership } from "./vard-folder-rules.js";
import { loadFolderMembers } from "./vard-folder-members.js";

export type VardPayloadOptions = {
  anonymous?: boolean;
  requirePublic?: boolean;
  resolveFolders?: boolean;
  includePinnedVersionId?: boolean;
  /** Internal inventory identity; never part of the consumer manifest. */
  includeBindingIdentity?: true;
  /** Authenticated editor details; never part of the consumer manifest. */
  includeEditorDiagnostics?: true;
  selectedTargets?: ReadonlyArray<{ assetId: string; outputPath: string }>;
};

export async function buildVardPayload(
  workspaceId: string,
  vardId: string,
  {
    anonymous = false,
    requirePublic = false,
    resolveFolders = true,
  }: Pick<VardPayloadOptions, "anonymous" | "requirePublic" | "resolveFolders"> = {},
) {
  return inWorkspaceSnapshot(workspaceId, (transaction) =>
    buildVardPayloadInTransaction(transaction, workspaceId, vardId, { anonymous, requirePublic, resolveFolders }),
  );
}

export async function buildVardPayloadInTransaction(
  transaction: Transaction,
  workspaceId: string,
  vardId: string,
  { anonymous = false, requirePublic = false, resolveFolders = true,
    includePinnedVersionId = false, includeBindingIdentity, includeEditorDiagnostics,
    selectedTargets }: VardPayloadOptions = {},
) {
  const [record] = await transaction
    .select({
      id: vard.id,
      name: vard.name,
      isPublic: vard.isPublic,
      folderRules: vard.folderRules,
      updatedAt: vard.updatedAt,
      workspaceSlug: workspace.slug,
    })
    .from(vard)
    .innerJoin(workspace, eq(workspace.id, vard.workspaceId))
    .where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
  if (!record || (requirePublic && !record.isPublic)) return null;

  const manual = await transaction
    .select({
      id: vardItem.id,
      assetId: vardItem.assetId,
      assetUseId: vardItem.assetUseId,
      isPublic: asset.isPublic,
      key: asset.key,
      outputPath: vardItem.outputPath,
      transformation: vardItem.transformation,
      writable: vardItem.writable,
      pinnedVersionId: vardItem.versionId,
      currentVersionId: asset.currentVersionId,
    })
    .from(vardItem)
    .innerJoin(asset, and(eq(asset.workspaceId, workspaceId), eq(asset.id, vardItem.assetId)))
    .where(and(eq(vardItem.workspaceId, workspaceId), eq(vardItem.vardId, vardId)))
    .orderBy(asc(vardItem.outputPath));
  if (anonymous && manual.some((item) => !item.isPublic)) return null;
  let items = manual;
  if (resolveFolders) {
    // Fetch both complete privacy aggregates before namespace/overflow errors.
    const members = await loadFolderMembers(transaction, workspaceId, record.folderRules);
    if (anonymous && members.hasPrivateMember) return null;
    const membership = resolveFolderMembership(manual.map((item) => ({ ...item,
      bindingKind: item.assetUseId ? "use" as const : "source" as const,
    })), members.sources, members.uses, record.folderRules);
    const manualById = new Map(manual.map((item) => [item.id, item]));
    const sourceById = new Map(members.sources.map((source) => [source.assetId, source]));
    const useById = new Map(members.uses.map((use) => [use.assetUseId, use]));
    items = membership.map((item) => {
      const literal = manualById.get(item.id);
      if (literal) return literal;
      const source = sourceById.get(item.assetId);
      const use = item.assetUseId ? useById.get(item.assetUseId) : undefined;
      const canonical = use ?? source;
      if (!canonical) throw new Error("Generated Vard member lost its canonical source");
      return { id: item.id, assetId: item.assetId, assetUseId: item.assetUseId,
        isPublic: canonical.isPublic, key: use ? use.sourceKey : source!.key,
        outputPath: item.outputPath, transformation: null, writable: false,
        pinnedVersionId: null, currentVersionId: canonical.currentVersionId };
    });
    items.sort((a, b) =>
      a.outputPath < b.outputPath ? -1 : a.outputPath > b.outputPath ? 1 : 0,
    );
  }
  // Validate the whole output namespace before projection. An unrelated
  // collision/overflow still invalidates selected inventory outputs, while
  // unselected versions and delivery payloads need no hydration.
  const selections = selectedTargets
    ? new Set(selectedTargets.map((target) =>
        JSON.stringify([target.assetId, target.outputPath]),
      ))
    : null;
  const selectedItems = selections
    ? items.filter((item) =>
        selections.has(JSON.stringify([item.assetId, item.outputPath])),
      )
    : items;
  // Start from the literal rows, then look up only their selected use IDs.
  // Missing joins retain their output and resolve unavailable, never Original.
  const useIds = [...new Set(selectedItems.flatMap((item) => item.assetUseId ? [item.assetUseId] : []))];
  const uses = useIds.length
    ? await useRows(transaction, workspaceId).where(and(
        eq(assetUse.workspaceId, workspaceId), inArray(assetUse.id, useIds),
      ))
    : [];
  const useById = new Map(uses.map((use) => [use.id, use]));
  const versionIds = [
    ...new Set(
      selectedItems
        .map((item) => item.pinnedVersionId ?? item.currentVersionId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const versions = versionIds.length
    ? await transaction
        .select({
          id: assetVersion.id,
          assetId: assetVersion.assetId,
          status: assetVersion.status,
          checksum: assetVersion.checksum,
          mimeType: assetVersion.mimeType,
          size: assetVersion.size,
          width: assetVersion.width,
          height: assetVersion.height,
        })
        .from(assetVersion)
        .where(
          and(
            eq(assetVersion.workspaceId, workspaceId),
            inArray(assetVersion.id, versionIds),
          ),
        )
    : [];
  const byId = new Map(versions.map((version) => [version.id, version]));

  return {
    schema: 1 as const,
    id: record.id,
    workspaceId,
    name: record.name,
    isPublic: record.isPublic,
    updatedAt: record.updatedAt,
    ...(resolveFolders ? {} : { folderRules: record.folderRules }),
    items: selectedItems.map((item) => {
      const versionId = item.pinnedVersionId ?? item.currentVersionId;
      const version = versionId ? byId.get(versionId) : undefined;
      const use = item.assetUseId ? useById.get(item.assetUseId) : undefined;
      const linkedUse = use?.sourceAssetId === item.assetId ? use : undefined;
      const transformation = item.assetUseId
        ? linkedUse?.transformation ?? null
        : item.transformation ?? null;
      const ready = version?.status === "ready" && version.assetId === item.assetId;
      const availabilityError = item.assetUseId
        ? !linkedUse
          ? "The linked library use is unavailable"
          : useIssue(linkedUse) ?? useCompatibilityIssue(
              item.outputPath, linkedUse.outputMimeType,
              ready ? version.mimeType : null, transformation,
              { width: version?.width ?? null, height: version?.height ?? null },
            )
        : ready ? null : "The source has no ready selected version";
      const available = ready && (!item.assetUseId || !availabilityError);
      const encodedKey = item.key
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return {
        id: item.id,
        assetId: item.assetId,
        key: item.key,
        outputPath: item.outputPath,
        writable: item.assetUseId ? false : item.writable,
        pinned: item.assetUseId ? false : Boolean(item.pinnedVersionId),
        ...(includePinnedVersionId ? { pinnedVersionId: item.assetUseId ? null : item.pinnedVersionId } : {}),
        ...(includeBindingIdentity ? { bindingIdentity: item.assetUseId
          ? { kind: "use" as const, assetUseId: item.assetUseId }
          : { kind: "source" as const } } : {}),
        ...(includeEditorDiagnostics && !anonymous ? {
          availabilityError,
          linkedUse: linkedUse ? {
            id: linkedUse.id, key: linkedUse.key, displayName: linkedUse.displayName,
            revision: linkedUse.revision, sourceDisplayName: linkedUse.sourceDisplayName,
            sourceProcessing: linkedUse.sourceProcessing,
          } : null,
        } : {}),
        transformation,
        versionId: available ? version.id : null,
        sourceChecksum: available ? version.checksum : null,
        sourceMimeType: version?.mimeType ?? null,
        mimeType: item.assetUseId ? linkedUse?.outputMimeType ?? null : outputMimeType(version?.mimeType ?? null, transformation),
        size: item.assetUseId && !available ? null : transformation ? null : (version?.size ?? null),
        fingerprint:
          available
            ? `${version.id}:${canonicalizeTransformation(transformation ?? {})}`
            : null,
        downloadUrl:
          available
            ? transformation
              ? transformedVersionUrl(
                  record.workspaceSlug,
                  item.key,
                  version.id,
                  transformation,
                )
              : `/w/${encodeURIComponent(record.workspaceSlug)}/__v/${encodeURIComponent(version.id)}/${encodedKey}`
            : null,
      };
    }),
  };
}

function outputMimeType(
  source: string | null,
  transformation: VardTransformation | null,
) {
  if (!transformation?.format)
    return transformation && source === "image/svg+xml" ? "image/png" : source;
  if (transformation.format === "svg") return "image/svg+xml";
  return transformation.format === "jpeg"
    ? "image/jpeg"
    : `image/${transformation.format}`;
}
