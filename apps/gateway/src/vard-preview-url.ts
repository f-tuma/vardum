import type { SyncAsset, VardItem, VardEditorItemV2 } from "@vardum/shared";
import type { DraftItem } from "./vard-editor-state";

export function transformedPreviewUrl(sourceUrl: string | null, signedUrl: string | undefined) {
  if (!sourceUrl || !signedUrl) return null;
  const query = new URL(signedUrl, "https://preview.invalid").search;
  return query ? `${sourceUrl}${query}` : null;
}

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

export function linkedPreview(item: VardEditorItemV2 | undefined) {
  const resolved = item?.binding.kind === "use" ? item.resolved : undefined;
  return {
    url: resolved && !resolved.availabilityError && resolved.versionId && resolved.fingerprint
      ? resolved.downloadUrl : null,
    mimeType: resolved?.mimeType ?? null,
  };
}
