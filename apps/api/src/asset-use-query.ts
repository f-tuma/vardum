import { and, eq } from "drizzle-orm";
import { asset, assetUse, assetVersion } from "./db/app-schema.js";
import type { Transaction } from "./db/tenant.js";
import { useCompatibilityIssue } from "./asset-use-model.js";

const useColumns = {
  id: assetUse.id, key: assetUse.key, displayName: assetUse.displayName,
  sourceAssetId: assetUse.sourceAssetId, transformation: assetUse.transformation,
  outputMimeType: assetUse.outputMimeType, revision: assetUse.revision, updatedAt: assetUse.updatedAt,
  sourceKey: asset.key, sourceDisplayName: asset.displayName, isPublic: asset.isPublic,
  currentVersionId: asset.currentVersionId, sourceMimeType: assetVersion.mimeType,
};

export function useRows(tx: Transaction, workspaceId: string) {
  return tx.select(useColumns).from(assetUse).innerJoin(asset, and(
    eq(asset.workspaceId, workspaceId), eq(asset.id, assetUse.sourceAssetId),
  )).leftJoin(assetVersion, and(
    eq(assetVersion.workspaceId, workspaceId), eq(assetVersion.assetId, asset.id),
    eq(assetVersion.id, asset.currentVersionId), eq(assetVersion.status, "ready"),
  )).where(eq(assetUse.workspaceId, workspaceId)).$dynamic();
}

export function useIssue(row: Pick<Awaited<ReturnType<typeof useRows>>[number], "key" | "outputMimeType" | "sourceMimeType" | "transformation">) {
  return useCompatibilityIssue(row.key, row.outputMimeType, row.sourceMimeType, row.transformation);
}

