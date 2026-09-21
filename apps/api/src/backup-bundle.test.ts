import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  createBundle,
  objectFile,
  restoreObjects,
  verifyBundle,
} from "./backup-bundle.js";

const source = {
  project: "test",
  image: "sha256:test",
  postgresVersion: "17",
  migrations: [{ hash: "test", createdAt: "1" }],
};
function store(entries: Array<[string, Buffer]>, mutateInventory = false) {
  const objects = new Map(entries);
  let lists = 0,
    puts = 0;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        lists++;
        return {
          IsTruncated: false,
          Contents: [...objects].map(([Key, body]) => ({
            Key,
            Size: body.length,
            ETag: '"test"',
            LastModified: new Date(mutateInventory && lists > 1 ? 1000 : 0),
          })),
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          Body: Readable.from([objects.get(command.input.Key!)!]),
          ContentType: "application/octet-stream",
          Metadata: { owner: "fixture" },
          CacheControl: "private",
        };
      }
      if (command instanceof PutObjectCommand) {
        puts++;
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body as Readable)
          chunks.push(chunk);
        objects.set(command.input.Key!, Buffer.concat(chunks));
        return {};
      }
      throw new Error("Unexpected S3 operation");
    },
  } as unknown as S3Client;
  return { client, objects, puts: () => puts };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "vardum-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "postgres.dump"), "database archive", {
    mode: 0o600,
  });
  await writeFile(join(directory, "references.json"), "[]", { mode: 0o600 });
  return directory;
}

test("bundle safely stores empty objects and path-like keys, and verifies restored bytes", async (t) => {
  const directory = await fixture(t);
  const data: Array<[string, Buffer]> = [
    ["../../outside", Buffer.from("private data")],
    ["folder/", Buffer.alloc(0)],
  ];
  const manifest = await createBundle(
    store(data).client,
    "source",
    directory,
    source,
  );
  assert.equal(manifest.objects.length, 2);
  assert.equal(
    (await stat(join(directory, "backup.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(join(directory, "objects"))).mode & 0o777, 0o700);
  assert.deepEqual(await verifyBundle(directory), manifest);
  const destination = store([]);
  await restoreObjects(destination.client, "target", directory);
  assert.deepEqual(destination.objects, new Map(data));
});

test("corrupt, missing, symlinked and path-traversing backup entries are rejected before writes", async (t) => {
  const directory = await fixture(t);
  await createBundle(
    store([
      ["a", Buffer.from("first")],
      ["b", Buffer.from("second")],
    ]).client,
    "source",
    directory,
    source,
  );
  const manifestPath = join(directory, "backup.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  const path = join(directory, objectFile("b"));
  await writeFile(path, "broken");
  const destination = store([]);
  await assert.rejects(
    restoreObjects(destination.client, "target", directory),
    /integrity/,
  );
  assert.equal(
    destination.puts(),
    0,
    "all objects are checked before restoring the first one",
  );
  await rm(path);
  await assert.rejects(verifyBundle(directory), /ENOENT/);
  await symlink(join(directory, "postgres.dump"), path);
  await assert.rejects(verifyBundle(directory), /symlinks/);
  await rm(path);
  await writeFile(path, "second");
  const malformed = JSON.parse(originalManifest);
  malformed.objects[0].file = "../outside";
  await writeFile(manifestPath, JSON.stringify(malformed));
  await assert.rejects(verifyBundle(directory));
  malformed.objects[0].file = objectFile("a");
  malformed.objects.push(malformed.objects[0]);
  await writeFile(manifestPath, JSON.stringify(malformed));
  await assert.rejects(verifyBundle(directory), /Duplicate/);
  await writeFile(manifestPath, originalManifest);
  await writeFile(join(directory, "postgres.dump"), "modified database");
  await assert.rejects(verifyBundle(directory), /integrity/);
});

test("a changed bucket never produces a complete backup marker", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(
    createBundle(
      store([["a", Buffer.from("data")]], true).client,
      "source",
      directory,
      source,
    ),
    /Bucket changed/,
  );
  await assert.rejects(readFile(join(directory, "backup.json")), /ENOENT/);
});

test("restore refuses a populated bucket without modifying existing objects", async (t) => {
  const directory = await fixture(t);
  await createBundle(
    store([["a", Buffer.from("source")]]).client,
    "source",
    directory,
    source,
  );
  const destination = store([["keep", Buffer.from("destination")]]);
  await assert.rejects(
    restoreObjects(destination.client, "target", directory),
    /empty destination bucket/,
  );
  assert.equal(destination.puts(), 0);
  assert.deepEqual(
    [...destination.objects],
    [["keep", Buffer.from("destination")]],
  );
});

test("database references must have matching originals before a backup is completed", async (t) => {
  for (const reference of [
    { key: "missing", size: 4, sha256: null },
    { key: "a", size: 5, sha256: null },
    { key: "a", size: 4, sha256: "0".repeat(64) },
  ]) {
    const directory = await fixture(t);
    await writeFile(
      join(directory, "references.json"),
      JSON.stringify([reference]),
    );
    await assert.rejects(
      createBundle(
        store([["a", Buffer.from("data")]]).client,
        "source",
        directory,
        source,
      ),
      /required|does not match/,
    );
    await assert.rejects(readFile(join(directory, "backup.json")), /ENOENT/);
  }
});
