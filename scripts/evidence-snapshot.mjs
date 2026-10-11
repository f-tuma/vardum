import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const maximumReportBytes = 16 * 1024 ** 2;
export async function ordinaryEvidenceDirectory(path) {
  assert.ok((await lstat(path)).isDirectory(), "Evidence directory must be ordinary");
  assert.equal(await realpath(path), path, "Evidence path ancestors must not be symlinks");
}

// Read approved regular files through one bounded descriptor snapshot. Hashing
// and parsing callers use these same bytes, never a second path-based read.
export async function readEvidenceSnapshot(directory, name, approvedFiles) {
  assert.ok(approvedFiles.includes(name) && !isAbsolute(name));
  const components = name.split("/");
  assert.ok(components.every(component => /^[A-Za-z0-9_.-]+$/.test(component) && component !== "." && component !== ".."));
  directory = resolve(directory);
  await ordinaryEvidenceDirectory(directory);
  let path = directory;
  for (const component of components.slice(0, -1)) { path = join(path, component); await ordinaryEvidenceDirectory(path); }
  path = join(path, components.at(-1));
  const before = await lstat(path);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= maximumReportBytes, "Evidence must be a bounded ordinary file without hardlinks");
  // NONBLOCK also prevents a swapped FIFO from hanging before fstat rejects it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    assert.ok(opened.isFile() && opened.nlink === 1 && opened.dev === before.dev && opened.ino === before.ino && opened.size <= maximumReportBytes);
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximumReportBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      assert.ok(size <= maximumReportBytes, "Evidence grew beyond its bound");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    assert.ok(after.nlink === 1 && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && size === opened.size,
      "Evidence changed while reading");
    const bytes = Buffer.concat(chunks, size);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { await handle.close(); }
}
