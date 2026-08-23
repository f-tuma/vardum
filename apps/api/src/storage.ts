import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { config } from "./config.js";

const credentials =
  config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
    ? {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      }
    : undefined;

export const storage = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials,
});
const uploadStorage = config.S3_PUBLIC_ENDPOINT
  ? new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_PUBLIC_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials,
    })
  : storage;

export function createUpload(
  storageKey: string,
  mimeType: string,
  maxSize: number,
) {
  return createPresignedPost(uploadStorage, {
    Bucket: config.S3_BUCKET,
    Key: storageKey,
    Fields: { "Content-Type": mimeType },
    Conditions: [
      ["eq", "$Content-Type", mimeType],
      ["content-length-range", 1, maxSize],
    ],
    Expires: 15 * 60,
  });
}

/**
 * Ensures the bucket accepts cross-origin POST uploads from the browser.
 * Without this, the presigned POST from a different origin (the app) is
 * blocked by the browser's CORS preflight. Safe to call on every startup —
 * it only sets the rule if it's missing or different.
 */
export async function ensureBucketCors() {
  if (config.NODE_ENV === "development") return;
  const rules = {
    CORSRules: [
      {
        // pi-lens-ignore: cors-wildcard — presigned POST is already signed
        // and time-limited; CORS just lets the browser reach S3. Restricting
        // origins would break custom domains like media.musubi.pro.
        // pi-lens-ignore: cors-wildcard
        AllowedOrigins: ["*"],
        AllowedMethods: ["GET", "POST", "PUT", "HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
        MaxAgeSeconds: 3600,
      },
    ],
  };
  try {
    const existing = await storage.send(
      new GetBucketCorsCommand({ Bucket: config.S3_BUCKET }),
    );
    if (JSON.stringify(existing.CORSRules) === JSON.stringify(rules.CORSRules))
      return;
  } catch {
    // NoSuchCORSConfiguration — proceed to set it.
  }
  await storage.send(
    new PutBucketCorsCommand({
      Bucket: config.S3_BUCKET,
      CORSConfiguration: rules,
    }),
  );
}

export function inspectUpload(storageKey: string) {
  return storage.send(
    new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: storageKey }),
  );
}

export function getObject(storageKey: string) {
  return storage.send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: storageKey }),
  );
}

export async function listObjectKeys(prefix: string) {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await storage.send(
      new ListObjectsV2Command({
        Bucket: config.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    keys.push(
      ...(result.Contents?.flatMap(({ Key }) => (Key ? [Key] : [])) ?? []),
    );
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

// One page at a time: an import walks a prefix the caller does not control, so
// the request stays bounded and hands back a token instead of a long stall.
export async function listObjectPage(
  prefix: string,
  token: string | undefined,
  limit: number,
) {
  const result = await storage.send(
    new ListObjectsV2Command({
      Bucket: config.S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: limit,
    }),
  );
  return {
    objects: (result.Contents ?? []).flatMap(({ Key, Size }) =>
      Key && Size ? [{ key: Key, size: Size }] : [],
    ),
    nextToken: result.NextContinuationToken ?? null,
  };
}

export function headObject(storageKey: string) {
  return storage.send(
    new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: storageKey }),
  );
}

// Import copies rather than referencing the object in place: deleting an asset
// deletes its stored objects, and that must never reach into the caller's own
// files.
export function copyObject(
  sourceKey: string,
  storageKey: string,
  contentType: string,
) {
  return storage.send(
    new CopyObjectCommand({
      Bucket: config.S3_BUCKET,
      CopySource: `${config.S3_BUCKET}/${encodeURIComponent(sourceKey)}`,
      Key: storageKey,
      ContentType: contentType,
      MetadataDirective: "REPLACE",
    }),
  );
}

export function deleteObjects(storageKeys: string[]) {
  if (!storageKeys.length) return Promise.resolve();
  return storage
    .send(
      new DeleteObjectsCommand({
        Bucket: config.S3_BUCKET,
        Delete: { Objects: storageKeys.map((Key) => ({ Key })), Quiet: true },
      }),
    )
    .then(() => undefined);
}

export function putDerivedObject(
  storageKey: string,
  body: Buffer,
  contentType: string,
) {
  return storage.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: storageKey,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}
