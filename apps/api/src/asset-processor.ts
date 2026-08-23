import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { asset, assetVersion, auditEvent } from "./db/app-schema.js";
import { inWorkspace } from "./db/tenant.js";
import { getObject } from "./storage.js";

export const supportedImageMimeTypes = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
] as const;

export const supportedVideoMimeTypes = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/mpeg",
] as const;

export const supportedMimeTypes = [
  ...supportedImageMimeTypes,
  ...supportedVideoMimeTypes,
] as const;

export const videoMimeSet: Set<string> = new Set(supportedVideoMimeTypes);

const payloadSchema = z.object({
  workspaceId: z.string().min(1),
  assetId: z.uuid(),
  versionId: z.uuid(),
  requestId: z.string().min(1),
});
export type AssetIngestPayload = z.infer<typeof payloadSchema>;

export async function processAsset(input: unknown) {
  const payload = payloadSchema.parse(input);
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
        );
      if (!row || row.status === "ready" || row.status === "failed")
        return null;

      await transaction
        .update(assetVersion)
        .set({ status: "processing", updatedBy: "system:ingest-worker" })
        .where(eq(assetVersion.id, payload.versionId));
      return row;
    },
  );
  if (!pending) return;

  const object = await getObject(pending.storageKey);
  if (!object.Body) throw new Error("S3 returned an empty body");
  // ponytail: upload size is capped at 100 MiB; stream to disk if that ceiling grows.
  const bytes = Buffer.from(await object.Body.transformToByteArray());

  // Video: no sharp processing, just checksum + mark ready.
  if (videoMimeSet.has(pending.mimeType)) {
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await markReady(payload, checksum, pending.mimeType, null, null);
    return;
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(bytes, {
      animated: true,
      limitInputPixels: 100_000_000,
    }).metadata();
  } catch {
    await failVersion(payload, "The uploaded file is not a supported image");
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
    await failVersion(
      payload,
      "The uploaded image does not match its declared type or limits",
    );
    return;
  }

  const checksum = createHash("sha256").update(bytes).digest("hex");
  await markReady(payload, checksum, detectedMimeType, width, height);
}

async function markReady(
  payload: AssetIngestPayload,
  checksum: string,
  mimeType: string,
  width: number | null,
  height: number | null,
) {
  await inWorkspace(payload.workspaceId, async (transaction) => {
    const [version] = await transaction
      .select({ status: assetVersion.status, number: assetVersion.number })
      .from(assetVersion)
      .where(eq(assetVersion.id, payload.versionId))
      .for("update");
    if (!version || version.status === "ready" || version.status === "failed")
      return;

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

async function failVersion(payload: AssetIngestPayload, message: string) {
  await inWorkspace(payload.workspaceId, async (transaction) => {
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

    await transaction
      .update(assetVersion)
      .set({
        status: "failed",
        error: message,
        updatedBy: "system:ingest-worker",
      })
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
      },
      requestId: payload.requestId,
    });
  });
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
