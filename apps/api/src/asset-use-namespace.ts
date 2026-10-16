import { and, eq, sql } from "drizzle-orm";
import { assetUse } from "./db/app-schema.js";
import type { Transaction } from "./db/tenant.js";

/** Caller holds lockWorkspaceContent. Used by both source import preflights. */
export async function conflictsWithUse(tx: Transaction, workspaceId: string, key: string) {
  const [found] = await tx.select({ id: assetUse.id }).from(assetUse).where(and(
    eq(assetUse.workspaceId, workspaceId),
    sql`(${assetUse.key} = ${key} or starts_with(${assetUse.key}, ${key} || '/') or starts_with(${key}, ${assetUse.key} || '/'))`,
  )).limit(1);
  return Boolean(found);
}

export function namespaceConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("constraint" in error && error.constraint === "asset_use_namespace") return true;
  return "cause" in error && error.cause !== error && namespaceConflict(error.cause);
}
