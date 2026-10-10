import { sql } from "drizzle-orm";
import type { Transaction } from "./tenant.js";

/**
 * Serialize source namespace/current state and Vard membership per workspace.
 * Acquire after the upload budget guard, when needed, and before any row locks.
 * Keep object storage/network work outside the guarded transaction.
 */
export async function lockWorkspaceContent(tx: Transaction, workspaceId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(74122, hashtext(${workspaceId}))`,
  );
}
