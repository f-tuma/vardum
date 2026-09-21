import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headers = z
  .object({
    ContentType: z.string().optional(),
    CacheControl: z.string().optional(),
    ContentDisposition: z.string().optional(),
    ContentEncoding: z.string().optional(),
    ContentLanguage: z.string().optional(),
    Expires: z.iso.datetime().optional(),
    Metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const objectRecord = z
  .object({
    key: z.string().min(1),
    file: z.string().regex(/^objects\/[a-f0-9]{64}\.bin$/),
    size,
    sha256: checksum,
    headers,
  })
  .strict();
export const backupSource = z
  .object({
    project: z.string(),
    image: z.string(),
    postgresVersion: z.string(),
    migrations: z.array(
      z.object({ hash: z.string(), createdAt: z.string() }).strict(),
    ),
  })
  .strict();
const manifestSchema = z
  .object({
    schema: z.literal(1),
    createdAt: z.iso.datetime(),
    source: backupSource,
    database: z
      .object({ file: z.literal("postgres.dump"), size, sha256: checksum })
      .strict(),
    references: z
      .object({ file: z.literal("references.json"), size, sha256: checksum })
      .strict(),
    objects: z.array(objectRecord),
  })
  .strict();
type ObjectRecord = z.infer<typeof objectRecord>;
const referencesSchema = z.array(
  z
    .object({ key: z.string().min(1), size, sha256: checksum.nullable() })
    .strict(),
);

async function verifyReferences(directory: string, objects: ObjectRecord[]) {
  await regular(join(directory, "references.json"));
  const references = referencesSchema.parse(
    JSON.parse(await readFile(join(directory, "references.json"), "utf8")),
  );
  const byKey = new Map(objects.map((item) => [item.key, item]));
  for (const reference of references) {
    const object = byKey.get(reference.key);
    assert.ok(
      object,
      "Backup is missing an original required by a ready/processing database version",
    );
    assert.equal(
      object.size,
      reference.size,
      "Original size does not match the database",
    );
    if (reference.sha256)
      assert.equal(
        object.sha256,
        reference.sha256,
        "Original checksum does not match the database",
      );
  }
}

export const objectFile = (key: string) =>
  `objects/${createHash("sha256").update(key).digest("hex")}.bin`;

async function regular(path: string, directory = false) {
  const info = await lstat(path);
  assert.ok(
    directory ? info.isDirectory() : info.isFile(),
    "Backup paths must be regular files/directories, not symlinks",
  );
  return info;
}

export async function digestFile(path: string) {
  await regular(path);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { size: bytes, sha256: hash.digest("hex") };
}

export async function verifyBundle(directory: string) {
  await regular(directory, true);
  await regular(join(directory, "backup.json"));
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "backup.json"), "utf8")),
  );
  await regular(join(directory, "objects"), true);
  const keys = new Set<string>();
  for (const item of manifest.objects) {
    assert.equal(
      item.file,
      objectFile(item.key),
      "Object filename must be derived from its key",
    );
    assert.ok(!keys.has(item.key), "Duplicate object key in backup");
    keys.add(item.key);
  }
  // Validate every byte before any restore writes, including empty objects.
  for (const item of [
    manifest.database,
    manifest.references,
    ...manifest.objects,
  ]) {
    const actual = await digestFile(join(directory, item.file));
    assert.deepEqual(
      actual,
      { size: item.size, sha256: item.sha256 },
      `Backup integrity failed: ${item.file}`,
    );
  }
  await verifyReferences(directory, manifest.objects);
  return manifest;
}

async function inventory(client: S3Client, bucket: string) {
  const objects: Array<{
    key: string;
    size: number;
    etag: string;
    modified: string;
  }> = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      assert.ok(
        object.Key &&
          object.ETag &&
          object.LastModified &&
          object.Size !== undefined,
        "Incomplete object inventory",
      );
      objects.push({
        key: object.Key,
        size: object.Size,
        etag: object.ETag,
        modified: object.LastModified.toISOString(),
      });
    }
    if (page.IsTruncated)
      assert.ok(
        page.NextContinuationToken && page.NextContinuationToken !== token,
        "Incomplete object pagination",
      );
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function savedHeaders(object: z.input<typeof headers> & { Expires?: string }) {
  return headers.parse(
    Object.fromEntries(
      Object.entries(object).filter(([, value]) => value !== undefined),
    ),
  );
}

export async function createBundle(
  client: S3Client,
  bucket: string,
  directory: string,
  source: z.infer<typeof backupSource>,
) {
  await regular(directory, true);
  await mkdir(join(directory, "objects"), { mode: 0o700 });
  const database = {
    file: "postgres.dump" as const,
    ...(await digestFile(join(directory, "postgres.dump"))),
  };
  const references = {
    file: "references.json" as const,
    ...(await digestFile(join(directory, "references.json"))),
  };
  const before = await inventory(client, bucket);
  const objects: ObjectRecord[] = [];
  for (const item of before) {
    assert.ok(
      item.size <= 5 * 1024 ** 3,
      "Objects larger than 5 GiB require a provider-native backup",
    );
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: item.key,
        IfMatch: item.etag,
      }),
    );
    assert.ok(response.Body, "Missing object body");
    const file = objectFile(item.key);
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      response.Body as Readable,
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      }),
      createWriteStream(join(directory, file), { flags: "wx", mode: 0o600 }),
    );
    assert.equal(bytes, item.size, "Object changed during backup");
    objects.push({
      key: item.key,
      file,
      size: bytes,
      sha256: hash.digest("hex"),
      headers: savedHeaders({
        ContentType: response.ContentType,
        CacheControl: response.CacheControl,
        ContentDisposition: response.ContentDisposition,
        ContentEncoding: response.ContentEncoding,
        ContentLanguage: response.ContentLanguage,
        Expires: response.Expires?.toISOString(),
        Metadata: response.Metadata,
      }),
    });
  }
  assert.deepEqual(
    await inventory(client, bucket),
    before,
    "Bucket changed during backup; keep writers stopped and retry with a new directory",
  );
  await verifyReferences(directory, objects);
  const manifest = manifestSchema.parse({
    schema: 1,
    createdAt: new Date().toISOString(),
    source,
    database,
    references,
    objects,
  });
  // Completion marker comes last; interrupted exports cannot be restored.
  await writeFile(
    join(directory, "backup.json.partial"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await rename(
    join(directory, "backup.json.partial"),
    join(directory, "backup.json"),
  );
  return manifest;
}

export async function requireEmptyBucket(client: S3Client, bucket: string) {
  const page = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
  );
  assert.equal(
    page.Contents?.length ?? 0,
    0,
    "Restore requires an empty destination bucket; nothing was overwritten",
  );
  assert.ok(!page.IsTruncated, "Destination bucket is not empty");
}

export async function restoreObjects(
  client: S3Client,
  bucket: string,
  directory: string,
) {
  const manifest = await verifyBundle(directory);
  await requireEmptyBucket(client, bucket);
  for (const item of manifest.objects) {
    const { Expires, ...metadata } = item.headers;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: item.key,
        ...metadata,
        ...(Expires ? { Expires: new Date(Expires) } : {}),
        Body: createReadStream(join(directory, item.file)),
        ContentLength: item.size,
        IfNoneMatch: "*",
      }),
    );
    const restored = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: item.key }),
    );
    assert.ok(restored.Body);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of restored.Body as Readable) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    assert.equal(bytes, item.size, "Restored object size differs");
    assert.equal(
      hash.digest("hex"),
      item.sha256,
      "Restored object checksum differs",
    );
    const actual = savedHeaders({
      ContentType: restored.ContentType,
      CacheControl: restored.CacheControl,
      ContentDisposition: restored.ContentDisposition,
      ContentEncoding: restored.ContentEncoding,
      ContentLanguage: restored.ContentLanguage,
      Expires: restored.Expires?.toISOString(),
      Metadata: restored.Metadata,
    });
    assert.deepEqual(actual, item.headers, "Restored object metadata differs");
  }
  assert.equal(
    (await inventory(client, bucket)).length,
    manifest.objects.length,
    "Destination changed during restore",
  );
  return manifest;
}
