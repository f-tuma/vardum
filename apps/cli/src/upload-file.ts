import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename } from "node:path";
import { uploadLimitFor, type UploadLimits } from "@vardum/shared";

/** A malformed ceiling must never turn a size comparison into a permissive one. */
export function validateUploadLimits(value: unknown): UploadLimits {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Vardum returned invalid upload limits");
  const limits = value as Record<string, unknown>;
  for (const kind of ["image", "video", "file"])
    if (
      typeof limits[kind] !== "number" ||
      !Number.isSafeInteger(limits[kind]) ||
      (limits[kind] as number) <= 0
    )
      throw new Error("Vardum returned invalid upload limits");
  return {
    image: limits.image as number,
    video: limits.video as number,
    file: limits.file as number,
  };
}

export function checkUploadSize(filename: string, size: number, limit: number) {
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error(`${filename} must be a non-empty file with a safe byte size`);
  if (size > limit)
    throw new Error(
      `${filename} is ${megabytes(size)} — the limit for this file type is ${megabytes(limit)}`,
    );
}

type FileMetadata = Pick<
  BigIntStats,
  "size" | "dev" | "ino" | "mtimeNs" | "ctimeNs" | "isFile"
>;
type UploadFileHandle = {
  stat(): Promise<FileMetadata>;
  read(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

/** A narrow I/O seam lets tests reproduce partial reads and concurrent edits. */
export type UploadFileIO = {
  open(path: string): Promise<UploadFileHandle>;
  allocate(size: number): Uint8Array;
};
const fileIO: UploadFileIO = {
  async open(path) {
    // A FIFO must reach fstat rather than block waiting for a writer at open.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (bytes, offset, length, position) =>
        handle.read(bytes, offset, length, position),
      close: () => handle.close(),
    };
  },
  allocate: (size) => Buffer.alloc(size),
};

/** Capture at most the accepted size, from the same handle that was inspected. */
export async function readUploadFile(
  path: string,
  mimeType: string,
  limits: UploadLimits,
  io: UploadFileIO = fileIO,
) {
  const limit = uploadLimitFor(validateUploadLimits(limits), mimeType);
  const filename = basename(path);
  const handle = await io.open(path);
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error(`${filename} must be a regular file`);
    const size = Number(before.size);
    checkUploadSize(filename, size, limit);
    const changed = () =>
      new Error(`${filename} changed while being read; retry the push`);
    const bytes = io.allocate(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        size - offset,
        offset,
      );
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    // Probe only one byte: a growing file must not trigger a larger allocation.
    if ((await handle.read(io.allocate(1), 0, 1, size)).bytesRead)
      throw changed();
    const after = await handle.stat();
    if (
      !after.isFile() ||
      before.size !== after.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw changed();
    return bytes;
  } finally {
    await handle.close();
  }
}

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
