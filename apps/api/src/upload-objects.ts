import { asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { assetUpload, assetVersion } from "./db/app-schema.js";
import { db } from "./db/index.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import { inWorkspace } from "./db/tenant.js";
import { deleteObjects, listObjectPage } from "./storage.js";

type Version = typeof assetVersion.$inferSelect;

export function sealedUploadPrefix(version: Pick<Version, "workspaceId" | "assetId" | "id">) {
  return `originals/${version.workspaceId}/${version.assetId}/${version.id}/sealed/`;
}

/** Bounded, fair, repeatable maintenance; never garbage-collect ready bytes. */
export async function cleanupUploadObjects(now = new Date(), batch = 100) {
  let inspected = 0;
  let cleaned = 0;
  let failure: unknown;
  // This narrow definer view exposes only cleanup scope IDs, never object keys.
  // Unlike workspace, it also retains directories deleted since an upload.
  const scopes = await db.execute<{ workspace_id: string }>(sql`
    SELECT workspace_id FROM asset_upload_cleanup_scope
    WHERE sweep_at IS NULL OR sweep_at < ${new Date(now.getTime() - 86400_000)}
    GROUP BY workspace_id
    ORDER BY CASE WHEN count(sweep_attempt_at) < count(*) THEN NULL
      ELSE min(sweep_attempt_at) END ASC NULLS FIRST, workspace_id LIMIT 100
  `);
  for (const scope of scopes.rows) {
    if (inspected >= batch) break;
    const rows = await inWorkspace(scope.workspace_id, async (tx) => {
      await lockWorkspaceContent(tx, scope.workspace_id);
      const rows = await tx.select().from(assetUpload).where(
        or(isNull(assetUpload.sweepAt), lt(assetUpload.sweepAt, new Date(now.getTime() - 86400_000))),
      ).orderBy(sql`${assetUpload.sweepAttemptAt} asc nulls first`, asc(assetUpload.versionId))
        .limit(batch - inspected).for("update", { skipLocked: true });
      for (const upload of rows) {
        await tx.update(assetUpload).set({ sweepAttemptAt: now })
          .where(eq(assetUpload.versionId, upload.versionId));
      }
      return rows;
    });
    for (const upload of rows) {
      inspected++;
      try {
        const prefix = sealedUploadPrefix({
          workspaceId: upload.workspaceId, assetId: upload.assetId, id: upload.versionId,
        });
        // LIST first, then take a fresh fenced snapshot. A later attempt has a
        // new UUID so its PUT cannot be in the list we are about to delete.
        const page = await listObjectPage(prefix, undefined, 1000);
        const disposable = await inWorkspace(upload.workspaceId, async tx => {
          await lockWorkspaceContent(tx, upload.workspaceId);
          const [version] = await tx.select().from(assetVersion)
            .where(eq(assetVersion.id, upload.versionId)).for("update");
          const active = version?.status === "processing" && version.ingestAttemptId
            ? `${prefix}${version.ingestAttemptId}/source` : null;
          const keys = page.objects.map(({ key }) => key)
            .filter(key => key !== version?.storageKey && key !== active);
          // Retain pending/processing/retryable stages. Ready is terminal; a
          // deleted UUID cannot be revived because its ledger PK is retained.
          if (!version || (version.status === "ready" && upload.storageKey !== version.storageKey) ||
            (version.status === "failed" && version.uploadExpiredAt)) keys.push(upload.storageKey);
          return keys;
        });
        const keys = [...new Set(disposable)];
        for (let offset = 0; offset < keys.length; offset += 1000)
          await deleteObjects(keys.slice(offset, offset + 1000));
        // A page with more candidates is retried immediately on the next sweep.
        // Each invocation remains bounded even under excessive failed attempts.
        if (!page.nextToken) {
          await inWorkspace(upload.workspaceId, tx => tx.update(assetUpload)
            .set({ sweepAt: now }).where(eq(assetUpload.versionId, upload.versionId)));
        }
        cleaned++;
      } catch (error) {
        console.warn(JSON.stringify({ event: "upload.objects_cleanup_failed", versionId: upload.versionId }));
        failure = error;
      }
    }
  }
  if (failure) throw failure;
  return cleaned;
}
