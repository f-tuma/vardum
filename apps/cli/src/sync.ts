import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type LockItem = {
  path: string;
  versionId: string;
  fingerprint: string;
  checksum: string;
};
export type Lockfile = {
  schema: 1;
  vard: string;
  items: Record<string, LockItem>;
};
export type Decision = "skip" | "download" | "upload" | "conflict";

export function pullDecision(
  fingerprint: string,
  localChecksum: string | null,
  locked?: LockItem,
): Decision {
  if (!localChecksum) return "download";
  if (!locked) return "conflict";
  if (localChecksum === locked.checksum)
    return fingerprint === locked.fingerprint ? "skip" : "download";
  return "conflict";
}

export function pushDecision(
  fingerprint: string,
  localChecksum: string,
  locked?: LockItem,
): Decision {
  if (!locked) return "conflict";
  if (fingerprint !== locked.fingerprint) return "conflict";
  return localChecksum === locked.checksum ? "skip" : "upload";
}

export async function findConfig(start = process.cwd()) {
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, "vardum.json");
    try {
      await lstat(candidate);
      return { path: candidate, directory };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("vardum.json not found");
    directory = parent;
  }
}

export async function readLock(path: string): Promise<Lockfile | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Lockfile;
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
  }
}

export async function writeLock(path: string, lock: Lockfile) {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
}

export async function checksumFile(path: string) {
  try {
    return checksum(await readFile(path));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function safeTarget(root: string, outputPath: string) {
  if (isAbsolute(outputPath) || outputPath.includes("\\"))
    throw new Error(`Unsafe output path: ${outputPath}`);
  const projectRoot = await realpath(root);
  const target = resolve(projectRoot, outputPath);
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`))
    throw new Error(`Output escapes project: ${outputPath}`);
  await rejectSymlinkPath(projectRoot, target);
  return target;
}

export async function atomicWrite(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.vardum-${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

export async function removeTracked(path: string, root: string) {
  await rm(path, { force: true });
  let directory = dirname(path);
  const projectRoot = await realpath(root);
  while (
    directory !== projectRoot &&
    directory.startsWith(`${projectRoot}${sep}`)
  ) {
    try {
      await rmdir(directory);
    } catch {
      break;
    }
    directory = dirname(directory);
  }
}

export async function imageFiles(root: string) {
  const base = await realpath(root);
  const files: Array<{ absolute: string; relative: string; mimeType: string }> =
    [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const mimeType = mimeFor(entry.name);
        if (mimeType)
          files.push({
            absolute,
            relative: relative(base, absolute).split(sep).join("/"),
            mimeType,
          });
      }
    }
  }
  await walk(base);
  return files.sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
}

export function mimeFor(filename: string) {
  const extension = filename.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return extension
    ? {
        avif: "image/avif",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        png: "image/png",
        svg: "image/svg+xml",
        webp: "image/webp",
      }[extension]
    : undefined;
}

export function assetPrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "");
  if (value && !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(value))
    throw new Error(`Invalid workspace prefix: ${prefix}`);
  return value ? `${value}/` : "";
}

export function assetKey(prefix: string, path: string) {
  const key = `${assetPrefix(prefix)}${path}`;
  if (
    key.length > 255 ||
    !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(key)
  )
    throw new Error(`Local path is not a valid asset key: ${key}`);
  return key;
}

export function immutableAssetUrl(
  workspaceSlug: string,
  versionId: string,
  key: string,
) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `/w/${encodeURIComponent(workspaceSlug)}/__v/${encodeURIComponent(versionId)}/${encodedKey}`;
}

async function rejectSymlinkPath(root: string, target: string) {
  const parts = relative(root, target).split(sep);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Refusing to write through symlink: ${current}`);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
