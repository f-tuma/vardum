import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VardumHttpError, type FolderVersion, type VardConfig, type VardumClient } from "./client.js";

export const pendingFilename = ".vardum.push.pending.json";
export const mutexFilename = ".vardum.push.mutex";
export type UploadPhase = "planned" | "asset-create-requested" | "asset-created" |
  "version-create-requested" | "version-created" | "upload-requested" | "uploaded" |
  "finalize-requested" | "processing" | "retry-requested" | "ready" | "failed";
const phases: UploadPhase[] = ["planned", "asset-create-requested", "asset-created",
  "version-create-requested", "version-created", "upload-requested", "uploaded",
  "finalize-requested", "processing", "retry-requested", "ready", "failed"];

export type FolderIntent = {
  key: string;
  relative: string;
  filename: string;
  displayName: string;
  checksum: string;
  mimeType: string;
  size: number;
  assetId: string;
  versionId: string;
  expectedCurrentVersionId: string | null;
  createAsset: boolean;
  assetCreated: boolean;
  phase: UploadPhase;
};
export type FolderJournal = {
  schema: 1;
  server: string;
  workspace: string;
  source: string;
  prefix: string;
  files: Record<string, FolderIntent>;
};
export type FolderUploadAction = {
  applied: boolean;
  phase?: UploadPhase;
  assetId?: string;
  versionId?: string;
};
export type FolderJournalContext = Pick<VardConfig, "server" | "workspace"> & {
  source: string;
  prefix: string;
};

const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const missing = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");

/** Read local state without following symlinks or accepting devices/FIFOs. */
export async function readFolderState(path: string): Promise<string | null> {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new Error(`Refusing unsafe folder state file or symlink: ${path}`);
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino)
      throw new Error(`Refusing changed or unsafe folder state file: ${path}`);
    return await handle.readFile("utf8");
  } catch (error) {
    if (missing(error)) return null;
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP")
      throw new Error(`Refusing folder state symlink: ${path}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Private, durable replacement; a request never starts before its intent is synced. */
export async function writeFolderState(path: string, value: unknown) {
  await assertSafeStatePath(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafeStatePath(path);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertSafeStatePath(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error(`Refusing unsafe folder state file or symlink: ${path}`);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function syncDirectory(path: string) {
  // Node cannot open directories for fsync on Windows. File contents are still
  // synced before rename; directory entries are flushed where supported.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    // Windows and some filesystems do not expose directory fsync.
    if (!(error && typeof error === "object" && "code" in error && ["EINVAL", "ENOTSUP", "EBADF"].includes(String(error.code)))) throw error;
  } finally {
    await handle.close();
  }
}

export async function readFolderJournal(path: string, context: FolderJournalContext): Promise<FolderJournal> {
  const raw = await readFolderState(path);
  if (raw === null) return { schema: 1, ...context, files: Object.create(null) };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`Invalid ${pendingFilename}; restore the journal before resuming`); }
  if (!record(value) || value.schema !== 1 || !record(value.files) ||
      Object.keys(value).some((key) => !["schema", "server", "workspace", "source", "prefix", "files"].includes(key)))
    throw new Error(`Invalid ${pendingFilename}; restore the journal before resuming`);
  if (value.server !== context.server || value.workspace !== context.workspace ||
      value.source !== context.source || value.prefix !== context.prefix)
    throw new Error(`${pendingFilename} belongs to a different server, workspace, source directory or prefix; resume the original folder first`);
  for (const [key, file] of Object.entries(value.files)) {
    if (!record(file) || file.key !== key || !text(key) || !text(file.relative) ||
        file.relative.startsWith("/") || file.relative.split("/").some((part) => !part || part === "." || part === "..") ||
        typeof file.filename !== "string" || file.filename !== file.relative.split("/").at(-1) ||
        !text(file.displayName) || typeof file.checksum !== "string" || !/^[a-f0-9]{64}$/.test(file.checksum) ||
        !text(file.mimeType) || !Number.isSafeInteger(file.size) || (file.size as number) <= 0 ||
        !uuid(file.assetId) || !uuid(file.versionId) ||
        !(file.expectedCurrentVersionId === null || uuid(file.expectedCurrentVersionId)) ||
        typeof file.createAsset !== "boolean" || typeof file.assetCreated !== "boolean" ||
        !phases.includes(file.phase as UploadPhase) ||
        Object.keys(file).some((field) => !["key", "relative", "filename", "displayName", "checksum", "mimeType", "size", "assetId", "versionId", "expectedCurrentVersionId", "createAsset", "assetCreated", "phase"].includes(field)))
      throw new Error(`Invalid ${pendingFilename} intent for ${key}; restore the journal before resuming`);
  }
  const journal = value as FolderJournal;
  journal.files = Object.assign(Object.create(null), journal.files);
  return journal;
}

export async function clearFolderJournal(path: string) {
  await assertSafeStatePath(path);
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

/** An abandoned mutex is deliberately not unlinked automatically: stale-lock
 * stealing has a race that can delete a newly acquired lock in another process. */
export async function acquireFolderMutex(root: string) {
  const path = join(await realpath(root), mutexFilename);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "ELOOP"].includes(String(error.code)))) throw error;
    const raw = await readFolderState(path);
    let pid: unknown;
    try { pid = JSON.parse(raw ?? "null")?.pid; } catch { /* Fail closed on an incomplete owner record. */ }
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
      let alive = true;
      try { process.kill(pid, 0); } catch (failure) {
        if (failure && typeof failure === "object" && "code" in failure && failure.code === "ESRCH") alive = false;
      }
      if (!alive) throw new Error(`An interrupted folder push left ${mutexFilename} (PID ${pid}); remove that mutex after confirming no folder push is running, then rerun the same command. Keep ${pendingFilename}`);
    }
    throw new Error(`Another folder push owns ${mutexFilename}; wait for it to finish before retrying`);
  }
  const owner = await handle.stat();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  return async () => {
    await handle.close();
    const current = await lstat(path).catch((error) => { if (missing(error)) return null; throw error; });
    if (current?.dev === owner.dev && current?.ino === owner.ino) await rm(path);
  };
}

function verifyVersion(version: FolderVersion, file: FolderIntent, exact = true) {
  if (exact && version.id !== file.versionId) throw new Error(`Server returned a different version for ${file.key}`);
  if (version.filename !== file.filename || version.mimeType !== file.mimeType || version.size !== file.size ||
      (version.status === "ready" ? version.checksum !== file.checksum : version.expectedChecksum !== file.checksum))
    throw new Error(`Upload metadata or checksum differs for ${file.key}; keep the pending journal and resolve the remote version before retrying`);
}

function expiredUpload(file: FolderIntent) {
  return new Error(`Upload ${file.key} expired; inspect asset ${file.assetId} / version ${file.versionId} on the server. After explicitly resolving that version, archive ${pendingFilename} and run the folder push again to start a new upload`);
}

async function exactVersion(client: VardumClient, workspace: string, file: FolderIntent) {
  try {
    const version = await client.folderVersion(workspace, file.assetId, file.versionId);
    verifyVersion(version, file);
    return version;
  } catch (error) {
    if (error instanceof VardumHttpError && error.status === 404) return null;
    throw error;
  }
}

/** Carry one durable intent to processing; ready checks are shared with polling. */
export async function resumeFolderUpload(
  client: VardumClient,
  workspace: string,
  file: FolderIntent,
  bytes: Uint8Array,
  save: () => Promise<void>,
  action: FolderUploadAction,
) {
  const phase = async (next: UploadPhase) => {
    file.phase = next;
    Object.assign(action, { phase: next, assetId: file.assetId, versionId: file.versionId, applied: next === "ready" });
    await save();
  };
  Object.assign(action, { phase: file.phase, assetId: file.assetId, versionId: file.versionId });
  if (file.createAsset && !file.assetCreated) {
    await phase("asset-create-requested");
    let asset;
    try { asset = await client.createAsset(workspace, file.key, file.displayName, file.assetId); }
    catch (error) {
      if (error instanceof VardumHttpError && error.status === 409)
        throw new Error(`Asset identity conflict for ${file.key}: ${error.message}. Inspect that key on the server before changing ${pendingFilename}; archive the journal only after confirming the intended asset, then rerun the folder push to plan against its current identity`);
      throw error;
    }
    if (asset.id !== file.assetId || asset.key !== file.key)
      throw new Error(`Server returned a different asset identity for ${file.key}`);
    file.assetCreated = true;
    await phase("asset-created");
  }
  let version = await exactVersion(client, workspace, file);
  if (version?.status === "pending" && (!version.expiresAt || Date.parse(version.expiresAt) <= Date.now()))
    throw expiredUpload(file);
  if (!version && ["version-created", "upload-requested", "uploaded", "finalize-requested", "processing", "retry-requested", "ready", "failed"].includes(file.phase))
    throw new Error(`Previously accepted version ${file.versionId} is missing for ${file.key}; inspect this asset on the server before changing the pending journal`);
  if (!version || version.status === "pending" && !["uploaded", "finalize-requested"].includes(file.phase)) {
    await phase("version-create-requested");
    version = await client.createFolderVersion(workspace, file.assetId, {
      id: file.versionId,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      expectedChecksum: file.checksum,
      expectedCurrentVersionId: file.expectedCurrentVersionId,
    });
    verifyVersion(version, file, false);
    file.versionId = version.id; // The server may adopt an identical active/ready version.
    await phase(version.status === "pending" ? "version-created" : version.status);
  }
  if (version.status === "ready") { await phase("ready"); return; }
  if (version.status === "failed") {
    await phase("failed");
    if (!version.retryable)
      throw new Error(`Upload ${file.key} failed and cannot be resumed${version.error ? `: ${version.error}` : ""}; inspect asset ${file.assetId} / version ${file.versionId} on the server. After explicitly resolving that version, archive ${pendingFilename} and run the folder push again to start a new upload`);
    await phase("retry-requested");
    await client.retryVersion(workspace, file.assetId, file.versionId);
    await phase("processing");
    return;
  }
  if (version.status === "processing") { await phase("processing"); return; }
  if (!version.expiresAt || Date.parse(version.expiresAt) <= Date.now())
    throw expiredUpload(file);
  if (!["uploaded", "finalize-requested"].includes(file.phase)) {
    if (!version.upload) throw new Error(`Server did not provide a pending upload for ${file.key}`);
    await phase("upload-requested");
    await client.storeVersion(version.upload, file.filename, file.mimeType, bytes);
    await phase("uploaded");
  }
  await phase("finalize-requested");
  try {
    await client.finalizeVersion(workspace, file.assetId, file.versionId);
  } catch (error) {
    // Storage can acknowledge a POST and still lose the object. Only a specific
    // missing-object response permits replacement, after another exact check.
    if (!(error instanceof VardumHttpError && error.status === 409 && /^Upload not found(?: |\()/i.test(error.message))) throw error;
    const exact = await exactVersion(client, workspace, file);
    if (!exact || exact.status !== "pending") throw error;
    version = await client.createFolderVersion(workspace, file.assetId, {
      id: file.versionId, filename: file.filename, mimeType: file.mimeType,
      size: file.size, expectedChecksum: file.checksum, expectedCurrentVersionId: file.expectedCurrentVersionId,
    });
    verifyVersion(version, file);
    if (version.status !== "pending" || !version.upload) throw error;
    await phase("upload-requested");
    await client.storeVersion(version.upload, file.filename, file.mimeType, bytes);
    await phase("uploaded");
    await phase("finalize-requested");
    await client.finalizeVersion(workspace, file.assetId, file.versionId);
  }
  await phase("processing");
  const finalized = await exactVersion(client, workspace, file);
  if (!finalized) throw new Error(`Uploaded version ${file.versionId} is missing for ${file.key}; keep the pending journal before retrying`);
  if (finalized.status === "ready") await phase("ready");
}

/** Poll exact IDs: a concurrent newer current version cannot hide completion. */
export async function waitForFolderUploads(
  client: VardumClient,
  workspace: string,
  files: Array<{ file: FolderIntent; action: FolderUploadAction }>,
  save: () => Promise<void>,
) {
  const waiting = files.filter(({ file }) => file.phase !== "ready");
  for (let attempt = 0; attempt < 120 && waiting.length; attempt++) {
    for (let index = waiting.length - 1; index >= 0; index--) {
      const { file, action } = waiting[index]!;
      const version = await exactVersion(client, workspace, file);
      if (!version) throw new Error(`Uploaded version ${file.versionId} is missing for ${file.key}; keep the pending journal before retrying`);
      const nextPhase = version.status === "pending" ? "version-created" : version.status;
      const phaseChanged = file.phase !== nextPhase;
      file.phase = nextPhase;
      Object.assign(action, { phase: file.phase, assetId: file.assetId, versionId: file.versionId, applied: file.phase === "ready" });
      if (phaseChanged) await save();
      if (version.status === "ready") waiting.splice(index, 1);
      else if (version.status === "failed")
        throw new Error(`Upload ${file.key} failed${version.error ? `: ${version.error}` : ""}; rerun the same command${version.retryable ? " to retry this version" : ` after resolving version ${file.versionId}`}`);
    }
    if (waiting.length) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (waiting.length)
    throw new Error(`Timed out waiting for asset processing: ${waiting.map(({ file }) => file.key).join(", ")}; rerun the same command to resume`);
}
