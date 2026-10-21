import { randomUUID } from "node:crypto";
import { and, desc, eq, max, or } from "drizzle-orm";
import { asset, assetVersion, auditEvent } from "./db/app-schema.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import type { Transaction } from "./db/tenant.js";
import { lockWorkspaceBudget, reserveUpload, uploadDeadline } from "./upload-lifecycle.js";

export class UploadIntentConflict extends Error {}

type Version = typeof assetVersion.$inferSelect;
type Intent = {
  filename: string; mimeType: string; size: number;
  id?: string; expectedChecksum?: string; expectedCurrentVersionId?: string | null;
};
type Actor = { reference: string; actorType: "user" | "api_key" | "system"; actorId: string };

/** Explicit status lookup remains useful after the upload ceases to be current. */
export function uploadVersionState(version: Version) {
  return {
    id: version.id, number: version.number, status: version.status,
    filename: version.filename, mimeType: version.mimeType, size: version.size,
    checksum: version.checksum, expectedChecksum: version.expectedChecksum,
    retryable: version.retryable, error: version.error,
    expiresAt: uploadDeadline(version.createdAt).toISOString(),
  };
}

/** No S3 work or waits inside the reservation transaction. */
export async function admitUploadIntent(
  tx: Transaction, workspaceId: string, assetId: string, intent: Intent,
  actor: Actor, requestId: string,
) {
  // Admission and retries share the same ordering as budget checks. Existing
  // reservations are recognized before charging pending/storage capacity again.
  await lockWorkspaceBudget(tx, workspaceId);
  await lockWorkspaceContent(tx, workspaceId);
  const [target] = await tx.select().from(asset).where(eq(asset.id, assetId)).for("update");
  if (!target) return null;
  if (target.archivedAt) throw new UploadIntentConflict("Asset is archived; unarchive it before making changes");

  if (intent.id) {
    const [replay] = await tx.select().from(assetVersion).where(eq(assetVersion.id, intent.id));
    if (replay) {
      if (replay.assetId !== assetId || replay.filename !== intent.filename ||
        replay.mimeType !== intent.mimeType || replay.size !== intent.size ||
        replay.expectedChecksum !== intent.expectedChecksum)
        throw new UploadIntentConflict("Upload request ID belongs to different content or metadata");
      assertReplayable(replay);
      return { version: replay, created: false };
    }

    const active = await tx.select().from(assetVersion).where(and(
      eq(assetVersion.assetId, assetId),
      or(eq(assetVersion.status, "pending"), eq(assetVersion.status, "processing"),
        and(eq(assetVersion.status, "failed"), eq(assetVersion.retryable, true))),
    )).orderBy(desc(assetVersion.number));
    // An older unfinished upload must not promote different bytes later.
    if (active.some(row => row.expectedChecksum !== intent.expectedChecksum ||
      row.filename !== intent.filename || row.mimeType !== intent.mimeType || row.size !== intent.size))
      throw new UploadIntentConflict("Asset has another unfinished upload. Finish or retry that upload before pushing this file");
    if (target.currentVersionId) {
      const [current] = await tx.select().from(assetVersion).where(eq(assetVersion.id, target.currentVersionId));
      if (current?.status === "ready" && current.checksum === intent.expectedChecksum &&
        current.filename === intent.filename && current.mimeType === intent.mimeType && current.size === intent.size)
        return { version: current, created: false };
    }
    if (target.currentVersionId !== intent.expectedCurrentVersionId)
      throw new UploadIntentConflict("Asset changed since the folder plan. Refresh the plan before uploading");
    if (active[0]) {
      assertReplayable(active[0]);
      return { version: active[0], created: false };
    }

  }

  await reserveUpload(tx, workspaceId, intent.size);
  const [latest] = await tx.select({ number: max(assetVersion.number) }).from(assetVersion).where(eq(assetVersion.assetId, assetId));
  const versionId = intent.id ?? randomUUID();
  const [version] = await tx.insert(assetVersion).values({
    id: versionId, workspaceId, assetId, number: (latest?.number ?? 0) + 1,
    storageKey: `originals/${workspaceId}/${assetId}/${versionId}/source`,
    filename: intent.filename, mimeType: intent.mimeType, size: intent.size,
    expectedChecksum: intent.expectedChecksum ?? null,
    createdBy: actor.reference, updatedBy: actor.reference,
  }).returning();
  if (!version) throw new Error("Upload insert returned no row");
  await tx.insert(auditEvent).values({
    workspaceId, actorType: actor.actorType, actorId: actor.actorId,
    action: "asset.version_created", targetType: "asset_version", targetId: version.id,
    metadata: { assetId, key: target.key, displayName: target.displayName, number: version.number,
      filename: intent.filename, mimeType: intent.mimeType, size: intent.size },
    requestId,
  });
  return { version, created: true };
}

function assertReplayable(version: Version) {
  if (version.status === "pending" && uploadDeadline(version.createdAt).getTime() <= Date.now())
    throw new UploadIntentConflict("Upload expired. Finish cleanup and explicitly start a new upload; this request cannot be renewed");
}
