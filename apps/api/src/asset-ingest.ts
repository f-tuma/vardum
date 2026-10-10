import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { assetVersion, workspace } from "./db/app-schema.js";
import { db } from "./db/index.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import { inWorkspace, type Transaction } from "./db/tenant.js";
import { failVersion, type AssetIngestPayload } from "./asset-processor.js";
import { assetIngestQueue, boss } from "./queue.js";

// The version and its durable job are committed together. A new job id fences
// off late workers and recovery scans from an earlier manual attempt.
export async function enqueueAssetIngest(
  transaction: Transaction,
  payload: AssetIngestPayload,
  actor: string,
) {
  const jobId = await boss.send(assetIngestQueue, payload, {
    id: randomUUID(),
    db: fromDrizzle(transaction, sql),
    singletonKey: payload.versionId,
  });
  if (!jobId) throw new Error("Asset processing is already queued");
  await transaction
    .update(assetVersion)
    .set({
      status: "processing",
      ingestJobId: jobId,
      ingestAttemptId: null,
      retryable: false,
      error: null,
      updatedBy: actor,
    })
    .where(eq(assetVersion.id, payload.versionId));
  return jobId;
}

export async function reconcileAssetIngest() {
  let workspaceAfter: string | undefined;
  let recovered = 0;
  while (true) {
    const workspaces = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(
        workspaceAfter === undefined
          ? undefined
          : gt(workspace.id, workspaceAfter),
      )
      .orderBy(asc(workspace.id))
      .limit(100);
    for (const { id: workspaceId } of workspaces) {
      let versionAfter: string | undefined;
      while (true) {
        const versions = await inWorkspace(workspaceId, (tx) =>
          tx
            .select({ id: assetVersion.id })
            .from(assetVersion)
            .where(
              and(
                eq(assetVersion.status, "processing"),
                versionAfter === undefined
                  ? undefined
                  : gt(assetVersion.id, versionAfter),
              ),
            )
            .orderBy(asc(assetVersion.id))
            .limit(100),
        );
        for (const { id: versionId } of versions) {
          // A short tenant-scoped transaction protects the scan from a concurrent
          // completion or retry. Queue reads share that connection and snapshot.
          const changed = await inWorkspace(workspaceId, async (tx) => {
            await lockWorkspaceContent(tx, workspaceId);
            const [version] = await tx
              .select()
              .from(assetVersion)
              .where(
                and(
                  eq(assetVersion.id, versionId),
                  eq(assetVersion.status, "processing"),
                ),
              )
              .for("update");
            if (!version) return false;
            const connection = { db: fromDrizzle(tx, sql) };
            const jobs = version.ingestJobId
              ? [
                  await boss.getJobById(
                    assetIngestQueue,
                    version.ingestJobId,
                    connection,
                  ),
                ].filter((job) => job !== null)
              : await boss.findJobs(assetIngestQueue, {
                  ...connection,
                  key: versionId,
                });
            const live = jobs.find((job) =>
              ["created", "retry", "active"].includes(job.state),
            );
            if (live) {
              // Adopt jobs from before this migration without enqueueing duplicates.
              if (!version.ingestJobId)
                await tx
                  .update(assetVersion)
                  .set({ ingestJobId: live.id })
                  .where(
                    and(
                      eq(assetVersion.id, versionId),
                      isNull(assetVersion.ingestJobId),
                    ),
                  );
              return false;
            }
            const exhausted = jobs.some((job) => job.state === "failed");
            return failVersion(
              tx,
              {
                workspaceId,
                assetId: version.assetId,
                versionId,
                requestId: `ingest-recovery:${version.ingestJobId ?? versionId}`,
              },
              version.ingestAttemptId,
              exhausted
                ? "Processing failed after repeated attempts. Check storage availability and retry processing."
                : "Processing was interrupted before it finished. Retry processing.",
              true,
            );
          });
          if (changed) recovered++;
        }
        if (versions.length < 100) break;
        versionAfter = versions.at(-1)!.id;
      }
    }
    if (workspaces.length < 100) break;
    workspaceAfter = workspaces.at(-1)!.id;
  }
  if (recovered)
    console.log(`Marked ${recovered} interrupted asset versions as retryable`);
  return recovered;
}
