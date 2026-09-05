import type { QueryClient } from "@tanstack/react-query";
import type { VardDefinition, VardItem, VardManifest } from "@vardum/shared";
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
    versionId: item.pinned ? item.versionId : null,
    transformation: item.transformation,
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
