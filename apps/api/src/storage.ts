import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { config } from "./config.js";

export const storage = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials:
    config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        }
      : undefined,
});

export function createUpload(
  storageKey: string,
  mimeType: string,
  maxSize: number,
) {
  return createPresignedPost(storage, {
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
