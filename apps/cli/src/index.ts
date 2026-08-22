#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { VardumClient, type Manifest, type VardConfig } from "./client.js";
import {
  assetKey,
  atomicWrite,
  checksum,
  checksumFile,
  findConfig,
  imageFiles,
  immutableAssetUrl,
  mimeFor,
  pullDecision,
  pushDecision,
  readLock,
  removeTracked,
  safeTarget,
  writeLock,
  type Lockfile,
} from "./sync.js";

type Options = {
  dryRun: boolean;
  delete: boolean;
  force: boolean;
  values: Map<string, string>;
  positionals: string[];
};
type PushLock = {
  schema: 1;
  workspace: string;
  entries: Record<
    string,
    { directory: string; prefix: string; assets: Record<string, string> }
  >;
};

const [command = "help", ...rawArgs] = process.argv.slice(2);

try {
  const options = parseOptions(rawArgs);
  if (command === "init") await init(options);
  else if (command === "pull" || command === "sync") await pull(options);
  else if (command === "push") await push(options);
  else if (command === "push-folder") await pushFolder(options);
  else if (command === "pull-asset") await pullAsset(options);
  else if (command === "help" || command === "--help" || command === "-h")
    help();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(
    `vardum: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

async function init(options: Options) {
  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    const server =
      options.values.get("server") ?? (await prompts.question("Vardum URL: "));
    const workspace =
      options.values.get("workspace") ??
      (await prompts.question("Workspace ID: "));
    const vard =
      options.values.get("vard") ?? (await prompts.question("Vard ID: "));
    const config = validateConfig({ schema: 1, server, workspace, vard });
    const path = resolve("vardum.json");
    if ((await checksumFile(path)) && !options.force)
      throw new Error("vardum.json already exists; use --force to replace it");
    await atomicWrite(
      path,
      Buffer.from(`${JSON.stringify(config, null, 2)}\n`),
    );
    console.log(`created ${relative(process.cwd(), path) || "vardum.json"}`);
  } finally {
    prompts.close();
  }
}

async function pull(options: Options) {
  const context = await loadContext();
  const manifest = await context.client.manifest(context.config);
  assertManifest(manifest, context.config);
  const lockPath = join(context.directory, ".vardum.lock");
  const previous = await readLock(lockPath);
  if (previous && previous.vard !== manifest.id)
    throw new Error(".vardum.lock belongs to a different Vard");

  const planned = [] as Array<{
    item: Manifest["items"][number];
    target: string;
    localChecksum: string | null;
    decision: ReturnType<typeof pullDecision>;
  }>;
  for (const item of manifest.items) {
    if (!item.versionId || !item.fingerprint || !item.downloadUrl)
      throw new Error(`Vard output is unavailable: ${item.outputPath}`);
    const target = await safeTarget(context.directory, item.outputPath);
    const localChecksum = await checksumFile(target);
    planned.push({
      item,
      target,
      localChecksum,
      decision: pullDecision(
        item.fingerprint,
        localChecksum,
        previous?.items[item.id],
      ),
    });
  }

  const stale = Object.entries(previous?.items ?? {}).filter(
    ([id, locked]) =>
      !manifest.items.some(
        (item) => item.id === id && item.outputPath === locked.path,
      ),
  );
  const conflicts = planned.filter(({ decision }) => decision === "conflict");
  if (conflicts.length && !options.force)
    throw new Error(
      `Local changes would be overwritten: ${conflicts.map(({ item }) => item.outputPath).join(", ")}. Use --force to pull anyway.`,
    );
  if (options.delete && !options.force) {
    const modifiedStale = [] as string[];
    for (const [, locked] of stale) {
      const target = await safeTarget(context.directory, locked.path);
      const local = await checksumFile(target);
      if (local && local !== locked.checksum) modifiedStale.push(locked.path);
    }
    if (modifiedStale.length)
      throw new Error(
        `Tracked files were modified and cannot be deleted: ${modifiedStale.join(", ")}. Use --force to delete them.`,
      );
  }

  const next: Lockfile = { schema: 1, vard: manifest.id, items: {} };
  for (const plan of planned) {
    let localChecksum = plan.localChecksum;
    if (plan.decision !== "skip") {
      console.log(
        `${options.dryRun ? "would pull" : "pull"} ${plan.item.outputPath}`,
      );
      if (!options.dryRun) {
        const bytes = await context.client.download(plan.item.downloadUrl!);
        await atomicWrite(plan.target, bytes);
        localChecksum = checksum(bytes);
      }
    }
    if (!localChecksum && options.dryRun) continue;
    next.items[plan.item.id] = {
      path: plan.item.outputPath,
      versionId: plan.item.versionId!,
      fingerprint: plan.item.fingerprint!,
      checksum: localChecksum!,
    };
  }

  if (options.delete)
    for (const [, locked] of stale) {
      console.log(
        `${options.dryRun ? "would delete" : "delete"} ${locked.path}`,
      );
      if (!options.dryRun)
        await removeTracked(
          await safeTarget(context.directory, locked.path),
          context.directory,
        );
    }
  if (!options.dryRun) await writeLock(lockPath, next);
  summary(
    options,
    planned.filter(({ decision }) => decision !== "skip").length +
      (options.delete ? stale.length : 0),
  );
}

async function push(options: Options) {
  requireApiKey();
  const context = await loadContext();
  let manifest = await context.client.manifest(context.config, true);
  assertManifest(manifest, context.config);
  const lockPath = join(context.directory, ".vardum.lock");
  const lock = await readLock(lockPath);
  if (!lock || lock.vard !== manifest.id)
    throw new Error("Run vardum pull before pushing mapped outputs");

  const writable = manifest.items.filter((item) => item.writable);
  let changed = 0;
  for (const item of writable) {
    if (!item.versionId || !item.fingerprint)
      throw new Error(`Vard output is unavailable: ${item.outputPath}`);
    const path = await safeTarget(context.directory, item.outputPath);
    const localChecksum = await checksumFile(path);
    if (!localChecksum)
      throw new Error(`Writable output is missing: ${item.outputPath}`);
    const decision = pushDecision(
      item.fingerprint,
      localChecksum,
      lock.items[item.id],
    );
    if (decision === "skip") continue;
    if (decision === "conflict" && !options.force)
      throw new Error(
        `Remote and local state diverged for ${item.outputPath}; pull first or use --force`,
      );
    console.log(`${options.dryRun ? "would push" : "push"} ${item.outputPath}`);
    changed += 1;
    if (options.dryRun) continue;
    const bytes = await readFile(path);
    const mimeType = mimeFor(path);
    if (!mimeType)
      throw new Error(`Unsupported image type: ${item.outputPath}`);
    const previousVersion = item.versionId;
    await context.client.uploadVersion(
      context.config.workspace,
      item.assetId,
      basename(path),
      mimeType,
      bytes,
    );
    manifest = await waitForManifestVersion(
      context.client,
      context.config,
      item.id,
      previousVersion,
    );
    const updated = manifest.items.find(({ id }) => id === item.id);
    if (!updated?.versionId || !updated.fingerprint)
      throw new Error(
        `Uploaded output did not become ready: ${item.outputPath}`,
      );
    lock.items[item.id] = {
      path: item.outputPath,
      versionId: updated.versionId,
      fingerprint: updated.fingerprint,
      checksum: localChecksum,
    };
    await writeLock(lockPath, lock);
  }
  summary(options, changed);
}

async function pushFolder(options: Options) {
  requireApiKey();
  const [source, prefix = ""] = options.positionals;
  if (!source)
    throw new Error("Usage: vardum push-folder <directory> [prefix]");
  const context = await loadContext();
  const directory = resolve(source);
  const files = await imageFiles(directory);
  const remote = await context.client.syncAssets(
    context.config.workspace,
    prefix,
  );
  const byKey = new Map(remote.assets.map((asset) => [asset.key, asset]));
  const local = [] as Array<{
    key: string;
    absolute: string;
    relative: string;
    mimeType: string;
    checksum: string;
  }>;
  for (const file of files)
    local.push({
      ...file,
      key: assetKey(prefix, file.relative),
      checksum: (await checksumFile(file.absolute))!,
    });

  const pushLockPath = join(context.directory, ".vardum.push.lock");
  const pushLock = await readPushLock(pushLockPath, context.config.workspace);
  const lockKey = `${relative(context.directory, directory) || "."}:${prefix}`;
  const previous = pushLock.entries[lockKey]?.assets ?? {};
  const currentAssets: Record<string, string> = {};
  let changed = 0;
  for (const file of local) {
    const existing = byKey.get(file.key);
    if (existing?.checksum === file.checksum) {
      currentAssets[file.key] = existing.id;
      continue;
    }
    console.log(`${options.dryRun ? "would push" : "push"} ${file.key}`);
    changed += 1;
    if (options.dryRun) continue;
    const target =
      existing ??
      (await context.client.createAsset(
        context.config.workspace,
        file.key,
        basename(file.relative),
      ));
    const versionId = await context.client.uploadVersion(
      context.config.workspace,
      target.id,
      basename(file.relative),
      file.mimeType,
      await readFile(file.absolute),
    );
    await waitForAssetVersion(
      context.client,
      context.config.workspace,
      file.key,
      versionId,
    );
    currentAssets[file.key] = target.id;
  }

  if (options.delete)
    for (const [key, assetId] of Object.entries(previous)) {
      if (local.some((file) => file.key === key)) continue;
      console.log(`${options.dryRun ? "would delete" : "delete"} ${key}`);
      changed += 1;
      if (!options.dryRun)
        await context.client.deleteAsset(context.config.workspace, assetId);
    }
  if (!options.dryRun) {
    pushLock.entries[lockKey] = {
      directory: relative(context.directory, directory) || ".",
      prefix,
      assets: currentAssets,
    };
    await atomicWrite(
      pushLockPath,
      Buffer.from(`${JSON.stringify(pushLock, null, 2)}\n`),
    );
  }
  summary(options, changed);
}

async function pullAsset(options: Options) {
  const [key, output] = options.positionals;
  if (!key || !output)
    throw new Error("Usage: vardum pull-asset <asset-key> <output-path>");
  const context = await loadContext();
  const prefix = key.includes("/") ? `${dirname(key)}/` : "";
  const remote = await context.client.syncAssets(
    context.config.workspace,
    prefix,
  );
  const asset = remote.assets.find((candidate) => candidate.key === key);
  if (!asset) throw new Error(`Asset not found: ${key}`);
  const target = await safeTarget(context.directory, output);
  const localChecksum = await checksumFile(target);
  if (localChecksum && localChecksum !== asset.checksum && !options.force)
    throw new Error(`${output} already exists; use --force to replace it`);
  if (localChecksum === asset.checksum) return summary(options, 0);
  console.log(`${options.dryRun ? "would pull" : "pull"} ${key} -> ${output}`);
  if (!options.dryRun) {
    const bytes = await context.client.download(
      immutableAssetUrl(remote.workspaceSlug, asset.versionId, asset.key),
    );
    await atomicWrite(target, bytes);
  }
  summary(options, 1);
}

async function loadContext() {
  const found = await findConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(found.path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read vardum.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = validateConfig(raw);
  return {
    ...found,
    config,
    client: new VardumClient(config.server),
  };
}

function validateConfig(value: unknown): VardConfig {
  if (!value || typeof value !== "object")
    throw new Error("vardum.json must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.schema !== 1 ||
    typeof input.server !== "string" ||
    typeof input.workspace !== "string" ||
    typeof input.vard !== "string" ||
    !input.workspace ||
    !input.vard
  )
    throw new Error("vardum.json requires schema, server, workspace and vard");
  let server: URL;
  try {
    server = new URL(input.server);
  } catch {
    throw new Error("vardum.json server is not a valid URL");
  }
  if (
    !["http:", "https:"].includes(server.protocol) ||
    server.username ||
    server.password
  )
    throw new Error("vardum.json server must be HTTP(S) without credentials");
  return {
    schema: 1,
    server: server.toString().replace(/\/$/, ""),
    workspace: input.workspace,
    vard: input.vard,
  };
}

function assertManifest(manifest: Manifest, config: VardConfig) {
  if (manifest.schema !== 1 || manifest.id !== config.vard)
    throw new Error("Server returned a different or unsupported Vard manifest");
  if (manifest.workspaceId !== config.workspace)
    throw new Error("Vard does not belong to the configured workspace");
}

async function waitForAssetVersion(
  client: VardumClient,
  workspaceId: string,
  key: string,
  versionId: string,
) {
  const prefix = key.includes("/") ? `${dirname(key)}/` : "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const listing = await client.syncAssets(workspaceId, prefix);
    if (
      listing.assets.some(
        (asset) => asset.key === key && asset.versionId === versionId,
      )
    )
      return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for asset processing: ${key}`);
}

async function waitForManifestVersion(
  client: VardumClient,
  config: VardConfig,
  itemId: string,
  previousVersion: string,
) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const manifest = await client.manifest(config, true);
    const item = manifest.items.find(({ id }) => id === itemId);
    if (item?.versionId && item.versionId !== previousVersion) return manifest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("Timed out waiting for uploaded asset processing");
}

async function readPushLock(
  path: string,
  workspace: string,
): Promise<PushLock> {
  try {
    const lock = JSON.parse(await readFile(path, "utf8")) as PushLock;
    if (lock.schema !== 1 || lock.workspace !== workspace)
      throw new Error(".vardum.push.lock belongs to a different workspace");
    return lock;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { schema: 1, workspace, entries: {} };
    throw error;
  }
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    dryRun: false,
    delete: false,
    force: false,
    values: new Map(),
    positionals: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--delete") options.delete = true;
    else if (argument === "--force") options.force = true;
    else if (["--server", "--workspace", "--vard"].includes(argument)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options.values.set(argument.slice(2), value);
      index += 1;
    } else if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    else options.positionals.push(argument);
  }
  return options;
}

function requireApiKey() {
  if (!process.env.VARDUM_API_KEY)
    throw new Error("VARDUM_API_KEY is required for push operations");
}

function summary(options: Options, changed: number) {
  console.log(
    `${options.dryRun ? "dry run: " : ""}${changed} change${changed === 1 ? "" : "s"}`,
  );
}

function help() {
  console.log(`Vardum asset sync

Usage:
  vardum init [--server URL --workspace ID --vard ID] [--force]
  vardum sync [--dry-run] [--delete] [--force]
  vardum pull [--dry-run] [--delete] [--force]
  vardum push [--dry-run] [--force]
  vardum pull-asset <asset-key> <output-path> [--dry-run] [--force]
  vardum push-folder <directory> [prefix] [--dry-run] [--delete]

Authentication:
  Set VARDUM_API_KEY for private Vards and every push operation.

Safety:
  Pull and push use .vardum.lock for conflict detection.
  --delete removes only files/assets tracked by a previous CLI run.`);
}
