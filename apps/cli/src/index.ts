#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { mediaStem, mimeForFilename } from "@vardum/shared";
import { stdin, stdout } from "node:process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { VardumClient, VardumHttpError, type FolderImportFile, type Manifest, type VardConfig } from "./client.js";
import {
  credentialsPath,
  machineLabel,
  readCredential,
  removeCredential,
  writeCredential,
} from "./credentials.js";
import { planPushFolder } from "./interactive.js";
import { awaitGrant, loginUrl, newState, openBrowser } from "./login.js";
import { maybeWarnOutdated, updateVardum, VERSION } from "./update.js";
import { readUploadFile } from "./upload-file.js";
import {
  acquireFolderMutex,
  clearFolderJournal,
  pendingFilename,
  readFolderJournal,
  readFolderState,
  resumeFolderUpload,
  waitForFolderUploads,
  writeFolderState,
  type FolderIntent,
  type FolderImportIntent,
  type FolderImportJournal,
  type UploadPhase,
} from "./folder-upload.js";
import {
  assetKey,
  assetPrefix,
  folderAssetKey,
  folderAssetDirectories,
  atomicWrite,
  checksum,
  checksumFile,
  findConfig,
  imageFiles,
  immutableAssetUrl,
  pullDecision,
  pushDecision,
  readLock,
  removeTracked,
  safeTarget,
  safeLockPath,
  writeLock,
  validateOutputPaths,
  validateSnapshotUrl,
  type Lockfile,
} from "./sync.js";

type Options = {
  frozen: boolean;
  dryRun: boolean;
  delete: boolean;
  force: boolean;
  json: boolean;
  values: Map<string, string>;
  positionals: string[];
};
type Action = {
  action: "pull" | "push" | "delete" | "create";
  path: string;
  applied: boolean;
  conflict?: boolean;
  phase?: UploadPhase;
  assetId?: string;
  versionId?: string;
};

// Every command reports through here, so --json is one branch rather than a
// second copy of each command's output.
const actions: Action[] = [];
type FolderImportReport = {
  library: Array<Action & { key: string; outputPath: string; libraryAction: "new" | "update" | "skip" }>;
  mappings: Array<{
    key: string; outputPath: string; assetId: string; versionId: string;
    mappingAction: "add" | "keep"; mappingId: string | null;
    phase: "planned" | "apply-requested" | "applied"; applied: boolean;
    result?: "added" | "kept";
  }>;
  appliedMeaning: string;
};
let folderImportReport: FolderImportReport | undefined;
type PushLock = {
  schema: 1;
  server?: string;
  workspace: string;
  entries: Record<
    string,
    { directory: string; prefix: string; assets: Record<string, string> }
  >;
};

const [command = "help", ...rawArgs] = process.argv.slice(2);
const helpCommands = ["help", "--help", "-h"];
const versionCommands = ["version", "--version", "-v"];
// Parsed before the try so the error handler can read --json without parsing
// again — a second parse of a bad flag used to throw inside the catch.
const json = rawArgs.includes("--json");

if (![...helpCommands, ...versionCommands, "update"].includes(command) &&
    !(command === "push-folder" && rawArgs.includes("--dry-run")))
  maybeWarnOutdated();

try {
  if (helpCommands.includes(command)) help();
  else if (versionCommands.includes(command)) console.log(VERSION);
  else {
    const options = parseOptions(rawArgs);
    if (options.values.has("output") && command !== "push-folder")
      throw new Error("--output is only supported by push-folder");
    if (options.frozen && !["pull", "sync", "status"].includes(command))
      throw new Error("--frozen is only supported by pull, sync and status");
    if (
      options.frozen &&
      (options.delete || options.values.size || options.positionals.length)
    )
      throw new Error(
        "--frozen cannot be combined with --delete, context overrides or positional arguments",
      );
    if (command === "init") await init(options);
    else if (command === "login") await login(options);
    else if (command === "logout") await logout(options);
    else if (command === "whoami") await whoami(options);
    else if (command === "status") await pull({ ...options, dryRun: true });
    else if (command === "pull" || command === "sync") await pull(options);
    else if (command === "push") await push(options);
    else if (command === "push-folder") await pushFolder(options);
    else if (command === "pull-asset") await pullAsset(options);
    else if (command === "update") await update(options);
    else
      throw new Error(
        `Unknown command: ${command}. Run vardum help for the list.`,
      );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Node's readline reports a closed stdin as "Aborted with Ctrl+D", which
  // reads like a crash when someone simply changed their mind at a prompt.
  const cancelled = /Ctrl\+D|Ctrl\+C/.test(message);
  console.error(
    json
      ? // Actions already applied belong in the payload: a push that fails on
        // file 40 of 50 has really changed 39 things, and CI needs to know.
        JSON.stringify(
          { error: cancelled ? "Cancelled" : message, actions, ...folderImportReport },
          null,
          2,
        )
      : cancelled
        ? "vardum: cancelled"
        : `vardum: ${message}`,
  );
  process.exitCode = 1;
}

async function init(options: Options) {
  if (options.delete || options.positionals.length)
    throw new Error(
      "init accepts --server, --workspace, --vard, --force, --dry-run and --json",
    );
  const fields = ["server", "workspace", "vard"] as const;
  const missing = fields.filter((field) => !options.values.has(field));
  if (missing.length && (!stdin.isTTY || options.json))
    throw new Error(
      `Non-interactive init requires ${missing.map((field) => `--${field}`).join(", ")}. Copy the setup command from your Vard's CLI config tab.`,
    );

  const prompts = missing.length
    ? createInterface({ input: stdin, output: stdout })
    : null;
  try {
    const server =
      options.values.get("server") ?? (await prompts!.question("Vardum URL: "));
    const workspace =
      options.values.get("workspace") ??
      (await prompts!.question("Workspace ID: "));
    const vard =
      options.values.get("vard") ?? (await prompts!.question("Vard ID: "));
    const config = validateConfig({ schema: 1, server, workspace, vard });
    const path = resolve("vardum.json");
    let existing: string | null = null;
    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    if (existing !== null) {
      let same = false;
      try {
        same =
          JSON.stringify(validateConfig(JSON.parse(existing))) ===
          JSON.stringify(config);
      } catch {
        /* Invalid existing config still requires explicit replacement. */
      }
      if (same) {
        if (!options.json)
          console.log("vardum.json already connects this Vard.");
        summary(options, 0);
        return;
      }
      if (!options.force)
        throw new Error(
          "vardum.json already exists with a different or invalid configuration; use --force to replace it",
        );
    }
    if (prompts && !options.force && !options.dryRun) {
      console.log(
        `\n  server:    ${config.server}\n  workspace: ${config.workspace}\n  vard:      ${config.vard}`,
      );
      const answer = (await prompts.question("Write vardum.json? [Y/n] "))
        .trim()
        .toLowerCase();
      if (answer && !["y", "yes"].includes(answer)) {
        console.log("Aborted.");
        return;
      }
    }
    const entry = report("create", "vardum.json", options);
    if (!options.dryRun) {
      const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
      if (options.force) await atomicWrite(path, bytes);
      else await writeFile(path, bytes, { flag: "wx" });
      entry.applied = true;
    }
    summary(options, 1);
    if (!options.json && !options.dryRun)
      console.log("Next: vardum login, then vardum pull.");
  } finally {
    prompts?.close();
  }
}

async function login(options: Options) {
  const context = await optionalContext();
  const server = options.values.get("server") ?? context?.config.server;
  const workspace =
    options.values.get("workspace") ??
    (context && server === context.config.server
      ? context.config.workspace
      : undefined);
  if (!server)
    throw new Error("Run vardum login inside a project, or pass --server URL");

  const state = newState();
  const label = machineLabel();
  const listener = awaitGrant(state);
  try {
    const port = await listener.listening;
    const url = loginUrl(server, port, state, label, workspace);
    if (!options.json) {
      console.log(`Opening ${url}`);
      console.log("Waiting for the browser to authorize this machine…");
    }
    openBrowser(url);

    const grant = await listener.grant;
    await writeCredential(server, grant.workspace, grant.key);
    report("create", `${server} // ${grant.workspace}`, options).applied = true;
    if (!options.json)
      console.log(`Key stored in ${credentialsPath()} as cli@${label}`);
    summary(options, 1);
  } finally {
    listener.close();
  }
}

async function logout(options: Options) {
  const context = await optionalContext();
  const server = options.values.get("server") ?? context?.config.server;
  const workspace =
    options.values.get("workspace") ?? context?.config.workspace;
  if (!server || !workspace)
    throw new Error(
      "Run vardum logout inside a project, or pass --server and --workspace",
    );

  // Revoke first: a key left behind on the server outlives the file.
  const stored = await readCredential(server, workspace);
  if (stored) {
    try {
      await new VardumClient(server, stored).revokeCliKey(workspace);
    } catch (error) {
      if (!options.json)
        console.error(
          `vardum: could not revoke the key on the server (${error instanceof Error ? error.message : String(error)}); remove it from Settings // API keys`,
        );
    }
  }
  const removed = await removeCredential(server, workspace);
  if (removed)
    report("delete", `${server} // ${workspace}`, options).applied = true;
  summary(options, removed ? 1 : 0);
}

/**
 * Where this project points and which key it would use. No network call: the
 * question "am I logged in and against what" should be answerable offline.
 */
async function whoami(options: Options) {
  const context = await loadContext();
  const stored = await readCredential(
    context.config.server,
    context.config.workspace,
  );
  const keySource = process.env.VARDUM_API_KEY
    ? "VARDUM_API_KEY"
    : stored
      ? credentialsPath()
      : "none — run vardum login";
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          config: context.path,
          server: context.config.server,
          workspace: context.config.workspace,
          vard: context.config.vard,
          keySource,
          authenticated: context.client.authenticated,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `  config:    ${relative(process.cwd(), context.path) || context.path}`,
  );
  console.log(`  server:    ${context.config.server}`);
  console.log(`  workspace: ${context.config.workspace}`);
  console.log(`  vard:      ${context.config.vard}`);
  console.log(`  key:       ${keySource}`);
}

/** The project context, or nothing when the command runs outside a project. */
async function optionalContext() {
  try {
    return await loadContext();
  } catch {
    return null;
  }
}

async function pull(options: Options) {
  const context = await loadContext();
  const lockPath = await safeLockPath(context.directory);
  const previous = await readLock(lockPath, context.config);
  const snapshot = previous?.schema === 2 ? previous : null;
  if (options.frozen && !snapshot)
    throw new Error(
      "Frozen pull requires a complete schema 2 .vardum.lock; run vardum pull to refresh, then commit the snapshot",
    );
  let items: Array<
    Pick<
      Manifest["items"][number],
      "id" | "outputPath" | "versionId" | "fingerprint" | "downloadUrl"
    >
  >;
  if (options.frozen) {
    items = Object.entries(snapshot!.items).map(([id, item]) => ({
      id,
      outputPath: item.path,
      versionId: item.versionId,
      fingerprint: item.fingerprint,
      downloadUrl: item.downloadUrl,
    }));
  } else {
    const manifest = await context.client.manifest(context.config);
    assertManifest(manifest, context.config);
    items = manifest.items;
  }
  validateOutputPaths(items.map((item) => item.outputPath));
  const ids = items.map((item) => item.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) => !id || ["__proto__", "constructor", "prototype"].includes(id),
    )
  )
    throw new Error("Invalid or duplicate Vard output IDs");

  const planned = [] as Array<{
    item: (typeof items)[number];
    localChecksum: string | null;
    decision: ReturnType<typeof pullDecision>;
  }>;
  for (const item of items) {
    if (!item.versionId || !item.fingerprint || !item.downloadUrl)
      throw new Error(`Vard output is unavailable: ${item.outputPath}`);
    validateSnapshotUrl(
      item.downloadUrl,
      item.versionId,
      context.config.server,
    );
    const target = await safeTarget(context.directory, item.outputPath);
    const localChecksum = await checksumFile(target);
    planned.push({
      item,
      localChecksum,
      decision: pullDecision(
        item.fingerprint,
        localChecksum,
        previous?.items[item.id]?.path === item.outputPath
          ? previous.items[item.id]
          : undefined,
      ),
    });
  }

  const stale = Object.entries(previous?.items ?? {}).filter(
    ([, locked]) => !items.some((item) => item.outputPath === locked.path),
  );
  const conflicts = planned.filter(({ decision }) => decision === "conflict");
  // A dry run is a report: vardum status used to fail outright the moment a
  // tracked file had local edits, which is exactly when it is worth running.
  if (conflicts.length && !options.force && !options.dryRun)
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

  const next: Lockfile = {
    schema: 2,
    server: context.config.server,
    workspace: context.config.workspace,
    vard: context.config.vard,
    items: Object.create(null),
  };
  for (const plan of planned) {
    let localChecksum = plan.localChecksum;
    if (plan.decision !== "skip") {
      const entry = report(
        "pull",
        plan.item.outputPath,
        options,
        plan.decision === "conflict"
          ? "(local edits — needs --force)"
          : undefined,
      );
      if (plan.decision === "conflict") entry.conflict = true;
      if (!options.dryRun) {
        const bytes = await context.client.download(plan.item.downloadUrl!);
        localChecksum = checksum(bytes);
        if (
          options.frozen &&
          localChecksum !== previous!.items[plan.item.id]!.checksum
        )
          throw new Error(
            `Locked checksum mismatch: ${plan.item.outputPath}; refusing to replace file`,
          );
        await atomicWrite(
          await safeTarget(context.directory, plan.item.outputPath),
          bytes,
        );
        entry.applied = true;
      }
    }
    if (!localChecksum && options.dryRun) continue;
    next.items[plan.item.id] = {
      path: plan.item.outputPath,
      versionId: plan.item.versionId!,
      fingerprint: plan.item.fingerprint!,
      downloadUrl: validateSnapshotUrl(
        plan.item.downloadUrl!,
        plan.item.versionId!,
        context.config.server,
      ),
      checksum: localChecksum!,
    };
  }

  if (options.delete)
    for (const [, locked] of stale) {
      const entry = report("delete", locked.path, options);
      if (!options.dryRun) {
        await removeTracked(
          await safeTarget(context.directory, locked.path),
          context.directory,
        );
        entry.applied = true;
      }
    }
  if (!options.dryRun && !options.frozen)
    await writeLock(lockPath, next, context.config);
  summary(
    options,
    planned.filter(({ decision }) => decision !== "skip").length +
      (options.delete ? stale.length : 0),
  );
}

async function push(options: Options) {
  const context = await loadContext();
  requireApiKey(context.client);
  let manifest = await context.client.manifest(context.config, true);
  assertManifest(manifest, context.config);
  const lockPath = await safeLockPath(context.directory);
  const lock = await readLock(lockPath, context.config);
  if (!lock || lock.vard !== manifest.id)
    throw new Error("Run vardum pull before pushing mapped outputs");

  validateOutputPaths(manifest.items.map((item) => item.outputPath));
  const writable = manifest.items.filter((item) => item.writable);
  const limits = writable.length ? await context.client.uploadLimits() : null;
  let changed = 0;
  for (const item of writable) {
    if (!item.versionId || !item.fingerprint)
      throw new Error(`Vard output is unavailable: ${item.outputPath}`);
    const path = await safeTarget(context.directory, item.outputPath);
    const mimeType = mimeForFilename(path);
    if (!mimeType)
      throw new Error(`Unsupported image type: ${item.outputPath}`);
    let bytes: Uint8Array;
    try {
      bytes = await readUploadFile(path, mimeType, limits!);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        throw new Error(`Writable output is missing: ${item.outputPath}`);
      throw error;
    }
    const localChecksum = checksum(bytes);
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
    const entry = report("push", item.outputPath, options);
    changed += 1;
    if (options.dryRun) continue;
    const previousVersion = item.versionId;
    await context.client.uploadVersion(
      context.config.workspace,
      item.assetId,
      basename(path),
      mimeType,
      bytes,
    );
    entry.applied = true;
    manifest = await waitForManifestVersion(
      context.client,
      context.config,
      item.id,
      previousVersion,
    );
    const updated = manifest.items.find(({ id }) => id === item.id);
    assertManifest(manifest, context.config);
    if (
      !updated?.versionId ||
      !updated.fingerprint ||
      !updated.downloadUrl ||
      updated.outputPath !== item.outputPath
    )
      throw new Error(
        `Uploaded output did not become ready: ${item.outputPath}`,
      );
    if (lock.schema === 2) {
      validateSnapshotUrl(
        updated.downloadUrl,
        updated.versionId,
        context.config.server,
      );
      const downloaded = await context.client.download(updated.downloadUrl);
      if (checksum(downloaded) !== localChecksum)
        throw new Error(
          `Uploaded output checksum mismatch: ${item.outputPath}; lock was not advanced`,
        );
    }
    lock.items[item.id] = {
      path: item.outputPath,
      versionId: updated.versionId,
      fingerprint: updated.fingerprint,
      ...(lock.schema === 2
        ? {
            downloadUrl: validateSnapshotUrl(
              updated.downloadUrl,
              updated.versionId,
              context.config.server,
            ),
          }
        : {}),
      checksum: localChecksum,
    };
    await writeLock(lockPath, lock, context.config);
  }
  summary(options, changed);
}

async function pushFolder(options: Options) {
  const [source, positionalPrefix] = options.positionals;
  if (!source || options.positionals.length > 2)
    throw new Error("Usage: vardum push-folder <directory> [prefix] [--output <prefix>]");
  if ([...options.values.keys()].some((key) => key !== "output"))
    throw new Error("push-folder uses the configured server, workspace and Vard; context overrides are not supported");
  if (options.values.has("output") && options.delete)
    throw new Error("--output cannot be combined with --delete");
  if (options.force && !options.delete)
    throw new Error("push-folder --force is only supported with --delete");
  const outputPrefix = options.values.has("output") ? folderOutputPrefix(options.values.get("output")!) : undefined;
  const context = await loadContext();
  requireApiKey(context.client);
  const directory = await realpath(resolve(source));
  const files = await imageFiles(directory);
  if (!files.length)
    throw new Error(`No images found in ${relative(process.cwd(), directory) || "."}`);
  const selectedPrefix = await resolveFolderPrefix(options, positionalPrefix, context, directory, files);
  if (selectedPrefix === null) return summary(options, 0);
  const prefix = assetPrefix(selectedPrefix);
  if (outputPrefix !== undefined)
    return pushFolderImport(options, context, directory, files, prefix, outputPrefix);

  // Older servers discard optional IDs: capability negotiation must precede
  // journal/mutex creation as well as every remote mutation.
  if (!options.dryRun) await context.client.requireFolderUploadResume();
  const projectRoot = await realpath(context.directory);
  const release = options.dryRun ? null : await acquireFolderMutex(projectRoot);
  try {
    const journalPath = join(projectRoot, pendingFilename);
    const journal = await readFolderJournal(journalPath, {
      server: context.config.server, workspace: context.config.workspace, source: directory, prefix,
    });
    const saveJournal = () => writeFolderState(journalPath, journal);
    const remote = await context.client.syncAssets(context.config.workspace, prefix);
    const byKey = new Map(remote.assets.map((asset) => [asset.key, asset]));
    const identities = await context.client.assetIdentities(context.config.workspace,
      folderAssetDirectories(prefix, files.map((file) => file.relative)));
    if (!options.dryRun && identities.some((identity) => typeof identity.hasUnfinishedUploads !== "boolean"))
      throw new Error("Vardum returned an invalid resumable asset identity response (missing hasUnfinishedUploads)");
    const identityByKey = new Map(identities.map((asset) => [asset.key, asset]));
    const existingKeys = new Set([...identityByKey.keys(), ...Object.keys(journal.files)]);
    const limits = await context.client.uploadLimits();
    const local: Array<typeof files[number] & { key: string; checksum: string }> = [];
    const plannedKeys = new Set<string>();
    const resolvedKeys = new Set<string>();
    for (const file of files) {
      const stemKey = assetKey(prefix, file.relative);
      if (plannedKeys.has(stemKey))
        throw new Error(`Files normalize to the same asset key: ${stemKey}`);
      plannedKeys.add(stemKey);
      const key = folderAssetKey(prefix, file.relative, existingKeys);
      if (resolvedKeys.has(key))
        throw new Error(`Files resolve to the same asset key: ${key}`);
      resolvedKeys.add(key);
      const current = byKey.get(key);
      const identity = identityByKey.get(key);
      if (current && (!identity || identity.id !== current.id))
        throw new Error(`${key} changed asset identity during the folder plan; rerun the command after inspecting that key on the server`);
      const bytes = await readUploadFile(file.absolute, file.mimeType, limits);
      const hash = checksum(bytes);
      const pending = journal.files[key];
      if (pending && (pending.relative !== file.relative || pending.checksum !== hash ||
          pending.mimeType !== file.mimeType || pending.size !== bytes.byteLength))
        throw new Error(`${file.relative} differs from the pending upload; restore its original bytes before resuming ${pendingFilename}`);
      if (pending && identity && pending.assetId !== identity.id)
        throw new Error(`${key} has a different remote asset identity; keep the pending journal and resolve the conflict before retrying`);
      local.push({ ...file, size: bytes.byteLength, key, checksum: hash });
    }
    for (const pending of Object.values(journal.files))
      if (!resolvedKeys.has(pending.key))
        throw new Error(`${pending.relative} is missing from the pending folder upload; restore it before resuming ${pendingFilename}`);

    const pushLockPath = join(projectRoot, ".vardum.push.lock");
    const pushLock = await readPushLock(pushLockPath, context.config.workspace, context.config.server);
    const trackedDirectory = relative(projectRoot, directory) || ".";
    const lockKey = `${trackedDirectory}:${prefix}`;
    const aliases = Object.entries(pushLock.entries).filter(([, entry]) =>
      entry.directory === trackedDirectory && assetPrefix(entry.prefix) === prefix);
    const previous: Record<string, string> = Object.create(null);
    for (const [, entry] of aliases)
      for (const [key, id] of Object.entries(entry.assets)) {
        if (previous[key] && previous[key] !== id)
          throw new Error(`Conflicting folder tracking for ${key}; resolve the push lock before continuing`);
        previous[key] = id;
      }
    const currentAssets: Record<string, string> = Object.create(null);
    const outdated = local.filter((file) => {
      const existing = byKey.get(file.key);
      const identity = identityByKey.get(file.key);
      if (journal.files[file.key] || existing?.checksum !== file.checksum ||
          existing.mimeType !== file.mimeType || existing.size !== file.size ||
          identity?.hasUnfinishedUploads === true || identity?.status === "pending" || identity?.status === "processing") return true;
      currentAssets[file.key] = existing.id;
      return false;
    });
    let changed = 0;
    const processing: Array<{ file: FolderIntent; action: Action }> = [];
    for (const [index, file] of outdated.entries()) {
      const action = report("push", file.key, options, `(${index + 1}/${outdated.length})`);
      changed += 1;
      if (options.dryRun) {
        const pending = journal.files[file.key];
        if (pending) Object.assign(action, { phase: pending.phase, assetId: pending.assetId, versionId: pending.versionId });
        continue;
      }
      const bytes = await readUploadFile(file.absolute, file.mimeType, limits);
      if (checksum(bytes) !== file.checksum)
        throw new Error(`${file.relative} changed since the folder plan; retry the push`);
      let intent = journal.files[file.key];
      if (!intent) {
        const existing = byKey.get(file.key);
        const identity = identityByKey.get(file.key);
        intent = {
          key: file.key, relative: file.relative, filename: basename(file.relative),
          displayName: mediaStem(basename(file.relative)), checksum: file.checksum,
          mimeType: file.mimeType, size: bytes.byteLength,
          assetId: identity?.id ?? randomUUID(), versionId: randomUUID(),
          expectedCurrentVersionId: existing?.versionId ?? null,
          createAsset: !identity, assetCreated: Boolean(identity), phase: "planned",
        };
        journal.files[file.key] = intent;
        Object.assign(action, { phase: intent.phase, assetId: intent.assetId, versionId: intent.versionId });
        await saveJournal();
      }
      await resumeFolderUpload(context.client, context.config.workspace, intent, bytes, saveJournal, action);
      currentAssets[file.key] = intent.assetId;
      processing.push({ file: intent, action });
    }
    if (processing.some(({ file }) => file.phase !== "ready")) {
      if (!options.json) console.log(`waiting for ${processing.filter(({ file }) => file.phase !== "ready").length} upload(s) to process…`);
      await waitForFolderUploads(context.client, context.config.workspace, processing, saveJournal);
    }

    if (options.delete) {
      const removable = Object.entries(previous).filter(([key]) => !resolvedKeys.has(key));
      const confirmed = !removable.length || options.force || options.json ||
        !stdin.isTTY || await confirmDeletion(removable.map(([key]) => key));
      for (const [key, assetId] of removable) {
        if (!confirmed) { currentAssets[key] = assetId; continue; }
        const action = report("delete", key, options);
        changed += 1;
        if (!options.dryRun) {
          try { await context.client.deleteAsset(context.config.workspace, assetId); }
          catch (error) {
            if (!(error instanceof VardumHttpError && error.status === 404)) throw error;
          }
          action.applied = true;
        }
      }
    }
    if (!options.dryRun) {
      pushLock.server = context.config.server;
      pushLock.entries[lockKey] = { directory: trackedDirectory, prefix, assets: currentAssets };
      for (const [alias] of aliases)
        if (alias !== lockKey) delete pushLock.entries[alias];
      // Ready journal entries remain until tracking is durably saved. A crash
      // between these writes rechecks the same ready versions on the next run.
      await writeFolderState(pushLockPath, pushLock);
      await clearFolderJournal(journalPath);
    }
    summary(options, changed);
  } finally {
    await release?.();
  }
}

function folderOutputPrefix(input: string) {
  const prefix = input.normalize("NFC").replace(/\/+$/, "");
  // Only trailing slashes are normalized; absolute paths stay invalid.
  if (input.startsWith("/") || prefix.length > 255)
    throw new Error(`Invalid --output prefix: ${input}`);
  if (prefix) validateOutputPaths([`${prefix}/__vardum_output_probe__.png`]);
  return prefix ? `${prefix}/` : "";
}

function journalImportReport(journal: FolderImportJournal, dryRun: boolean): FolderImportReport {
  const files = Object.values(journal.files);
  return {
    library: files.map((file) => ({
      action: "push", path: file.key, key: file.key, outputPath: file.outputPath,
      libraryAction: file.libraryAction, phase: file.phase, assetId: file.assetId, versionId: file.versionId,
      applied: !dryRun && file.phase === "ready" && (file.libraryAction !== "skip" || file.mappingPhase !== "planned"),
    })),
    mappings: files.map((file) => ({
      key: file.key, outputPath: file.outputPath, assetId: file.assetId, versionId: file.versionId,
      mappingAction: file.mappingAction, mappingId: file.mappingId, phase: file.mappingPhase,
      applied: !dryRun && file.mappingPhase === "applied",
    })),
    appliedMeaning: "applied confirms completed work; false does not rule out remote changes after a failed or lost response. Keep the pending journal and rerun the same command.",
  };
}

async function pushFolderImport(
  options: Options,
  context: Awaited<ReturnType<typeof loadContext>>,
  directory: string,
  files: Awaited<ReturnType<typeof imageFiles>>,
  prefix: string,
  outputPrefix: string,
) {
  if (files.length > 1000) throw new Error("Folder Vard imports support at most 1,000 files");
  const outputPaths = files.map((file) => `${outputPrefix}${file.relative}`);
  validateOutputPaths(outputPaths);
  if (outputPaths.some((path) => path.length > 500))
    throw new Error("Folder import output paths must be at most 500 characters");
  // New mode negotiates both protocols even for a read-only dry-run.
  await context.client.requireFolderUploadResume(true);
  const projectRoot = await realpath(context.directory);
  const journalPath = join(projectRoot, pendingFilename);
  const journalContext = {
    server: context.config.server, workspace: context.config.workspace,
    source: directory, prefix, vard: context.config.vard, outputPrefix,
  };
  const journal = await readFolderJournal(journalPath, journalContext);
  folderImportReport = journalImportReport(journal, options.dryRun);
  const journalBefore = JSON.stringify(journal);
  const remote = await context.client.syncAssets(context.config.workspace, prefix);
  const byKey = new Map(remote.assets.map((asset) => [asset.key, asset]));
  const identities = await context.client.assetIdentities(context.config.workspace,
    folderAssetDirectories(prefix, files.map((file) => file.relative)));
  if (identities.some((identity) => typeof identity.hasUnfinishedUploads !== "boolean"))
    throw new Error("Vardum returned an invalid resumable asset identity response (missing hasUnfinishedUploads)");
  const identityByKey = new Map(identities.map((asset) => [asset.key, asset]));
  const existingKeys = new Set([...identityByKey.keys(), ...Object.keys(journal.files)]);
  const limits = await context.client.uploadLimits();
  const local: Array<typeof files[number] & FolderImportFile> = [];
  const stems = new Set<string>();
  const keys = new Set<string>();
  for (const [index, file] of files.entries()) {
    const stem = assetKey(prefix, file.relative);
    if (stems.has(stem)) throw new Error(`Files normalize to the same asset key: ${stem}`);
    stems.add(stem);
    const key = folderAssetKey(prefix, file.relative, existingKeys);
    if (keys.has(key)) throw new Error(`Files resolve to the same asset key: ${key}`);
    keys.add(key);
    const current = byKey.get(key);
    const identity = identityByKey.get(key);
    if (current && (!identity || identity.id !== current.id))
      throw new Error(`${key} changed asset identity during the folder plan; rerun the command after inspecting that key on the server`);
    const bytes = await readUploadFile(file.absolute, file.mimeType, limits);
    const hash = checksum(bytes);
    const pending = journal.files[key];
    if (pending && (pending.relative !== file.relative || pending.checksum !== hash ||
        pending.mimeType !== file.mimeType || pending.size !== bytes.byteLength))
      throw new Error(`${file.relative} differs from the pending upload; restore its original bytes before resuming ${pendingFilename}`);
    if (pending && identity && pending.assetId !== identity.id)
      throw new Error(`${key} has a different remote asset identity; keep the pending journal and resolve the conflict before retrying`);
    local.push({ ...file, key, size: bytes.byteLength, checksum: hash,
      outputPath: outputPaths[index]!, assetId: pending?.assetId ?? identity?.id ?? randomUUID() });
  }
  for (const pending of Object.values(journal.files))
    if (!keys.has(pending.key))
      throw new Error(`${pending.relative} is missing from the pending folder upload; restore it before resuming ${pendingFilename}`);

  const pushLockPath = join(projectRoot, ".vardum.push.lock");
  // Validate local tracking during preflight, but never retain this snapshot
  // for writes: another folder push may complete before we acquire the mutex.
  await readPushLock(pushLockPath, context.config.workspace, context.config.server);
  const trackedDirectory = relative(projectRoot, directory) || ".";
  const lockKey = `${trackedDirectory}:${prefix}`;
  // This is a read-only permission/collision preflight. No mutex, journal,
  // upload or mapping is written until the entire plan is accepted.
  const request = local.map(({ assetId, key, outputPath, checksum, mimeType, size }) =>
    ({ assetId, key, outputPath, checksum, mimeType, size }));
  const plan = await context.client.planFolderImport(context.config, request);
  folderImportReport = {
    library: [], mappings: [],
    appliedMeaning: folderImportReport.appliedMeaning,
  };
  for (const [index, planned] of plan.entries()) {
    const file = local[index]!;
    const pending = journal.files[file.key];
    const intent: FolderImportIntent = pending ?? {
      key: file.key, relative: file.relative, filename: basename(file.relative),
      displayName: mediaStem(basename(file.relative)), checksum: file.checksum,
      mimeType: file.mimeType, size: file.size, assetId: file.assetId,
      versionId: planned.libraryAction === "skip" ? planned.versionId! : randomUUID(),
      expectedCurrentVersionId: planned.versionId,
      createAsset: !identityByKey.has(file.key), assetCreated: identityByKey.has(file.key),
      phase: planned.libraryAction === "skip" ? "ready" : "planned",
      outputPath: file.outputPath, libraryAction: planned.libraryAction,
      mappingAction: planned.mappingAction, mappingId: planned.mappingId, mappingPhase: "planned",
    };
    journal.files[file.key] = intent;
    const libraryAction = options.dryRun ? planned.libraryAction : intent.libraryAction;
    const library: FolderImportReport["library"][number] = {
      action: "push", path: file.key, key: file.key, outputPath: file.outputPath,
      libraryAction, applied: !options.dryRun && pending?.phase === "ready" && (pending.libraryAction !== "skip" || pending.mappingPhase !== "planned"),
      phase: intent.phase, assetId: intent.assetId, versionId: intent.versionId,
    };
    folderImportReport.library.push(library);
    const mapping = {
      key: file.key, outputPath: file.outputPath, assetId: intent.assetId, versionId: intent.versionId,
      mappingAction: options.dryRun ? planned.mappingAction : intent.mappingAction,
      mappingId: intent.mappingId, phase: intent.mappingPhase,
      applied: !options.dryRun && intent.mappingPhase === "applied",
    };
    folderImportReport.mappings.push(mapping);
    if (!options.json) console.log(`${options.dryRun ? "would " : ""}${libraryAction} ${file.key}; ${mapping.mappingAction} mapping ${file.outputPath}`);
  }
  for (const planned of plan) {
    const intent = journal.files[planned.key]!;
    if (intent.phase === "ready" && planned.versionId !== intent.versionId)
      throw new Error(`${planned.key} no longer has the journal's exact ready version as current; keep the pending journal and resolve the concurrent update before retrying`);
    if (intent.mappingPhase === "applied" && (planned.mappingAction !== "keep" || planned.mappingId !== intent.mappingId))
      throw new Error(`${planned.outputPath} changed its applied mapping; keep the pending journal and resolve the target before retrying`);
  }
  const changed = plan.filter((file) => file.libraryAction !== "skip").length + plan.filter((file) => file.mappingAction === "add").length;
  if (options.dryRun) return summary(options, changed);

  const release = await acquireFolderMutex(projectRoot);
  try {
    if (JSON.stringify(await readFolderJournal(journalPath, journalContext)) !== journalBefore)
      throw new Error("The pending folder journal changed during preflight; rerun the same command");
    const pushLock = await readPushLock(pushLockPath, context.config.workspace, context.config.server);
    const aliases = Object.entries(pushLock.entries).filter(([, entry]) =>
      entry.directory === trackedDirectory && assetPrefix(entry.prefix) === prefix);
    const saveJournal = () => writeFolderState(journalPath, journal);
    // Persist ALL target/source identities, including skip files, together.
    await saveJournal();
    const processing: Array<{ file: FolderIntent; action: Action }> = [];
    for (const [index, file] of local.entries()) {
      const intent = journal.files[file.key]!;
      const action = folderImportReport.library[index]!;
      const bytes = await readUploadFile(file.absolute, file.mimeType, limits);
      if (checksum(bytes) !== file.checksum)
        throw new Error(`${file.relative} changed since the folder plan; retry the push`);
      if (intent.libraryAction === "skip") {
        const exact = await context.client.folderVersion(context.config.workspace, intent.assetId, intent.versionId);
        if (exact.id !== intent.versionId || exact.status !== "ready" || exact.checksum !== intent.checksum ||
            exact.mimeType !== intent.mimeType || exact.size !== intent.size)
          throw new Error(`Exact ready version metadata or checksum differs for ${file.key}; keep the pending journal before retrying`);
        action.applied = true;
      } else {
        try {
          await resumeFolderUpload(context.client, context.config.workspace, intent, bytes, saveJournal, action);
        } finally {
          // Admission may adopt an existing version before a later upload
          // fails. Error reports must expose that actual durable identity.
          folderImportReport.mappings[index]!.versionId = intent.versionId;
        }
        processing.push({ file: intent, action });
      }
      folderImportReport.mappings[index]!.versionId = intent.versionId;
    }
    if (processing.some(({ file }) => file.phase !== "ready"))
      await waitForFolderUploads(context.client, context.config.workspace, processing, saveJournal);
    for (const [index, file] of local.entries()) {
      const intent = journal.files[file.key]!;
      if (intent.mappingPhase !== "applied") intent.mappingPhase = "apply-requested";
      Object.assign(folderImportReport.mappings[index]!, { phase: intent.mappingPhase, versionId: intent.versionId });
    }
    await saveJournal();
    const applied = await context.client.applyFolderImport(context.config, request.map((file) =>
      ({ ...file, versionId: journal.files[file.key]!.versionId })));
    // Report accepted remote work before saving tracking: a local write failure
    // must not hide mappings already added by this request.
    for (const [index, result] of applied.files.entries()) {
      const intent = journal.files[result.key]!;
      Object.assign(intent, { mappingPhase: "applied", mappingId: result.mappingId });
      Object.assign(folderImportReport.mappings[index]!, { phase: "applied", mappingId: result.mappingId, applied: true, result: result.mappingAction });
    }
    await saveJournal();
    pushLock.server = context.config.server;
    pushLock.entries[lockKey] = { directory: trackedDirectory, prefix,
      assets: Object.fromEntries(local.map((file) => [file.key, journal.files[file.key]!.assetId])) };
    for (const [alias] of aliases) if (alias !== lockKey) delete pushLock.entries[alias];
    await writeFolderState(pushLockPath, pushLock);
    await clearFolderJournal(journalPath);
    summary(options, changed);
  } finally {
    await release();
  }
}

async function update(options: Options) {
  console.log(await updateVardum({ json: options.json }));
}

/**
 * Decides the workspace prefix for push-folder. A prefix given on the command
 * line wins. Otherwise, on a TTY without --json, an interactive REPL picks an
 * existing folder or creates a new one and confirms the plan. CI and pipes
 * fall back to the workspace root, so non-interactive callers never block.
 */
async function resolveFolderPrefix(
  options: Options,
  positionalPrefix: string | undefined,
  context: { client: VardumClient; config: VardConfig },
  directory: string,
  files: Awaited<ReturnType<typeof imageFiles>>,
): Promise<string | null> {
  if (positionalPrefix !== undefined) return positionalPrefix;
  if (!options.json && stdin.isTTY) {
    const prompts = createInterface({ input: stdin, output: stdout });
    try {
      return await planPushFolder(
        prompts,
        context.client,
        context.config.workspace,
        directory,
        files,
      );
    } finally {
      prompts.close();
    }
  }
  return "";
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
  const entry = report("pull", `${key} -> ${output}`, options);
  if (!options.dryRun) {
    const bytes = await context.client.download(
      immutableAssetUrl(remote.workspaceSlug, asset.versionId, asset.key),
    );
    await atomicWrite(target, bytes);
    entry.applied = true;
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
  // VARDUM_API_KEY wins: CI must never pick up whatever a developer logged into.
  const apiKey =
    process.env.VARDUM_API_KEY ??
    (await readCredential(config.server, config.workspace)) ??
    undefined;
  return {
    ...found,
    config,
    client: new VardumClient(config.server, apiKey),
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
    !input.workspace.trim() ||
    !input.vard.trim()
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
    server.password ||
    server.search ||
    server.hash
  )
    throw new Error(
      "vardum.json server must be HTTP(S) without credentials, query or fragment",
    );
  return {
    schema: 1,
    server: server.toString().replace(/\/+$/, ""),
    workspace: input.workspace.trim(),
    vard: input.vard.trim(),
  };
}

function assertManifest(manifest: Manifest, config: VardConfig) {
  if (manifest.schema !== 1 || manifest.id !== config.vard)
    throw new Error("Server returned a different or unsupported Vard manifest");
  if (manifest.workspaceId !== config.workspace)
    throw new Error("Vard does not belong to the configured workspace");
}

async function confirmDeletion(keys: string[]) {
  console.log(`\nThese ${keys.length} asset(s) are no longer in the folder:`);
  for (const key of keys.slice(0, 10)) console.log(`  ${key}`);
  if (keys.length > 10) console.log(`  … and ${keys.length - 10} more`);
  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompts.question("Delete them from Vardum? [y/N] "))
      .trim()
      .toLowerCase();
    if (["y", "yes"].includes(answer)) return true;
    console.log("Keeping them.");
    return false;
  } finally {
    prompts.close();
  }
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
  server: string,
): Promise<PushLock> {
  const raw = await readFolderState(path);
  if (raw === null) return { schema: 1, workspace, server, entries: Object.create(null) };
  const lock = JSON.parse(raw) as PushLock;
  if (lock.schema !== 1 || lock.workspace !== workspace || lock.server !== undefined && lock.server !== server)
    throw new Error(".vardum.push.lock belongs to a different server or workspace");
  if (!lock.entries || typeof lock.entries !== "object" || Array.isArray(lock.entries) ||
      Object.values(lock.entries).some((entry) => !entry || typeof entry !== "object" ||
        typeof entry.directory !== "string" || typeof entry.prefix !== "string" ||
        !entry.assets || typeof entry.assets !== "object" || Array.isArray(entry.assets) ||
        Object.values(entry.assets).some((id) => typeof id !== "string" || !id)))
    throw new Error("Invalid .vardum.push.lock; restore valid folder tracking before pushing");
  return lock;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    frozen: false,
    dryRun: false,
    delete: false,
    force: false,
    json: false,
    values: new Map(),
    positionals: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--frozen") options.frozen = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--delete") options.delete = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--json") options.json = true;
    else if (["--server", "--workspace", "--vard", "--output"].includes(argument)) {
      const value = args[index + 1];
      if (value === undefined || argument !== "--output" && !value || value.startsWith("-"))
        throw new Error(`${argument} requires a value`);
      if (argument === "--output" && options.values.has("output"))
        throw new Error("--output may only be supplied once");
      options.values.set(argument.slice(2), value);
      index += 1;
    } else if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    else options.positionals.push(argument);
  }
  return options;
}

function requireApiKey(client: VardumClient) {
  if (!client.authenticated)
    throw new Error(
      "Pushing needs a key: run vardum login, or set VARDUM_API_KEY",
    );
}

/**
 * Logs one intended change and returns its record. Callers mark the record
 * applied once the work lands, so a --json run that dies halfway reports what
 * actually happened instead of claiming the whole plan.
 */
function report(
  action: Action["action"],
  path: string,
  options: Options,
  note?: string,
) {
  const entry: Action = { action, path, applied: false };
  actions.push(entry);
  if (!options.json)
    console.log(
      `${options.dryRun ? `would ${action}` : action} ${path}${note ? `  ${note}` : ""}`,
    );
  return entry;
}

function summary(options: Options, changed: number) {
  if (options.json) {
    console.log(
      JSON.stringify({ dryRun: options.dryRun, changed, actions, ...folderImportReport }, null, 2),
    );
    return;
  }
  console.log(
    `${options.dryRun ? "dry run: " : ""}${changed} change${changed === 1 ? "" : "s"}`,
  );
}

function help() {
  console.log(`Vardum asset sync v${VERSION}

Usage:
  vardum init [--server URL --workspace ID --vard ID] [--dry-run] [--force]
  vardum login [--server URL --workspace ID]
  vardum logout [--server URL --workspace ID]
  vardum whoami
  vardum version
  vardum update [--json]
  vardum status [--frozen | --delete]
  vardum sync [--frozen | --delete] [--dry-run] [--force]
  vardum pull [--frozen | --delete] [--dry-run] [--force]
  vardum push [--dry-run] [--force]
  vardum pull-asset <asset-key> <output-path> [--dry-run] [--force]
  vardum push-folder <directory> [prefix] [--dry-run] [--delete | --output <prefix>]

Options:
  --json  machine-readable output for CI; errors go to stderr as {"error"}.

Authentication:
  vardum login authorizes this machine in the browser and stores a
  workspace key scoped to your own permissions.
  VARDUM_API_KEY overrides that stored key, so CI stays explicit.

Safety:
  status is pull without writing anything, and reports local conflicts
  instead of refusing to run.
  Normal pull explicitly refreshes assets and the schema 2 .vardum.lock snapshot.
  Commit vardum.json and .vardum.lock; CI uses pull --frozen to consume it
  without fetching the current manifest or changing the lock. Matching files
  need no download; downloaded SHA-256 is verified before replacement.
  --frozen refuses missing/legacy locks (run normal pull to refresh) and cannot
  use --delete. --force allows local replacement, never checksum bypass.
  Use a schema-2-capable CLI build; older CLIs cannot maintain snapshots.
  Frozen delivery still needs retained versions, valid signatures and an
  available same-origin server; redirects are refused. No latest fallback.
  --delete removes only files/assets tracked by a previous CLI run, and
  asks first when it would delete remote assets in a terminal.

Updates:
  vardum update detects whether the CLI is installed globally or locally
  and runs the correct package manager to pull the latest version.`);
}
