import { createHash, randomUUID } from "node:crypto";
import { videoMimeSet } from "@vardum/shared";
import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { asset, assetVersion, auditEvent } from "./db/app-schema.js";
import { inWorkspace, type Transaction } from "./db/tenant.js";
import { getObject, readBoundedObject } from "./storage.js";

const payloadSchema = z.object({
  workspaceId: z.string().min(1),
  assetId: z.uuid(),
  versionId: z.uuid(),
  requestId: z.string().min(1),
});
export type AssetIngestPayload = z.infer<typeof payloadSchema>;

export async function processAsset(
  input: unknown,
  options: { jobId?: string; signal?: AbortSignal } = {},
) {
  const payload = payloadSchema.parse(input);
  const attemptId = randomUUID();
  options.signal?.throwIfAborted();
  const pending = await inWorkspace(
    payload.workspaceId,
    async (transaction) => {
      const [row] = await transaction
        .select()
        .from(assetVersion)
        .where(
          and(
            eq(assetVersion.workspaceId, payload.workspaceId),
            eq(assetVersion.assetId, payload.assetId),
            eq(assetVersion.id, payload.versionId),
          ),
        )
        .for("update");
      if (!row || row.status === "ready" || row.status === "failed")
        return null;
      if (row.ingestJobId && row.ingestJobId !== options.jobId) return null;
      options.signal?.throwIfAborted();

      await transaction
        .update(assetVersion)
        .set({
          status: "processing",
          ingestAttemptId: attemptId,
          ingestJobId: options.jobId ?? row.ingestJobId,
          updatedBy: "system:ingest-worker",
        })
        .where(eq(assetVersion.id, payload.versionId));
      return row;
    },
  );
  if (!pending) return;
  const fail = (message: string) => {
    options.signal?.throwIfAborted();
    return inWorkspace(payload.workspaceId, (tx) =>
      failVersion(tx, payload, attemptId, message, false),
    );
  };

  const object = await getObject(pending.storageKey, undefined, options.signal);
  if (!object.Body) throw new Error("S3 returned an empty body");
  // Upload limits bound this buffer; stream to disk if those limits grow.
  const bytes = await readBoundedObject(object, pending.size, options.signal);
  options.signal?.throwIfAborted();

  // Video: no sharp processing, just checksum + mark ready.
  if (videoMimeSet.has(pending.mimeType)) {
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await markReady(
      payload,
      attemptId,
      checksum,
      pending.mimeType,
      null,
      null,
      options.signal,
    );
    return;
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(bytes, {
      animated: true,
      limitInputPixels: 100_000_000,
    }).metadata();
  } catch {
    await fail(
      "The uploaded file is not a supported image. Upload a new file.",
    );
    return;
  }

  const detectedMimeType = detectMimeType(metadata.format, pending.mimeType);
  const width = metadata.autoOrient.width;
  const height = metadata.pageHeight ?? metadata.autoOrient.height;
  const totalPixels = width * height * (metadata.pages ?? 1);
  if (
    !detectedMimeType ||
    detectedMimeType !== pending.mimeType ||
    !width ||
    !height ||
    totalPixels > 100_000_000
  ) {
    await fail(
      "The uploaded image does not match its declared type or limits. Upload a new file.",
    );
    return;
  }

  const checksum = createHash("sha256").update(bytes).digest("hex");
  await markReady(
    payload,
    attemptId,
    checksum,
    detectedMimeType,
    width,
    height,
    options.signal,
  );
}

async function markReady(
  payload: AssetIngestPayload,
  attemptId: string,
  checksum: string,
  mimeType: string,
  width: number | null,
  height: number | null,
  signal?: AbortSignal,
) {
  await inWorkspace(payload.workspaceId, async (transaction) => {
    const [version] = await transaction
      .select({ status: assetVersion.status, number: assetVersion.number })
      .from(assetVersion)
      .where(
        and(
          eq(assetVersion.id, payload.versionId),
          eq(assetVersion.ingestAttemptId, attemptId),
        ),
      )
      .for("update");
    if (!version || version.status === "ready" || version.status === "failed")
      return;
    signal?.throwIfAborted();

    const [target] = await transaction
      .select({
        currentVersionId: asset.currentVersionId,
        key: asset.key,
        displayName: asset.displayName,
      })
      .from(asset)
      .where(eq(asset.id, payload.assetId))
      .for("update");
    if (!target) return;
    signal?.throwIfAborted();

    let becomesCurrent = true;
    if (target.currentVersionId) {
      const [current] = await transaction
        .select({ number: assetVersion.number })
        .from(assetVersion)
        .where(eq(assetVersion.id, target.currentVersionId));
      becomesCurrent = !current || current.number < version.number;
    }

    await transaction
      .update(assetVersion)
      .set({
        status: "ready",
        mimeType,
        checksum,
        width,
        height,
        error: null,
        retryable: false,
        ingestAttemptId: null,
        updatedBy: "system:ingest-worker",
      })
      .where(eq(assetVersion.id, payload.versionId));
    if (becomesCurrent) {
      await transaction
        .update(asset)
        .set({
          currentVersionId: payload.versionId,
          updatedBy: "system:ingest-worker",
        })
        .where(eq(asset.id, payload.assetId));
    }
    await transaction.insert(auditEvent).values({
      workspaceId: payload.workspaceId,
      actorType: "system",
      actorId: "ingest-worker",
      action: "asset.version_processed",
      targetType: "asset_version",
      targetId: payload.versionId,
      metadata: {
        assetId: payload.assetId,
        key: target.key,
        displayName: target.displayName,
        number: version.number,
        checksum,
        width,
        height,
        becomesCurrent,
      },
      requestId: payload.requestId,
    });
  });
}

export async function failVersion(
  transaction: Transaction,
  payload: AssetIngestPayload,
  attemptId: string | null,
  message: string,
  retryable: boolean,
) {
  const [failed] = await transaction
    .update(assetVersion)
    .set({
      status: "failed",
      error: message,
      retryable,
      ingestAttemptId: null,
      updatedBy: "system:ingest-worker",
    })
    .where(
      and(
        eq(assetVersion.id, payload.versionId),
        eq(assetVersion.assetId, payload.assetId),
        eq(assetVersion.status, "processing"),
        attemptId === null
          ? isNull(assetVersion.ingestAttemptId)
          : eq(assetVersion.ingestAttemptId, attemptId),
      ),
    )
    .returning({ id: assetVersion.id });
  if (!failed) return false;
  const [context] = await transaction
    .select({
      key: asset.key,
      displayName: asset.displayName,
      number: assetVersion.number,
      filename: assetVersion.filename,
    })
    .from(assetVersion)
    .innerJoin(asset, eq(asset.id, assetVersion.assetId))
    .where(eq(assetVersion.id, payload.versionId));

  await transaction.insert(auditEvent).values({
    workspaceId: payload.workspaceId,
    actorType: "system",
    actorId: "ingest-worker",
    action: "asset.version_failed",
    targetType: "asset_version",
    targetId: payload.versionId,
    metadata: {
      assetId: payload.assetId,
      key: context?.key,
      displayName: context?.displayName,
      number: context?.number,
      filename: context?.filename,
      error: message,
      retryable,
    },
    requestId: payload.requestId,
  });
  return true;
}

export function detectMimeType(format: string, declared: string) {
  if (format === "heif") return declared === "image/avif" ? declared : null;
  return (
    {
      gif: "image/gif",
      jpeg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      tiff: "image/tiff",
      webp: "image/webp",
    }[format] ?? null
  );
}
