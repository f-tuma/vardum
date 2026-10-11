import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface } from "node:readline/promises";
import test from "node:test";
import type { AssetIdentity, SyncAsset, VardumClient } from "./client.js";
import { assertFolderSourcesCurrent, prepareFolderPlan, type FolderSourceCache } from "./folder-plan.js";
import { planPushFolder } from "./interactive.js";
import { checksum, imageFiles } from "./sync.js";

test("changing the TTY folder reuses bounded captures and execution rejects changed confirmed bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vardum-folder-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "icon.png");
  await writeFile(path, "same");
  const files = await imageFiles(root);
  const captured: FolderSourceCache = new Map();
  const requested: string[] = [];
  const client = {
    syncAssets: async (_workspace: string, prefix: string) => { requested.push(prefix); return { assets: [] }; },
    assetIdentities: async () => [],
    uploadLimits: async () => ({ image: 8, video: 16, file: 4 }),
  } as unknown as VardumClient;
  const answers = ["brand/mobile", "e", "brand/other/", ""];
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  let planned = 0;
  const result = await planPushFolder({ question: async () => answers.shift()! } as unknown as Interface,
    client, "workspace", root, files, async (prefix) => {
      const plan = await prepareFolderPlan(client, "workspace", prefix, files,
        { schema: 1, server: "http://fixture", workspace: "workspace", source: root, prefix, files: {} }, false, captured);
      if (++planned === 1) await writeFile(path, "edit");
      return plan;
    });
  assert.ok(result);
  assert.equal(result.prefix, "brand/other/");
  assert.equal(result.rows[0]!.key, "brand/other/icon");
  assert.equal(result.rows[0]!.checksum, checksum(Buffer.from("same")));
  assert.equal(captured.size, 1);
  assert.ok(!("bytes" in captured.get(path)!));
  assert.deepEqual(requested, ["", "brand/mobile/", "brand/other/"]);
  assert.ok(logs.some((line) => line.includes("icon.png → brand/mobile/icon")));
  assert.ok(logs.some((line) => line.includes("icon.png → brand/other/icon")));
  await assert.rejects(assertFolderSourcesCurrent(result), /changed since the folder plan/);
});

test("the ready current version governs skips while unfinished activity and journals require admission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vardum-folder-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "icon.png"), "same");
  const files = await imageFiles(root);
  const current = { id: "asset", key: "images/icon", displayName: "Original name", versionId: "ready-current",
    checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 } as SyncAsset;
  const identity: AssetIdentity = { id: "asset", key: current.key, displayName: current.displayName,
    status: "failed", latestVersionId: "failed-latest", hasUnfinishedUploads: false };
  const client = { syncAssets: async () => ({ assets: [current] }), assetIdentities: async () => [identity],
    uploadLimits: async () => ({ image: 8, video: 16, file: 4 }) } as unknown as VardumClient;
  const journal = { schema: 1 as const, server: "http://fixture", workspace: "workspace", source: root, prefix: "images/", files: {} };
  assert.equal((await prepareFolderPlan(client, "workspace", "images", files, journal, true)).rows[0]!.libraryAction, "skip");
  identity.hasUnfinishedUploads = true;
  assert.equal((await prepareFolderPlan(client, "workspace", "images", files, journal, true)).rows[0]!.libraryAction, "update");
  identity.hasUnfinishedUploads = false;
  const pending = { ...journal, files: { [current.key]: {
    key: current.key, relative: "icon.png", filename: "icon.png", displayName: current.displayName,
    checksum: current.checksum!, mimeType: current.mimeType, size: current.size,
    assetId: current.id, versionId: current.versionId, expectedCurrentVersionId: null,
    createAsset: true, assetCreated: true, phase: "ready" as const,
  } } };
  const plan = await prepareFolderPlan(client, "workspace", "images", files, pending, true);
  assert.equal(plan.rows[0]!.libraryAction, "new");
  assert.equal(plan.rows[0]!.resumed, true);
});
