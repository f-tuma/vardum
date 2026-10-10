import { createHash } from "node:crypto";
import { safeDownloadUrl, type VardConfig } from "./client.js";
import { mediaStem, mimeForFilename } from "@vardum/shared";
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
export type LegacyLockfile = {
  schema: 1;
  vard: string;
  items: Record<string, LockItem>;
};
export type SnapshotItem = LockItem & { downloadUrl: string };
export type Lockfile = {
  schema: 2;
  server: string;
  workspace: string;
  vard: string;
  items: Record<string, SnapshotItem>;
};
export type AnyLockfile = LegacyLockfile | Lockfile;
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
    if (parent === directory)
      throw new Error(
        "vardum.json not found in this directory or any parent — run vardum init",
      );
    directory = parent;
  }
}

export async function readLock(
  path: string,
  config: VardConfig,
): Promise<AnyLockfile | null> {
  try {
    return validateLock(JSON.parse(await readFile(path, "utf8")), config);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
  }
}

export async function writeLock(
  path: string,
  lock: AnyLockfile,
  config: VardConfig,
) {
  validateLock(lock, config);
  await atomicWrite(path, Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
}

/** Schema 1 can detect conflicts, but only schema 2 is a reproducible snapshot. */
export function validateLock(value: unknown, config: VardConfig): AnyLockfile {
  const invalid = () =>
    new Error(
      "Invalid or incomplete .vardum.lock; run vardum pull to refresh a legacy lock, or restore a valid lock from version control",
    );
  if (
    !record(value) ||
    ![1, 2].includes(value.schema as number) ||
    !text(value.vard) ||
    !record(value.items)
  )
    throw invalid();
  if (value.vard !== config.vard)
    throw new Error(".vardum.lock belongs to a different Vard");
  if (
    value.schema === 2 &&
    (value.server !== config.server || value.workspace !== config.workspace)
  )
    throw new Error(".vardum.lock belongs to a different server or workspace");
  const paths: string[] = [];
  for (const [id, item] of Object.entries(value.items)) {
    if (
      !text(id) ||
      ["__proto__", "constructor", "prototype"].includes(id) ||
      !record(item) ||
      !text(item.path) ||
      !text(item.versionId) ||
      !text(item.fingerprint) ||
      typeof item.checksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.checksum)
    )
      throw invalid();
    paths.push(item.path);
    if (value.schema === 2) {
      if (!text(item.downloadUrl)) throw invalid();
      validateSnapshotUrl(item.downloadUrl, item.versionId, config.server);
    }
  }
  validateOutputPaths(paths);
  return value as AnyLockfile;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

export function validateSnapshotUrl(
  value: string,
  versionId: string,
  server: string,
) {
  const url = safeDownloadUrl(value, server);
  const parts = url.pathname.split("/");
  if (
    parts[1] !== "w" ||
    !parts[2] ||
    parts[3] !== "__v" ||
    parts[4] !== encodeURIComponent(versionId) ||
    parts.length < 6 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      versionId,
    ) ||
    parts.slice(5).some((part) => !/^[a-z0-9][a-z0-9._-]*$/.test(part))
  )
    throw new Error("Invalid immutable download URL in snapshot");
  return url.href;
}

export function validateOutputPaths(paths: string[]) {
  const seen = new Set<string>();
  for (const path of paths) {
    validateOutputPath(path);
    // Match API collision checks across case- and normalization-insensitive filesystems.
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate output path: ${path}`);
    seen.add(key);
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++)
      if (seen.has(parts.slice(0, length).join("/")))
        throw new Error(`Overlapping output path: ${path}`);
  }
}

function validateOutputPath(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    /[\\:\x00-\x1f\x7f]/.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(?:\.git|vardum\.json|\.vardum(?:\..*)?|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:$|\.)/i.test(
            part,
          ),
      )
  )
    throw new Error(`Unsafe output path: ${path}`);
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
  validateOutputPath(outputPath);
  const projectRoot = await realpath(root);
  const target = resolve(projectRoot, outputPath);
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`))
    throw new Error(`Output escapes project: ${outputPath}`);
  await rejectSymlinkPath(projectRoot, target);
  return target;
}

export async function safeLockPath(root: string) {
  const projectRoot = await realpath(root);
  const target = join(projectRoot, ".vardum.lock");
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

/** Every uploadable file below root, with the size the plan shows before pushing. */
export async function imageFiles(root: string) {
  const base = await realpath(root);
  const files: Array<{
    absolute: string;
    relative: string;
    mimeType: string;
    size: number;
  }> = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const mimeType = mimeForFilename(entry.name);
        if (mimeType)
          files.push({
            absolute,
            relative: relative(base, absolute).split(sep).join("/"),
            mimeType,
            size: (await lstat(absolute)).size,
          });
      }
    }
  }
  await walk(base);
  return files.sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
}

export function assetPrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "");
  if (value && !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(value))
    throw new Error(`Invalid workspace prefix: ${prefix}`);
  return value ? `${value}/` : "";
}

export function assetKey(prefix: string, path: string) {
  return validateAssetKey(`${assetPrefix(prefix)}${mediaStem(path)}`);
}

export function folderAssetKey(prefix: string, path: string, existing: ReadonlySet<string>) {
  const stemKey = assetKey(prefix, path);
  const legacyKey = validateAssetKey(`${assetPrefix(prefix)}${path}`);
  if (legacyKey !== stemKey && existing.has(stemKey) && existing.has(legacyKey))
    throw new Error(`Both ${stemKey} and ${legacyKey} exist; choose which asset to keep before pushing`);
  return existing.has(legacyKey) ? legacyKey : stemKey;
}

export function folderAssetDirectories(prefix: string, paths: string[]) {
  return [...new Set(paths.map((path) => {
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    return `${assetPrefix(prefix)}${directory}`;
  }))];
}

function validateAssetKey(key: string) {
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
