import type { SyncAsset, VardItem } from "@vardum/shared";
import type { DraftItem } from "./vard-editor-state";

export function sourcePreview(
  item: DraftItem,
  workspaceSlug: string | undefined,
  source: SyncAsset | undefined,
  saved: VardItem | undefined,
) {
  const version = item.versionId ?? source?.versionId;
  const mimeType =
    item.versionId &&
    saved?.versionId === item.versionId
      ? saved.sourceMimeType ?? (saved.transformation ? undefined : saved.mimeType)
      : source?.mimeType;
  return {
    url:
      workspaceSlug && version
        ? `/w/${encodeURIComponent(workspaceSlug)}/__v/${encodeURIComponent(version)}/${item.key.split("/").map(encodeURIComponent).join("/")}`
        : null,
    mimeType,
  };
}
