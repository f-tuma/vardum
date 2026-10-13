import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm, link } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AdoptionSizeMismatchError } from "./client.js";
import type { VardumClient, VardConfig, ManifestItem } from "./client.js";
import { readLock, safeLockPath, safeTarget, validateLock, validateOutputPaths, validateSnapshotUrl, type Lockfile } from "./sync.js";

type Identity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
type Capture = { path: string; identity: Identity; checksum: string; size: number; text?: string; parents: Array<{ path: string; dev: bigint; ino: bigint }> };
export type AdoptionAction = { action: "adopt" | "pull"; path: string; decision: "adopt" | "download" | "conflict"; applied: boolean; conflict?: boolean };
type Context = { directory: string; path: string; config: VardConfig; client: VardumClient };
type Item = Pick<ManifestItem, "id" | "outputPath" | "versionId" | "fingerprint" | "downloadUrl">;
const changed = (path: string) => new Error(`File changed while verifying adoption: ${path}; rerun after local edits stop`);
const missing = (e: unknown) => Boolean(e && typeof e === "object" && "code" in e && e.code === "ENOENT");
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Current CLI file/snapshot writers cooperate; older clients and editors do not. */
export async function withSnapshotMutex<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const root = await realpath(directory);
  const path = join(root, ".vardum.snapshot.mutex");
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
      throw new Error("Another Vardum file operation is running. If it stopped unexpectedly, confirm that process is stopped before removing .vardum.snapshot.mutex.");
    throw error;
  }
  const identity = await handle.stat({ bigint: true });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
    return await operation();
  } finally {
    await handle.close();
    try {
      const now = await lstat(path, { bigint: true });
      if (!now.isSymbolicLink() && identity.dev === now.dev && identity.ino === now.ino) await rm(path);
    } catch (error) { if (!missing(error)) throw error; }
  }
}

async function parents(root: string, path: string) {
  const chain: Capture["parents"] = [];
  let current = root;
  const names = relative(root, dirname(path)).split(sep).filter(Boolean);
  for (const name of ["", ...names]) {
    if (name) current = join(current, name);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe adoption parent: ${current}`);
    chain.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return chain;
}

async function capture(root: string, path: string, includeText = false): Promise<Capture | null> {
  const parentChain = await parents(root, path);
  let before;
  try { before = await lstat(path, { bigint: true }); } catch (error) { if (missing(error)) return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Adoption requires a regular file: ${path}`);
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || includeText && before.size > 4n * 1024n * 1024n)
    throw new Error(`Adoption file exceeds supported size: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) throw changed(path);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > Number(opened.size)) throw changed(path);
      hash.update(buffer.subarray(0, bytesRead));
      if (includeText) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (total !== Number(opened.size) || !sameIdentity(opened, await handle.stat({ bigint: true }))) throw changed(path);
    const result: Capture = { path, identity: opened, checksum: hash.digest("hex"), size: total, parents: parentChain };
    if (includeText) result.text = Buffer.concat(chunks).toString("utf8");
    await assertParents(result);
    if (!sameIdentity(opened, await lstat(path, { bigint: true }))) throw changed(path);
    return result;
  } finally { await handle.close(); }
}

async function assertParents(file: Capture) {
  for (const parent of file.parents) {
    const stat = await lstat(parent.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parent.dev || stat.ino !== parent.ino) throw changed(file.path);
  }
}

async function assertCurrent(root: string, before: Capture) {
  await assertParents(before);
  const now = await capture(root, before.path);
  if (!now || !sameIdentity(before.identity, now.identity) || before.checksum !== now.checksum) throw changed(before.path);
}

/** A lock-only opt-in: no asset replacements, and no latest re-resolution at commit. */
export async function adoptExistingOutputs(
  context: Context,
  dryRun: boolean,
  parseConfig: (value: unknown) => VardConfig,
  report: (entry: AdoptionAction) => void,
) {
  const root = await realpath(context.directory);
  const configPath = resolve(root, "vardum.json");
  const configuration = await capture(root, configPath, true);
  if (!configuration || JSON.stringify(parseConfig(JSON.parse(configuration.text!))) !== JSON.stringify(context.config))
    throw new Error("vardum.json changed while loading the project; rerun adoption");
  const lockPath = await safeLockPath(root);
  const capturedLock = await capture(root, lockPath, true);
  const previous = capturedLock ? validateLock(JSON.parse(capturedLock.text!), context.config) : null;
  // Preserve the regular reader's schema/identity checks, without writing anything.
  if (!capturedLock && await readLock(lockPath, context.config)) throw changed(lockPath);
  const manifest = await context.client.manifest(context.config);
  if (manifest.schema !== 1 || manifest.id !== context.config.vard || manifest.workspaceId !== context.config.workspace)
    throw new Error("Server returned a different or unsupported Vard manifest");
  if (!Array.isArray(manifest.items) || manifest.items.length > 1000)
    throw new Error("Invalid or oversized Vard manifest");
  const items: Item[] = manifest.items.map(({ id, outputPath, versionId, fingerprint, downloadUrl }) =>
    ({ id, outputPath, versionId, fingerprint, downloadUrl }));
  validateOutputPaths(items.map(item => item.outputPath));
  if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => !item.id || ["__proto__", "constructor", "prototype"].includes(item.id)))
    throw new Error("Invalid or duplicate Vard output IDs");
  const captures = new Map<string, Capture | null>();
  for (const item of items) {
    if (!item.versionId || !item.fingerprint || !item.downloadUrl) throw new Error(`Vard output is unavailable: ${item.outputPath}`);
    validateSnapshotUrl(item.downloadUrl, item.versionId, context.config.server);
    const target = await safeTarget(root, item.outputPath);
    // Missing parents count as a download plan; no directory is created.
    try { captures.set(item.id, await capture(root, target)); }
    catch (error) { if (!missing(error)) throw error; captures.set(item.id, null); }
  }
  const next: Lockfile = { schema: 2, server: context.config.server, workspace: context.config.workspace, vard: context.config.vard, items: Object.create(null) };
  const entries: AdoptionAction[] = [];
  for (const item of items) {
    const file = captures.get(item.id)!;
    const locked = previous?.items[item.id]?.path === item.outputPath ? previous.items[item.id] : undefined;
    let decision: AdoptionAction["decision"] | "skip";
    if (!file) decision = "download";
    else {
      let remoteChecksum: string | null = null;
      try { remoteChecksum = (await context.client.downloadChecksum(item.downloadUrl!, file.size)).checksum; }
      catch (error) { if (!(error instanceof AdoptionSizeMismatchError)) throw error; }
      if (locked && file.checksum !== locked.checksum) decision = "conflict";
      else if (remoteChecksum !== file.checksum) decision = locked ? "download" : "conflict";
      else decision = locked && locked.versionId === item.versionId && locked.fingerprint === item.fingerprint && previous?.schema === 2 && previous.items[item.id]!.downloadUrl === validateSnapshotUrl(item.downloadUrl!, item.versionId!, context.config.server) ? "skip" : "adopt";
      next.items[item.id] = { path: item.outputPath, versionId: item.versionId!, fingerprint: item.fingerprint!, downloadUrl: validateSnapshotUrl(item.downloadUrl!, item.versionId!, context.config.server), checksum: file.checksum };
    }
    if (decision !== "skip") {
      const entry: AdoptionAction = { action: decision === "adopt" ? "adopt" : "pull", path: item.outputPath, decision, applied: false };
      if (decision === "conflict") entry.conflict = true;
      entries.push(entry); report(entry);
    }
  }
  async function revalidate() {
    if (await realpath(context.directory) !== root) throw changed(context.directory);
    await assertCurrent(root, configuration!);
    if (capturedLock) await assertCurrent(root, capturedLock);
    else if (await capture(root, lockPath)) throw changed(lockPath);
    for (const item of items) {
      const before = captures.get(item.id);
      await safeTarget(root, item.outputPath);
      if (before) await assertCurrent(root, before);
      else {
        let now = null;
        try { now = await capture(root, resolve(root, item.outputPath)); } catch (error) { if (!missing(error)) throw error; }
        if (now) throw changed(item.outputPath);
      }
    }
  }
  await revalidate();
  const ready = entries.every(entry => entry.decision === "adopt");
  const snapshotChanged = capturedLock?.text !== `${JSON.stringify(next, null, 2)}\n`;
  if (dryRun) return { changed: entries.length, snapshotChanged, ready, applied: false };
  const refused = entries.filter(entry => entry.decision !== "adopt");
  if (refused.length) throw new Error(`Adoption only records a snapshot of matching files. Supply missing or updated files and resolve conflicts first: ${refused.map(entry => `${entry.path} (${entry.decision})`).join(", ")}`);
  validateLock(next, context.config);
  if (!snapshotChanged) return { changed: entries.length, snapshotChanged: false, ready, applied: false };
  const temporary = join(root, `.vardum.adopt-${randomUUID()}.tmp`);
  try {
    await open(temporary, "wx", 0o600).then(async handle => {
      try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
    });
    await revalidate();
    if (capturedLock) await rename(temporary, lockPath);
    else await link(temporary, lockPath); // Absent lock publication must not replace a concurrently created lock.
    for (const entry of entries) entry.applied = true;
  } finally { await rm(temporary, { force: true }); }
  return { changed: entries.length, snapshotChanged, ready, applied: true };
}
