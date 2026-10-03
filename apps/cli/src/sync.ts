import { createHash } from "node:crypto";
import { safeDownloadUrl, type VardConfig } from "./client.js";
import { mimeForFilename } from "@vardum/shared";
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
export type NameSnapshotLockfile = {
  schema: 2;
  server: string;
  workspace: string;
  vard: string;
  items: Record<string, SnapshotItem>;
};
export type Lockfile = Omit<NameSnapshotLockfile, "schema"> & {
  schema: 3;
  delivery: "version-id-v1";
};
export type SnapshotLockfile = NameSnapshotLockfile | Lockfile;
export type AnyLockfile = LegacyLockfile | SnapshotLockfile;
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

/** Schema 2 snapshots retain mutable source names; schema 3 binds only identities. */
export function validateLock(value: unknown, config: VardConfig): AnyLockfile {
  const invalid = () =>
    new Error(
      "Invalid or incomplete .vardum.lock; run vardum pull to refresh a legacy lock, or restore a valid lock from version control",
    );
  if (
    !record(value) ||
    ![1, 2, 3].includes(value.schema as number) ||
    !text(value.vard) ||
    !record(value.items)
  )
    throw invalid();
  if (value.vard !== config.vard)
    throw new Error(".vardum.lock belongs to a different Vard");
  if (
    value.schema !== 1 &&
    (value.server !== config.server || value.workspace !== config.workspace)
  )
    throw new Error(".vardum.lock belongs to a different server or workspace");
  if (value.schema === 3 && value.delivery !== "version-id-v1") throw invalid();
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
    if (value.schema !== 1) {
      if (!text(item.downloadUrl)) throw invalid();
      validateSnapshotUrl(item.downloadUrl, item.versionId, config.server,
        value.schema === 3 ? config.workspace : undefined);
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
  workspaceId?: string,
) {
  const url = safeDownloadUrl(value, server);
  const parts = url.pathname.split("/");
  const identity = workspaceId !== undefined;
  if (identity && (
    parts.length !== 6 || parts[1] !== "w" || parts[2] !== "__id" ||
    parts[3] !== encodeURIComponent(workspaceId) || parts[4] !== "__v" ||
    parts[5] !== encodeURIComponent(versionId)
  )) throw new Error("Invalid identity download URL in snapshot");
  if (
    !identity && (
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
  )
    throw new Error("Invalid immutable download URL in snapshot");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId))
    throw new Error("Invalid version UUID in snapshot");
  if (identity) snapshotTransformation(url);
  return url.href;
}

/** Extract only validated transform intent, never use an obsolete signature as authority. */
export function snapshotTransformation(url: URL): import("@vardum/shared").Transformation | null {
  if (!url.search) return null;
  const result: Record<string, string | number> = {};
  const allowed = ["w", "h", "fit", "format", "q", "sig"];
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1 || !value)
      throw new Error("Invalid transformation query in snapshot");
    if (name === "sig") continue;
    if (["w", "h", "q"].includes(name)) {
      const number = Number(value);
      if (!/^[0-9]+$/.test(value) || !Number.isInteger(number) || number < 1 || number > (name === "q" ? 100 : 4096))
        throw new Error("Invalid transformation query in snapshot");
      result[name] = number;
    } else result[name] = value;
  }
  if (!url.searchParams.has("sig") ||
    (!result.w && !result.h && !result.format) ||
    (result.fit && ((!result.w && !result.h) || !["cover", "contain", "fill", "inside", "outside"].includes(String(result.fit)))) ||
    (result.format && !["avif", "jpeg", "png", "webp"].includes(String(result.format))) ||
    (result.q && !result.format))
    throw new Error("Invalid transformation query in snapshot");
  return result as import("@vardum/shared").Transformation;
}

export function canonicalSnapshotTransformation(input: import("@vardum/shared").Transformation | null) {
  if (!input) return "";
  const query = new URLSearchParams();
  if (input.w) query.set("w", String(input.w));
  if (input.h) query.set("h", String(input.h));
  if (input.w || input.h) query.set("fit", input.fit ?? "inside");
  if (input.format) {
    query.set("format", input.format);
    query.set("q", String(input.q ?? 80));
  }
  return query.toString();
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
