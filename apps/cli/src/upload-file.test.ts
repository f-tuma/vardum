import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readUploadFile, validateUploadLimits, type UploadFileIO } from "./upload-file.js";

const limits = { image: 4, video: 8, file: 2 };

function fixture() {
  const state = {
    source: Buffer.from("abcd"),
    metadata: { size: 4n, dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n },
    regular: true,
    chunkSize: Infinity,
    opened: 0,
    closed: 0,
    stats: 0,
    allocations: [] as number[],
    reads: [] as Array<{ offset: number; length: number; position: number }>,
    onRead: (_index: number) => {},
    onStat: (_index: number) => {},
    onAllocate: (_size: number) => {},
  };
  const io: UploadFileIO = {
    async open() {
      state.opened++;
      return {
        async stat() {
          state.onStat(state.stats++);
          return { ...state.metadata, isFile: () => state.regular };
        },
        async read(bytes, offset, length, position) {
          state.reads.push({ offset, length, position });
          state.onRead(state.reads.length);
          const chunk = state.source.subarray(
            position,
            position + Math.min(length, state.chunkSize),
          );
          bytes.set(chunk, offset);
          return { bytesRead: chunk.length };
        },
        async close() { state.closed++; },
      };
    },
    allocate(size) {
      state.allocations.push(size);
      state.onAllocate(size);
      return Buffer.alloc(size);
    },
  };
  return { state, io, read: (mimeType = "image/png") => readUploadFile("test.png", mimeType, limits, io) };
}

test("required upload ceilings are positive safe integers and copied from the response", () => {
  const valid = { image: 4, video: 8, file: 2, future: true };
  assert.deepEqual(validateUploadLimits(valid), limits);
  const invalid = [null, [], {}, { image: 4, video: 8 }];
  for (const kind of ["image", "video", "file"])
    for (const value of [undefined, null, "4", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      invalid.push({ ...limits, [kind]: value } as any);
  for (const value of invalid)
    assert.throws(() => validateUploadLimits(value), /invalid upload limits/);
  const copy = validateUploadLimits(valid);
  valid.image = 0;
  assert.equal(copy.image, 4);
});

test("bounded reads accept inclusive MIME ceilings, partial reads and one-byte EOF probes", async () => {
  for (const [mimeType, size] of [["image/png", 4], ["video/mp4", 8], ["application/octet-stream", 2]] as const) {
    const f = fixture();
    f.state.source = Buffer.alloc(size, 0x61);
    f.state.metadata.size = BigInt(size);
    f.state.chunkSize = 2;
    assert.deepEqual(await f.read(mimeType), f.state.source);
    assert.deepEqual(f.state.allocations, [size, 1]);
    assert.deepEqual(f.state.reads.at(-1), { offset: 0, length: 1, position: size });
    assert.equal(f.state.stats, 2);
    assert.equal(f.state.closed, 1);
  }
  const tiny = fixture();
  tiny.state.source = Buffer.from("a");
  tiny.state.metadata.size = 1n;
  assert.deepEqual(await tiny.read(), Buffer.from("a"));
});

test("oversize, nonregular, empty and unsafe-size files close before content reads or allocation", async () => {
  for (const [mimeType, size] of [["image/png", 5n], ["video/mp4", 9n], ["application/octet-stream", 3n], ["image/png", 0n], ["image/png", -1n], ["image/png", BigInt(Number.MAX_SAFE_INTEGER) + 1n]] as const) {
    const f = fixture();
    f.state.metadata.size = size;
    await assert.rejects(f.read(mimeType), /limit|non-empty.*safe byte size/);
    assert.deepEqual(f.state.allocations, []);
    assert.deepEqual(f.state.reads, []);
    assert.equal(f.state.closed, 1);
  }
  const directory = fixture();
  directory.state.regular = false;
  await assert.rejects(directory.read(), /regular file/);
  assert.deepEqual(directory.state.allocations, []);
  assert.deepEqual(directory.state.reads, []);
  assert.equal(directory.state.closed, 1);
});

test("a real sparse file above the ceiling is rejected without allocating or reading contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vardum-sparse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "large.png");
  const writable = await open(path, "w");
  await writable.truncate(2 ** 32 + 1);
  await writable.close();
  let closed = false;
  const io: UploadFileIO = {
    async open(filename) {
      const handle = await open(filename, "r");
      return {
        stat: () => handle.stat({ bigint: true }),
        async read() { assert.fail("sparse contents must not be read"); },
        async close() { closed = true; await handle.close(); },
      };
    },
    allocate() { assert.fail("over-limit contents must not be allocated"); },
  };
  await assert.rejects(readUploadFile(path, "image/png", limits, io), /limit/);
  assert.equal(closed, true);
});

test("a real FIFO is rejected as nonregular without waiting for a writer", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vardum-fifo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pipe.png");
  execFileSync("mkfifo", [path]);
  await assert.rejects(readUploadFile(path, "image/png", limits), /regular file/);
});

test("growth, shrinkage and detected same-size or identity changes reject captured bytes and close", async () => {
  const growing = fixture();
  growing.state.onRead = (index) => {
    if (index === 2) growing.state.source = Buffer.from("abcde");
  };
  await assert.rejects(growing.read(), /changed while being read/);
  assert.deepEqual(growing.state.allocations, [4, 1]);
  assert.equal(growing.state.closed, 1);

  const shrinking = fixture();
  shrinking.state.chunkSize = 2;
  shrinking.state.onRead = (index) => {
    if (index === 2) shrinking.state.source = Buffer.from("ab");
  };
  await assert.rejects(shrinking.read(), /changed while being read/);
  assert.deepEqual(shrinking.state.allocations, [4]);
  assert.equal(shrinking.state.closed, 1);

  for (const field of ["size", "dev", "ino", "mtimeNs", "ctimeNs"] as const) {
    const f = fixture();
    f.state.onStat = (index) => { if (index === 1) f.state.metadata[field]++; };
    await assert.rejects(f.read(), /changed while being read/, field);
    assert.equal(f.state.closed, 1, field);
  }
  const rewritten = fixture();
  rewritten.state.onRead = (index) => {
    if (index === 2) {
      rewritten.state.source = Buffer.from("dcba");
      rewritten.state.metadata.ctimeNs++;
    }
  };
  await assert.rejects(rewritten.read(), /changed while being read/);
  assert.equal(rewritten.state.closed, 1);
});

test("stat, allocation and read errors all close an opened handle", async () => {
  for (const failure of ["stat", "allocate", "read"] as const) {
    const f = fixture();
    const reject = () => { throw new Error(`${failure} failed`); };
    if (failure === "stat") f.state.onStat = reject;
    if (failure === "allocate") f.state.onAllocate = reject;
    if (failure === "read") f.state.onRead = reject;
    await assert.rejects(f.read(), new RegExp(`${failure} failed`));
    assert.equal(f.state.closed, 1);
  }
  const invalid = fixture();
  await assert.rejects(readUploadFile("test.png", "image/png", { ...limits, file: 0 }, invalid.io), /invalid upload limits/);
  assert.equal(invalid.state.opened, 0);
});
