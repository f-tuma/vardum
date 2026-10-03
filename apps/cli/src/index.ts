#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { mimeForFilename } from "@vardum/shared";
import { stdin, stdout } from "node:process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { VardumClient, type Manifest, type VardConfig } from "./client.js";
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
import {
  assetKey,
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
  validateLock,
  snapshotTransformation,
  canonicalSnapshotTransformation,
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
  action: "pull" | "push" | "delete" | "create" | "migrate";
  path: string;
  applied: boolean;
  conflict?: boolean;
};

// Every command reports through here, so --json is one branch rather than a
// second copy of each command's output.
const actions: Action[] = [];
type PushLock = {
  schema: 1;
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

if (![...helpCommands, ...versionCommands, "update"].includes(command))
  maybeWarnOutdated();

try {
  if (helpCommands.includes(command)) help();
  else if (versionCommands.includes(command)) console.log(VERSION);
  else {
    const options = parseOptions(rawArgs);
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
    else if (command === "migrate-lock") await migrateLock(options);
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
          { error: cancelled ? "Cancelled" : message, actions },
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
  const snapshot = previous && previous.schema !== 1 ? previous : null;
  if (options.frozen && !snapshot)
    throw new Error(
      "Frozen pull requires a complete schema 2 or 3 .vardum.lock; run vardum pull to refresh, then commit the snapshot",
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
    assertManifest(manifest, context.config, true);
    items = manifest.items;
  }
  validateOutputPaths(items.map((item) => item.outputPath));
  const identityWorkspace = !options.frozen || snapshot?.schema === 3
    ? context.config.workspace : undefined;
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
      identityWorkspace,
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
    schema: 3,
    delivery: "version-id-v1",
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
        identityWorkspace,
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

async function migrateLock(options: Options) {
  if (options.delete || options.force || options.values.size || options.positionals.length)
    throw new Error("migrate-lock accepts only --dry-run and --json; checked-in configuration is authoritative");
  const context = await loadContext();
  const lockPath = await safeLockPath(context.directory);
  const original = await readFile(lockPath, "utf8");
  const previous = validateLock(JSON.parse(original), context.config);
  if (previous.schema !== 2)
    throw new Error("migrate-lock requires a schema 2 snapshot; schema 1 needs an intentional normal pull, schema 3 already uses identity delivery");
  if (!context.client.authenticated)
    throw new Error("Migrating a snapshot needs a workspace read key: run vardum login, or set VARDUM_API_KEY");
  const entries = Object.entries(previous.items);
  if (entries.length > 1000) throw new Error("Snapshot migration supports at most 1000 outputs");
  const items = entries.map(([id, item]) => ({
    id, versionId: item.versionId,
    transformation: snapshotTransformation(new URL(validateSnapshotUrl(item.downloadUrl, item.versionId, context.config.server))),
  }));
  const entry = report("migrate", ".vardum.lock", options);
  if (options.dryRun) return summary(options, 1);
  const resolved = await context.client.resolveSnapshot(context.config.workspace, items);
  if (resolved?.delivery !== "version-id-v1" || !Array.isArray(resolved.items) || resolved.items.length !== entries.length)
    throw new Error("Server returned an unsupported snapshot migration response");
  const next: Lockfile = { ...previous, schema: 3, delivery: "version-id-v1", items: Object.create(null) };
  const transformations = new Map(items.map(item => [item.id, canonicalSnapshotTransformation(item.transformation)]));
  for (const item of resolved.items) {
    const old = item && typeof item.id === "string" && Object.hasOwn(previous.items, item.id) ? previous.items[item.id] : undefined;
    if (!old || Object.hasOwn(next.items, item.id) || item.versionId !== old.versionId || typeof item.downloadUrl !== "string")
      throw new Error("Server returned different or duplicate snapshot identities");
    const downloadUrl = validateSnapshotUrl(item.downloadUrl, old.versionId, context.config.server, context.config.workspace);
    if (canonicalSnapshotTransformation(snapshotTransformation(new URL(downloadUrl))) !== transformations.get(item.id))
      throw new Error("Server returned different snapshot transformations");
    next.items[item.id] = { ...old, downloadUrl };
  }
  validateLock(next, context.config);
  for (const [, item] of entries) await safeTarget(context.directory, item.path);
  for (const [id, item] of Object.entries(next.items)) {
    if (await context.client.downloadChecksum(item.downloadUrl) !== previous.items[id]!.checksum)
      throw new Error(`Locked checksum mismatch: ${item.path}; migration left files and lock unchanged`);
  }
  if (await readFile(lockPath, "utf8") !== original)
    throw new Error(".vardum.lock changed during migration; refusing to overwrite it");
  await writeLock(lockPath, next, context.config);
  entry.applied = true;
  summary(options, 1);
}

async function push(options: Options) {
  const context = await loadContext();
  requireApiKey(context.client);
  const lockPath = await safeLockPath(context.directory);
  const lock = await readLock(lockPath, context.config);
  if (!lock)
    throw new Error("Run vardum pull before pushing mapped outputs");
  const identity = lock.schema === 3;
  let manifest = await context.client.manifest(context.config, true, identity);
  assertManifest(manifest, context.config, identity);

  validateOutputPaths(manifest.items.map((item) => item.outputPath));
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
    const entry = report("push", item.outputPath, options);
    changed += 1;
    if (options.dryRun) continue;
    const bytes = await readFile(path);
    const mimeType = mimeForFilename(path);
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
    entry.applied = true;
    manifest = await waitForManifestVersion(
      context.client,
      context.config,
      item.id,
      previousVersion,
      identity,
    );
    const updated = manifest.items.find(({ id }) => id === item.id);
    assertManifest(manifest, context.config, identity);
    if (
      !updated?.versionId ||
      !updated.fingerprint ||
      !updated.downloadUrl ||
      updated.outputPath !== item.outputPath
    )
      throw new Error(
        `Uploaded output did not become ready: ${item.outputPath}`,
      );
    if (lock.schema !== 1) {
      validateSnapshotUrl(
        updated.downloadUrl,
        updated.versionId,
        context.config.server,
        identity ? context.config.workspace : undefined,
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
      ...(lock.schema !== 1
        ? {
            downloadUrl: validateSnapshotUrl(
              updated.downloadUrl,
              updated.versionId,
              context.config.server,
              identity ? context.config.workspace : undefined,
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
  if (!source)
    throw new Error("Usage: vardum push-folder <directory> [prefix]");
  const context = await loadContext();
  requireApiKey(context.client);
  const directory = resolve(source);
  const files = await imageFiles(directory);
  if (!files.length)
    throw new Error(
      `No images found in ${relative(process.cwd(), directory) || "."}`,
    );

  const prefix = await resolveFolderPrefix(
    options,
    positionalPrefix,
    context,
    directory,
    files,
  );
  if (prefix === null) return summary(options, 0);

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
  const outdated = local.filter((file) => {
    const existing = byKey.get(file.key);
    if (existing?.checksum !== file.checksum) return true;
    currentAssets[file.key] = existing.id;
    return false;
  });

  let changed = 0;
  // Uploads finalize as they go and processing is awaited once at the end:
  // waiting per file turned a 50-image folder into 50 sequential waits.
  const processing = new Map<string, string>();
  for (const [index, file] of outdated.entries()) {
    const entry = report(
      "push",
      file.key,
      options,
      `(${index + 1}/${outdated.length})`,
    );
    changed += 1;
    if (options.dryRun) continue;
    const target =
      byKey.get(file.key) ??
      (await context.client.createAsset(
        context.config.workspace,
        file.key,
        basename(file.relative),
      ));
    processing.set(
      file.key,
      await context.client.uploadVersion(
        context.config.workspace,
        target.id,
        basename(file.relative),
        file.mimeType,
        await readFile(file.absolute),
      ),
    );
    currentAssets[file.key] = target.id;
    entry.applied = true;
  }
  if (processing.size) {
    if (!options.json)
      console.log(`waiting for ${processing.size} upload(s) to process…`);
    await waitForAssetVersions(
      context.client,
      context.config.workspace,
      prefix,
      processing,
    );
  }

  if (options.delete) {
    const removable = Object.entries(previous).filter(
      ([key]) => !local.some((file) => file.key === key),
    );
    // Deleting an asset drops every stored version of it, so name them and ask
    // before doing it. CI (no TTY) keeps the old unattended behaviour.
    const confirmed =
      !removable.length ||
      options.force ||
      options.json ||
      !stdin.isTTY ||
      (await confirmDeletion(removable.map(([key]) => key)));
    for (const [key, assetId] of removable) {
      if (!confirmed) {
        currentAssets[key] = assetId; // stay tracked for the next run
        continue;
      }
      const entry = report("delete", key, options);
      changed += 1;
      if (!options.dryRun) {
        await context.client.deleteAsset(context.config.workspace, assetId);
        entry.applied = true;
      }
    }
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

function assertManifest(manifest: Manifest, config: VardConfig, identity = false) {
  if (manifest.schema !== 1 || manifest.id !== config.vard)
    throw new Error("Server returned a different or unsupported Vard manifest");
  if (manifest.workspaceId !== config.workspace)
    throw new Error("Vard does not belong to the configured workspace");
  if (identity && manifest.delivery !== "version-id-v1")
    throw new Error("Server does not support version-id-v1 delivery; upgrade the server before creating schema 3 snapshots");
}

/** Waits for every uploaded version to turn ready, one listing per round. */
async function waitForAssetVersions(
  client: VardumClient,
  workspaceId: string,
  prefix: string,
  pending: Map<string, string>,
) {
  const waiting = new Map(pending);
  for (let attempt = 0; attempt < 120 && waiting.size; attempt += 1) {
    const listing = await client.syncAssets(workspaceId, prefix);
    for (const asset of listing.assets)
      if (waiting.get(asset.key) === asset.versionId) waiting.delete(asset.key);
    if (!waiting.size) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Timed out waiting for asset processing: ${[...waiting.keys()].join(", ")}`,
  );
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
  identity = true,
) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const manifest = await client.manifest(config, true, identity);
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
    else if (["--server", "--workspace", "--vard"].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`${argument} requires a value`);
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
      JSON.stringify({ dryRun: options.dryRun, changed, actions }, null, 2),
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
  vardum migrate-lock [--dry-run] [--json]
  vardum push [--dry-run] [--force]
  vardum pull-asset <asset-key> <output-path> [--dry-run] [--force]
  vardum push-folder <directory> [prefix] [--dry-run] [--delete]

Options:
  --json  machine-readable output for CI; errors go to stderr as {"error"}.

Authentication:
  vardum login authorizes this machine in the browser and stores a
  workspace key scoped to your own permissions.
  VARDUM_API_KEY overrides that stored key, so CI stays explicit.

Safety:
  status is pull without writing anything, and reports local conflicts
  instead of refusing to run.
  Normal pull explicitly refreshes assets and creates a schema 3 identity snapshot.
  Commit vardum.json and .vardum.lock; CI uses pull --frozen to consume it
  without fetching the current manifest or changing the lock. Matching files
  need no download; downloaded SHA-256 is verified before replacement.
  --frozen refuses missing/legacy locks (run normal pull to refresh) and cannot
  use --delete. --force allows local replacement, never checksum bypass.
  Schema 2 frozen locks remain supported with their source-name limitations.
  migrate-lock explicitly upgrades schema 2 identities without changing files,
  versions or hashes; every remote output is verified before the lock changes.
  Frozen delivery still needs retained versions, valid signatures and an
  available same-origin server; redirects are refused. No latest fallback.
  --delete removes only files/assets tracked by a previous CLI run, and
  asks first when it would delete remote assets in a terminal.

Updates:
  vardum update detects whether the CLI is installed globally or locally
  and runs the correct package manager to pull the latest version.`);
}
