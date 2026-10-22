import type { QueryClient } from "@tanstack/react-query";
import type { VardDefinition, VardEditorDefinition, VardEditorItemInput, VardItem, VardManifest, VardEditorDefinitionV2, VardEditorItemInputV2 } from "@vardum/shared";
import type { VardMetadata } from "./asset-api";

export type DraftItem = Pick<
  VardItem,
  | "id"
  | "assetId"
  | "key"
  | "outputPath"
  | "versionId"
  | "transformation"
  | "writable"
>;

// Only configuration may seed editable rows; a resolved manifest is never input.
export function manualDraftItems(definition: VardDefinition): DraftItem[] {
  return definition.items.map((item) => ({
    id: item.id,
    assetId: item.assetId,
    key: item.key,
    outputPath: item.outputPath,
    versionId: item.pinnedVersionId !== undefined ? item.pinnedVersionId : item.pinned ? item.versionId : null,
    transformation: item.transformation ? { ...item.transformation } : null,
    writable: item.writable,
  }));
}

// PATCH returns metadata, not items. Preserve the manual rows and their IDs.
export function applyVardMetadata(
  definition: VardDefinition,
  metadata: VardMetadata,
): VardDefinition {
  return { ...definition, ...metadata, items: definition.items };
}

export async function refreshVardPreview(
  queryClient: QueryClient,
  workspaceId: string,
  vardId: string,
) {
  const queryKey = ["vard-preview", workspaceId, vardId];
  // Invalidation alone reuses an initial in-flight request with no cached data.
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

export function generatedOutputs(preview: VardManifest): VardItem[] {
  // Manual IDs can change independently of this cached preview after a save.
  return preview.items.filter(({ id }) => id.startsWith("folder:"));
}

export type VardItemBaseline = {
  definition: VardEditorDefinition;
  items: DraftItem[];
};

// Capture once at the start of a draft; background query data is never its baseline.
export function captureVardBaseline(definition: VardEditorDefinition): VardItemBaseline {
  const captured = {
    ...definition,
    folderRules: definition.folderRules.map((rule) => ({ ...rule })),
    items: definition.items.map((item) => ({
      ...item,
      pinnedVersionId: item.pinnedVersionId ?? null,
      transformation: item.transformation ? { ...item.transformation } : null,
    })),
  };
  return { definition: captured, items: manualDraftItems(captured) };
}

export function vardItemInputs(items: DraftItem[], existingIds: Set<string>): VardEditorItemInput[] {
  return items.map(({ id, assetId, versionId, outputPath, transformation, writable }) => ({
    id: existingIds.has(id) ? id : null,
    assetId,
    versionId,
    outputPath,
    transformation,
    writable,
  }));
}

export type DraftItemV2 = { id: string; key: string; outputPath: string; binding: VardEditorItemInputV2["binding"] };
export type VardItemBaselineV2 = { definition: VardEditorDefinitionV2; items: DraftItemV2[] };

export function manualDraftItemsV2(definition: VardEditorDefinitionV2): DraftItemV2[] {
  return definition.items.map(({ id, outputPath, binding, linkedUse, resolved }) => ({
    id, outputPath, key: binding.kind === "use" ? linkedUse?.key ?? resolved.key : resolved.key,
    binding: binding.kind === "use" ? { kind: "use", assetUseId: binding.assetUseId }
      : { ...binding, transformation: binding.transformation ? { ...binding.transformation } : null },
  }));
}

export function captureVardBaselineV2(definition: VardEditorDefinitionV2): VardItemBaselineV2 {
  const captured: VardEditorDefinitionV2 = {
    ...definition, folderRules: definition.folderRules.map((rule) => ({ ...rule })),
    items: definition.items.map((item) => ({
      ...item,
      binding: item.binding.kind === "use" ? { ...item.binding } : { ...item.binding, transformation: item.binding.transformation ? { ...item.binding.transformation } : null },
      resolved: { ...item.resolved, transformation: item.resolved.transformation ? { ...item.resolved.transformation } : null },
      linkedUse: item.linkedUse ? { ...item.linkedUse } : null,
    })),
  };
  return { definition: captured, items: manualDraftItemsV2(captured) };
}

export function vardItemInputsV2(items: DraftItemV2[], existingIds: Set<string>): VardEditorItemInputV2[] {
  return items.map(({ id, outputPath, binding }) => ({
    id: existingIds.has(id) ? id : null, outputPath,
    binding: binding.kind === "use" ? { kind: "use", assetUseId: binding.assetUseId }
      : { ...binding, transformation: binding.transformation ? { ...binding.transformation } : null },
  }));
}

export function canReturnToSourceOnly(definition: VardEditorDefinitionV2) {
  return [2, 3].includes(definition.storedDefinitionSchema)
    && definition.items.every(({ binding }) => binding.kind === "source")
    && definition.folderRules.every((rule) => rule.includeUses !== true);
}
