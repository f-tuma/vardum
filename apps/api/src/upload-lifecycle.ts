import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { config } from "./config.js";
import { assetVersion, auditEvent, workspace } from "./db/app-schema.js";
import { db } from "./db/index.js";
import { inWorkspace, type Transaction } from "./db/tenant.js";
import { CapacityError } from "./resource-budget.js";
import { deleteObjects } from "./storage.js";

export const uploadDeadline = (createdAt: Date) =>
  new Date(createdAt.getTime() + config.UPLOAD_PENDING_HOURS * 3600_000);

export async function workspaceUsage(tx: Transaction, workspaceId: string) {
  const [usage] = await tx
    .select({
      reservedBytes:
        sql<number>`coalesce(sum(${assetVersion.size}) FILTER (WHERE ${assetVersion.uploadCleanedAt} IS NULL), 0)`.mapWith(
          Number,
        ),
      pending:
        sql<number>`count(*) FILTER (WHERE ${assetVersion.status} IN ('pending', 'processing'))`.mapWith(
          Number,
        ),
    })
    .from(assetVersion)
    .where(eq(assetVersion.workspaceId, workspaceId));
  return {
    ...usage!,
    limitBytes: config.WORKSPACE_STORAGE_MB * 1024 ** 2,
    pendingLimit: config.WORKSPACE_PENDING_UPLOADS,
  };
}

// Serialize reservation admission per workspace across API replicas. Call before
// taking asset/version locks; commit the reservation in this same transaction.
export async function lockWorkspaceBudget(
  tx: Transaction,
  workspaceId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(74120, hashtext(${workspaceId}))`,
  );
}

export async function reserveUpload(
  tx: Transaction,
  workspaceId: string,
  size: number,
) {
  await lockWorkspaceBudget(tx, workspaceId);
  const usage = await workspaceUsage(tx, workspaceId);
  if (size > 0 && usage.reservedBytes + size > usage.limitBytes)
    throw new CapacityError(
      "Workspace storage limit reached. Delete unused assets or ask the administrator to raise the limit.",
      413,
    );
  if (usage.pending >= usage.pendingLimit)
    throw new CapacityError(
      "Too many unfinished uploads. Finish existing uploads or wait for expired uploads to be cleaned up.",
      429,
    );
}

export async function expirePending(
  tx: Transaction,
  versionId: string,
  now = new Date(),
) {
  const [version] = await tx
    .update(assetVersion)
    .set({
      status: "failed",
      retryable: false,
      uploadExpiredAt: now,
      error: "Upload expired before it was finalized. Upload a new file.",
      updatedBy: "system:upload-cleanup",
    })
    .where(
      and(
        eq(assetVersion.id, versionId),
        eq(assetVersion.status, "pending"),
        lt(
          assetVersion.createdAt,
          new Date(now.getTime() - config.UPLOAD_PENDING_HOURS * 3600_000),
        ),
      ),
    )
    .returning({
      workspaceId: assetVersion.workspaceId,
      assetId: assetVersion.assetId,
      number: assetVersion.number,
    });
  if (!version) return false;
  await tx.insert(auditEvent).values({
    workspaceId: version.workspaceId,
    actorType: "system",
    actorId: "upload-cleanup",
    action: "asset.upload_expired",
    targetType: "asset_version",
    targetId: versionId,
    metadata: { assetId: version.assetId, number: version.number },
    requestId: `upload-cleanup:${versionId}`,
  });
  return true;
}

export async function cleanupPendingUploads(now = new Date(), batch = 100) {
  let after: string | undefined;
  let cleaned = 0;
  let inspected = 0;
  let failure: unknown;
  // Bound work per invocation. Skip locked rows; finalize and expiry agree on
  // the terminal state before any object is deleted outside the transaction.
  while (inspected < batch) {
    const workspaces = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(after ? gt(workspace.id, after) : undefined)
      .orderBy(asc(workspace.id))
      .limit(100);
    for (const { id } of workspaces) {
      const versions = await inWorkspace(id, async (tx) => {
        const rows = await tx
          .select({
            id: assetVersion.id,
            storageKey: assetVersion.storageKey,
            status: assetVersion.status,
          })
          .from(assetVersion)
          .where(
            or(
              and(
                eq(assetVersion.status, "pending"),
                lt(
                  assetVersion.createdAt,
                  new Date(
                    now.getTime() - config.UPLOAD_PENDING_HOURS * 3600_000,
                  ),
                ),
              ),
              and(
                isNotNull(assetVersion.uploadExpiredAt),
                or(
                  isNull(assetVersion.uploadSweepAt),
                  lt(
                    assetVersion.uploadSweepAt,
                    new Date(now.getTime() - 86400_000),
                  ),
                ),
              ),
            ),
          )
          .orderBy(asc(assetVersion.createdAt), asc(assetVersion.id))
          .limit(batch - inspected)
          .for("update", { skipLocked: true });
        for (const row of rows)
          if (row.status === "pending") await expirePending(tx, row.id, now);
        return rows;
      });
      for (const row of versions) {
        inspected++;
        try {
          await deleteObjects([row.storageKey]);
          await inWorkspace(id, (tx) =>
            tx
              .update(assetVersion)
              .set({ uploadCleanedAt: now, uploadSweepAt: now })
              .where(
                and(
                  eq(assetVersion.id, row.id),
                  isNotNull(assetVersion.uploadExpiredAt),
                  eq(assetVersion.status, "failed"),
                ),
              ),
          );
          cleaned++;
        } catch (error) {
          // Do not release quota on partial/provider failures. The next scheduled
          // run retries; tombstones are re-swept daily for late S3 upload completion.
          console.warn(
            JSON.stringify({
              event: "upload.cleanup_failed",
              versionId: row.id,
            }),
          );
          failure = error;
        }
      }
      if (inspected >= batch) break;
    }
    if (workspaces.length < 100) break;
    after = workspaces.at(-1)!.id;
  }
  if (failure) throw failure;
  return cleaned;
}
