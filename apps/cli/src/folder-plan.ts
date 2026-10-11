import type { UploadLimits } from "@vardum/shared";
import type { AssetIdentity, SyncAsset, VardumClient } from "./client.js";
import type { FolderJournal } from "./folder-upload.js";
import { pendingFilename } from "./folder-upload.js";
import { assetKey, assetPrefix, checksum, folderAssetDirectories, folderAssetKey } from "./sync.js";
import { assertUploadFileSnapshot, captureUploadFile, type UploadFileSnapshot } from "./upload-file.js";

export type FolderSource = { absolute: string; relative: string; mimeType: string; size: number };
export type FolderSourceCache = Map<string, { checksum: string; size: number; snapshot: UploadFileSnapshot }>;
export type FolderPlanRow = FolderSource & {
  source: string;
  key: string;
  checksum: string;
  libraryAction: "new" | "update" | "skip";
  notice?: string;
  uncertain?: boolean;
  resumed?: boolean;
};
export type FolderPlanPreview = {
  prefix: string;
  rows: FolderPlanRow[];
  bytes: number;
};
export type FolderPlan = FolderPlanPreview & {
  limits: UploadLimits;
  byKey: Map<string, SyncAsset>;
  identityByKey: Map<string, AssetIdentity>;
  resolvedKeys: Set<string>;
  captures: FolderSourceCache;
};

async function folderTargets(client: VardumClient, workspace: string, prefix: string, files: FolderSource[]) {
  const identities = await client.assetIdentities(workspace, folderAssetDirectories(prefix, files.map((file) => file.relative)));
  // Read the current versions after identities, so a version change observed
  // during identity lookup cannot leave the ready-only snapshot stale.
  const remote = await client.syncAssets(workspace, prefix);
  return {
    byKey: new Map(remote.assets.map((asset) => [asset.key, asset])),
    identityByKey: new Map(identities.map((asset) => [asset.key, asset])),
  };
}

/** One bounded read per source. Only hashes and metadata survive preflight. */
export async function prepareFolderPlan(
  client: VardumClient, workspace: string, inputPrefix: string,
  files: FolderSource[], journal: FolderJournal, requireResumeMetadata: boolean,
  captures: FolderSourceCache = new Map(),
): Promise<FolderPlan> {
  const prefix = assetPrefix(inputPrefix);
  const { byKey, identityByKey } = await folderTargets(client, workspace, prefix, files);
  if (requireResumeMetadata && [...identityByKey.values()].some((identity) => typeof identity.hasUnfinishedUploads !== "boolean"))
    throw new Error("Vardum returned an invalid resumable asset identity response (missing hasUnfinishedUploads)");
  const existingKeys = new Set([...identityByKey.keys(), ...Object.keys(journal.files)]);
  const limits = await client.uploadLimits();
  const rows: FolderPlanRow[] = [];
  const stems = new Set<string>();
  const resolvedKeys = new Set<string>();
  for (const file of files) {
    const stem = assetKey(prefix, file.relative);
    if (stems.has(stem)) throw new Error(`Files normalize to the same asset key: ${stem}`);
    stems.add(stem);
    const key = folderAssetKey(prefix, file.relative, existingKeys);
    if (resolvedKeys.has(key)) throw new Error(`Files resolve to the same asset key: ${key}`);
    resolvedKeys.add(key);
    const current = byKey.get(key);
    const identity = identityByKey.get(key);
    if (current && (!identity || identity.id !== current.id))
      throw new Error(`${key} changed asset identity during the folder plan; rerun the command after inspecting that key on the server`);
    let capture = captures.get(file.absolute);
    if (!capture) {
      const { bytes, snapshot } = await captureUploadFile(file.absolute, file.mimeType, limits);
      capture = { checksum: checksum(bytes), size: bytes.byteLength, snapshot };
      captures.set(file.absolute, capture);
    }
    const { checksum: hash, size } = capture;
    const pending = journal.files[key];
    if (pending && (pending.relative !== file.relative || pending.checksum !== hash ||
        pending.mimeType !== file.mimeType || pending.size !== size))
      throw new Error(`${file.relative} differs from the pending upload; restore its original bytes before resuming ${pendingFilename}`);
    if (pending && identity && pending.assetId !== identity.id)
      throw new Error(`${key} has a different remote asset identity; keep the pending journal and resolve the conflict before retrying`);
    const unchanged = !pending && current?.checksum === hash && current.mimeType === file.mimeType &&
      current.size === size && identity?.hasUnfinishedUploads !== true &&
      identity?.status !== "pending" && identity?.status !== "processing";
    rows.push({ ...file, source: file.relative, key, checksum: hash, size,
      libraryAction: pending ? (pending.createAsset ? "new" : "update") : unchanged ? "skip" : identity ? "update" : "new",
      ...(pending ? { resumed: true } : {}),
      ...(identity && typeof identity.hasUnfinishedUploads !== "boolean" ? { uncertain: true } : {}),
      ...(key !== stem ? { notice: `Preserving existing filename key ${key} and its asset identity` } :
        identity ? { notice: `Reusing existing asset ${key}; no separate filename asset is created` } : {}),
    });
  }
  for (const pending of Object.values(journal.files))
    if (!resolvedKeys.has(pending.key))
      throw new Error(`${pending.relative} is missing from the pending folder upload; restore it before resuming ${pendingFilename}`);
  return { prefix, rows, bytes: rows.reduce((total, row) => total + row.size, 0), limits, byKey, identityByKey, resolvedKeys, captures };
}

export async function assertFolderSourcesCurrent(plan: FolderPlan) {
  for (const row of plan.rows)
    await assertUploadFileSnapshot(row.absolute, plan.captures.get(row.absolute)!.snapshot);
}

/** A confirmed plan must not silently target a different identity or version. */
export async function assertFolderPlanCurrent(client: VardumClient, workspace: string, plan: FolderPlan, journal: FolderJournal) {
  const refreshed = await folderTargets(client, workspace, plan.prefix, plan.rows);
  const keys = new Set([...refreshed.identityByKey.keys(), ...Object.keys(journal.files)]);
  const snapshot = (targets: Pick<FolderPlan, "byKey" | "identityByKey">, key: string) => {
    const current = targets.byKey.get(key);
    const identity = targets.identityByKey.get(key);
    return JSON.stringify([identity?.id, identity?.latestVersionId, identity?.status, identity?.hasUnfinishedUploads,
      current?.id, current?.versionId, current?.checksum, current?.mimeType, current?.size]);
  };
  for (const row of plan.rows)
    if (folderAssetKey(plan.prefix, row.relative, keys) !== row.key || snapshot(refreshed, row.key) !== snapshot(plan, row.key))
      throw new Error(`${row.key} changed during the folder plan; rerun the command after inspecting that key on the server`);
}
