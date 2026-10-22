import type { VardFolderRuleV2 } from "@vardum/shared";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { asset, assetUse, assetVersion } from "./db/app-schema.js";
import type { Transaction } from "./db/tenant.js";
import { MAX_VARD_OUTPUTS } from "./vard-folder-rules.js";

/** Bounded metadata only. Callers must check both privacy flags before expanding. */
export async function loadFolderMembers(
  tx: Transaction, workspaceId: string, rules: readonly VardFolderRuleV2[],
) {
  const sources = rules.length ? await tx.select({
    hasPrivateMember: sql<boolean>`bool_or(not ${asset.isPublic}) over ()`,
    assetId: asset.id, key: asset.key, isPublic: asset.isPublic,
    currentVersionId: asset.currentVersionId, mimeType: assetVersion.mimeType,
  }).from(asset).innerJoin(assetVersion, and(
    eq(assetVersion.id, asset.currentVersionId),
    eq(assetVersion.workspaceId, workspaceId), eq(assetVersion.assetId, asset.id),
    eq(assetVersion.status, "ready"),
  )).where(and(eq(asset.workspaceId, workspaceId),
    or(...rules.map((rule) => sql`starts_with(${asset.key}, ${rule.sourcePrefix})`)),
  )).orderBy(asc(asset.key), asc(asset.id)).limit(MAX_VARD_OUTPUTS + 1) : [];

  const useRules = rules.filter((rule) => rule.includeUses === true);
  const uses = useRules.length ? await tx.select({
    hasPrivateMember: sql<boolean>`bool_or(not ${asset.isPublic}) over ()`,
    assetUseId: assetUse.id, assetId: asset.id, key: assetUse.key,
    outputMimeType: assetUse.outputMimeType, sourceKey: asset.key,
    isPublic: asset.isPublic, currentVersionId: asset.currentVersionId,
    sourceMimeType: assetVersion.mimeType,
  }).from(assetUse).innerJoin(asset, and(
    eq(asset.workspaceId, workspaceId), eq(asset.id, assetUse.sourceAssetId),
  )).leftJoin(assetVersion, and(
    eq(assetVersion.workspaceId, workspaceId), eq(assetVersion.assetId, asset.id),
    eq(assetVersion.id, asset.currentVersionId), eq(assetVersion.status, "ready"),
  )).where(and(eq(assetUse.workspaceId, workspaceId),
    or(...useRules.map((rule) => sql`starts_with(${assetUse.key}, ${rule.sourcePrefix})`)),
  )).orderBy(asc(assetUse.key), asc(assetUse.id)).limit(MAX_VARD_OUTPUTS + 1) : [];

  // Window aggregates include matches beyond each LIMIT. Unready or incompatible
  // uses are members too, so neither readiness nor availability filters this set.
  return { sources, uses,
    hasPrivateMember: Boolean(sources[0]?.hasPrivateMember || uses[0]?.hasPrivateMember) };
}
