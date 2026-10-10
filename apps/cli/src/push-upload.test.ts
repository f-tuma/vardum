import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VardumClient, type ManifestItem, type SyncAsset } from "./client.js";
import { checksum, imageFiles } from "./sync.js";
import { prepareFolderPlan } from "./folder-plan.js";
import { planPushFolder } from "./interactive.js";
import type { Interface } from "node:readline/promises";

const cli = process.env.VARDUM_TEST_CLI_PATH ?? fileURLToPath(new URL("./index.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
const v1 = "11111111-1111-4111-8111-111111111111";
const v2 = "22222222-2222-4222-8222-222222222222";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vardum-push-upload-"));
  const project = join(root, "project");
  const configHome = join(root, "config");
  await mkdir(project);
  await mkdir(join(configHome, "vardum"), { recursive: true });
  await writeFile(join(configHome, "vardum/version-check.json"), JSON.stringify({ latest: "0.0.0", at: Date.now() }));
  const output = join(project, "image.png");
  const original = Buffer.from("old");
  await writeFile(output, original);
  const state = {
    limits: { image: 8, video: 16, file: 4 } as unknown,
    limitsStatus: 200,
    assets: [] as SyncAsset[],
    unready: [] as Array<{ id: string; key: string; displayName: string }>,
    requests: [] as Array<{ method: string; url: string }>,
    created: [] as string[],
    createdNames: [] as string[],
    uploads: [] as Buffer[],
    uploadFilename: "",
    uploadMimeType: "",
    requestedSize: 0,
    assetId: "mapped",
    version: v1,
    bytes: original,
    capability: 1 as unknown,
    importCapability: 1 as unknown,
    importPlanStatus: 200,
    importStatus: 200,
    importResponseLost: false,
    malformedImportPlan: "",
    malformedImportApply: false,
    importPlans: [] as Array<any>,
    imports: [] as Array<any>,
    beforeImportPlanResponse: null as (() => Promise<void>) | null,
    mappings: new Map<string, { assetId: string; key: string; outputPath: string; mappingId: string }>(),
    createResponseLost: false,
    versionResponseLost: false,
    finalizeResponseLost: false,
    storageFailures: 0,
    storageFailAt: 0,
    finalizeMissingObject: false,
    finalizeRejected: false,
    deleteResponseLost: false,
    deleted: new Set<string>(),
    malformedVersion: false,
    omitIdentities: false,
    omitResumeMetadata: false,
    identityReads: 0,
    beforeIdentityRecheck: null as (() => Promise<void>) | null,
    omitIdentityKeys: new Set<string>(),
    processing: false,
    readyCurrentElsewhere: false,
    wrongReadyChecksum: false,
    versionStatus: null as "failed" | null,
    retryable: true,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    versionIntents: [] as Array<any>,
    retryRequests: 0,
    versions: new Map<string, any>(),
    assetRecords: new Map<string, any>(),
  };
  const item = (): ManifestItem => ({
    id: "output", assetId: "mapped", key: "image.png", outputPath: "image.png",
    writable: true, pinned: false, transformation: null, versionId: state.version,
    fingerprint: `${state.version}:`, downloadUrl: `/w/demo/__v/${state.version}/image.png`,
    sourceChecksum: checksum(state.bytes), mimeType: "image/png", size: state.bytes.length,
  });
  const server = createServer(async (req, res) => {
    const url = req.url!;
    state.requests.push({ method: req.method!, url });
    res.setHeader("content-type", "application/json");
    const parsed = new URL(url, "http://fixture");
    const listedPrefix = parsed.searchParams.get("prefix") ?? "";
    if (req.method === "GET" && ["/api/workspaces/workspace/sync/assets", "/api/workspaces/workspace/assets"].includes(parsed.pathname) &&
        !/^(?:[a-z0-9][a-z0-9._-]*\/)*$/.test(listedPrefix)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid folder prefix" }));
      return;
    }
    const jsonBody = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    if (url === "/api/capabilities") {
      res.end(JSON.stringify({ folderUploadResume: state.capability, folderVardImport: state.importCapability }));
    } else if (url.endsWith("/items/import-plan")) {
      const body = await jsonBody();
      state.importPlans.push(body);
      if (state.importPlanStatus !== 200) {
        res.statusCode = state.importPlanStatus;
        res.end(JSON.stringify({ error: state.importPlanStatus === 403 ? "Folder import permission denied" : "Projected folder rule collision" }));
        return;
      }
      const files = body.files.map((file: any) => {
        const current = state.assets.find((asset) => asset.id === file.assetId);
        const identity = state.assetRecords.get(file.assetId) ?? current ?? state.unready.find((asset) => asset.id === file.assetId);
        const unfinished = [...state.versions.values()].some((version) => version.assetId === file.assetId &&
          (["pending", "processing"].includes(version.status) || version.status === "failed" && version.retryable));
        const mapping = state.mappings.get(file.outputPath);
        return { ...file, versionId: current?.versionId ?? null,
          libraryAction: !identity ? "new" : current?.checksum === file.checksum && current.mimeType === file.mimeType && current.size === file.size && !unfinished ? "skip" : "update",
          mappingAction: mapping ? "keep" : "add", mappingId: mapping?.mappingId ?? null };
      });
      if (state.malformedImportPlan === "identity") files[0].assetId = randomUUID();
      if (state.malformedImportPlan === "checksum") files[0].checksum = "0".repeat(64);
      if (state.malformedImportPlan === "action") files[0].libraryAction = "other";
      if (state.malformedImportPlan === "mapping") { files[0].mappingAction = "keep"; files[0].mappingId = null; }
      if (state.malformedImportPlan === "version") { files[0].libraryAction = "skip"; files[0].versionId = null; }
      if (state.malformedImportPlan === "count") files.pop();
      if (state.beforeImportPlanResponse) await state.beforeImportPlanResponse();
      res.end(JSON.stringify({ files }));
    } else if (url.endsWith("/items/import")) {
      const body = await jsonBody();
      state.imports.push(body);
      if (state.importStatus !== 200) { res.statusCode = state.importStatus; res.end(JSON.stringify({ error: "Mapping apply rejected" })); return; }
      for (const file of body.files) {
        const current = state.assets.find((asset) => asset.id === file.assetId);
        const exact = state.versions.get(file.versionId);
        if (!exact || exact.status !== "ready" || current?.versionId !== file.versionId ||
            exact.checksum !== file.checksum || exact.mimeType !== file.mimeType || exact.size !== file.size) {
          res.statusCode = 409; res.end(JSON.stringify({ error: "Exact current ready version changed" })); return;
        }
      }
      const files = body.files.map((file: any) => {
        let mapping = state.mappings.get(file.outputPath);
        const kept = Boolean(mapping);
        if (!mapping) {
          mapping = { assetId: file.assetId, key: file.key, outputPath: file.outputPath, mappingId: randomUUID() };
          state.mappings.set(file.outputPath, mapping);
        }
        return { ...mapping, mappingAction: kept ? "kept" : "added" };
      });
      if (state.importResponseLost) { state.importResponseLost = false; req.socket.destroy(); return; }
      if (state.malformedImportApply) files[0].assetId = randomUUID();
      res.end(JSON.stringify({ files, added: files.filter((file: any) => file.mappingAction === "added").length,
        kept: files.filter((file: any) => file.mappingAction === "kept").length }));
    } else if (url === "/api/upload-limits") {
      res.statusCode = state.limitsStatus;
      res.end(JSON.stringify(state.limits));
    } else if (url.endsWith("/manifest")) {
      res.end(JSON.stringify({ schema: 1, id: "vard", workspaceId: "workspace", items: [item()] }));
    } else if (url.startsWith("/api/workspaces/workspace/sync/assets?")) {
      res.end(JSON.stringify({ workspaceSlug: "demo", assets: state.assets.filter((asset) => asset.key.startsWith(listedPrefix)), nextCursor: null }));
    } else if (url.startsWith("/api/workspaces/workspace/assets?")) {
      if (++state.identityReads === 2 && state.beforeIdentityRecheck) await state.beforeIdentityRecheck();
      const assets = new Map([...state.assets, ...state.unready].map((asset) => [asset.key, asset]));
      for (const asset of state.assetRecords.values()) if (!assets.has(asset.key)) assets.set(asset.key, asset);
      if (state.omitIdentities) assets.clear();
      for (const key of state.omitIdentityKeys) assets.delete(key);
      res.end(JSON.stringify({ assets: [...assets.values()].filter((asset) => asset.key.startsWith(listedPrefix) &&
        !asset.key.slice(listedPrefix.length).includes("/")).map((asset) => {
        const versions = [...state.versions.values()].filter((version) => version.assetId === asset.id).sort((a, b) => b.number - a.number);
        return { ...asset, latestVersionId: versions[0]?.id ?? null, status: versions[0]?.status ?? null,
          hasUnfinishedUploads: state.omitResumeMetadata ? undefined : versions.some((version) => ["pending", "processing"].includes(version.status) || version.status === "failed" && version.retryable) };
      }), nextCursor: null }));
    } else if (url.startsWith("/api/workspaces/workspace/assets/") && req.method === "DELETE") {
      const id = url.split("/").at(-1)!;
      if (state.deleted.has(id)) { res.statusCode = 404; res.end(JSON.stringify({ error: "Asset not found" })); return; }
      state.deleted.add(id);
      if (state.deleteResponseLost) { state.deleteResponseLost = false; req.socket.destroy(); return; }
      res.statusCode = 204;
      res.end();
    } else if (url === "/api/workspaces/workspace/assets" && req.method === "POST") {
      const body = await jsonBody();
      if (body.id && state.assetRecords.has(body.id)) {
        res.end(JSON.stringify(state.assetRecords.get(body.id)));
        return;
      }
      state.created.push(body.key);
      state.createdNames.push(body.displayName);
      state.assetId = body.id ?? randomUUID();
      const asset = { ...body, id: state.assetId };
      state.assetRecords.set(asset.id, asset);
      if (state.createResponseLost) { state.createResponseLost = false; req.socket.destroy(); return; }
      res.end(JSON.stringify(asset));
    } else if (url.endsWith("/versions")) {
      const body = await jsonBody();
      state.requestedSize = body.size;
      state.uploadFilename = body.filename;
      state.uploadMimeType = body.mimeType;
      state.assetId = decodeURIComponent(url.split("/").at(-2)!);
      let version = body.id && state.versions.get(body.id);
      if (!version && body.id && [...state.versions.values()].some((value) => value.assetId === state.assetId &&
          (["pending", "processing"].includes(value.status) || value.status === "failed" && value.retryable) &&
          (value.expectedChecksum !== body.expectedChecksum || value.filename !== body.filename || value.mimeType !== body.mimeType || value.size !== body.size))) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: "Asset has another unfinished upload. Finish or retry that upload before pushing this file" }));
        return;
      }
      if (!version) {
        version = [...state.versions.values()].find((value) => value.assetId === state.assetId && value.expectedChecksum === body.expectedChecksum && body.expectedChecksum && value.filename === body.filename && value.mimeType === body.mimeType && value.size === body.size);
      }
      if (!version) {
        version = { id: body.id ?? v2, assetId: state.assetId, number: state.versions.size + 1,
          filename: body.filename, mimeType: body.mimeType, size: body.size,
          expectedChecksum: body.expectedChecksum ?? null, checksum: null,
          status: state.versionStatus ?? "pending", retryable: state.retryable,
          error: state.versionStatus ? "fixture processing failure" : null, expiresAt: state.expiresAt };
        state.versions.set(version.id, version);
        state.versionIntents.push(body);
      }
      if (state.versionResponseLost) { state.versionResponseLost = false; req.socket.destroy(); return; }
      if (state.malformedVersion) { res.end(JSON.stringify({ id: version.id, upload: { method: "POST", url: `${origin}/storage`, fields: {} } })); return; }
      res.end(JSON.stringify({ ...version, ...(version.status === "pending" ? { upload: { method: "POST", url: `${origin}/storage`, fields: { policy: "fixture" } } } : {}) }));
    } else if (/\/versions\/[^/]+$/.test(url) && req.method === "GET") {
      const version = state.versions.get(url.split("/").at(-1)!);
      if (!version) { res.statusCode = 404; res.end(JSON.stringify({ error: "Version not found" })); return; }
      res.end(JSON.stringify({ ...version, checksum: state.wrongReadyChecksum && version.status === "ready" ? checksum(Buffer.from("wrong")) : version.checksum }));
    } else if (url === "/storage") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = new Request(`${origin}/storage`, {
        method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(chunks),
      });
      const form = await body.formData();
      const file = form.get("file") as File;
      assert.equal(form.get("policy"), "fixture");
      assert.equal(file.name, state.uploadFilename);
      assert.equal(file.type, state.uploadMimeType);
      state.uploads.push(Buffer.from(await file.arrayBuffer()));
      if (state.storageFailures) { state.storageFailures--; res.statusCode = 503; }
      if (state.storageFailAt === state.uploads.length) res.statusCode = 503;
      res.end("{}");
    } else if (url.endsWith("/finalize")) {
      if (state.finalizeMissingObject) { state.finalizeMissingObject = false; res.statusCode = 409; res.end(JSON.stringify({ error: "Upload not found" })); return; }
      if (state.finalizeRejected) { res.statusCode = 409; res.end(JSON.stringify({ error: "Uploaded object does not match the version" })); return; }
      const version = state.versions.get(url.split("/").at(-2)!);
      version.status = state.processing ? "processing" : "ready";
      version.checksum = checksum(state.uploads.at(-1)!);
      state.version = version.id;
      state.bytes = state.uploads.at(-1)!;
      const key = state.assetRecords.get(state.assetId)?.key ?? [...state.assets, ...state.unready].find((asset) => asset.id === state.assetId)?.key ?? "image.png";
      state.assets = [...state.assets.filter((asset) => asset.id !== state.assetId), {
        id: state.assetId, key, displayName: state.uploadFilename,
        versionId: state.readyCurrentElsewhere ? v1 : version.id, checksum: checksum(state.bytes), mimeType: state.uploadMimeType, size: state.bytes.length,
      }];
      if (state.finalizeResponseLost) { state.finalizeResponseLost = false; req.socket.destroy(); return; }
      res.statusCode = 204;
      res.end();
    } else if (url.endsWith("/retry")) {
      state.retryRequests++;
      const version = state.versions.get(url.split("/").at(-2)!);
      version.status = "ready";
      version.checksum = version.expectedChecksum;
      version.error = null;
      res.statusCode = 204;
      res.end();
    } else if (url.startsWith("/w/demo/__v/")) {
      res.end(state.bytes);
    } else {
      res.statusCode = 404;
      res.end("missing fixture route");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = { schema: 1, server: origin, workspace: "workspace", vard: "vard" };
  await writeFile(join(project, "vardum.json"), JSON.stringify(config));
  const lockPath = join(project, ".vardum.lock");
  await writeFile(lockPath, JSON.stringify({
    schema: 2, server: origin, workspace: "workspace", vard: "vard", items: {
      output: { path: "image.png", versionId: v1, fingerprint: `${v1}:`, checksum: checksum(original), downloadUrl: `${origin}/w/demo/__v/${v1}/image.png` },
    },
  }));
  const preload = join(root, "edit-file.mjs");
  // Test-only interception puts an edit precisely between the folder plan and
  // reread, or after a mapped read closes. Production has no environment hook.
  await writeFile(preload, `
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import readline from "node:readline/promises";
const originalOpen = fs.open;
if (process.env.VARDUM_TEST_CANCEL_FOLDER) {
  Object.defineProperty(process.stdin, "isTTY", { value: true });
  const answers = ["images", "q"];
  readline.createInterface = () => ({ question: async () => {
    const answer = answers.shift();
    if (!answers.length && process.env.VARDUM_TEST_CANCEL_FOLDER === "eof") throw new Error("Aborted with Ctrl+D");
    return answer;
  }, close() {} });
}
if (process.env.VARDUM_TEST_CRASH_IMPORT) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith("/items/import") && response.ok) process.exit(77);
    return response;
  };
}
if (process.env.VARDUM_TEST_FAST_TIMERS) {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 500 ? 1 : ms, ...args);
}
let opened = 0;
fs.open = async (path, flags, ...rest) => {
  if (process.env.VARDUM_TEST_TRACKING_PATH && String(path).startsWith(process.env.VARDUM_TEST_TRACKING_PATH + ".") && flags & constants.O_WRONLY)
    throw Object.assign(new Error("fixture tracking write failure"), { code: "EIO" });
  if (path !== process.env.VARDUM_TEST_PATH || flags !== (constants.O_RDONLY | constants.O_NONBLOCK)) return originalOpen(path, flags, ...rest);
  opened++;
  const edit = process.env.VARDUM_TEST_EDIT;
  if (opened === 2) {
    if (edit === "rewrite") await fs.writeFile(path, "changed");
    if (edit === "oversize") await fs.truncate(path, 100);
    if (edit === "remove") await fs.rm(path);
    if (edit === "directory") { await fs.rm(path); await fs.mkdir(path); }
  }
  const handle = await originalOpen(path, flags, ...rest);
  if (opened === 1 && edit === "after-close") {
    const originalClose = handle.close.bind(handle);
    handle.close = async () => { await originalClose(); await fs.writeFile(path, "changed"); };
  }
  return handle;
};
syncBuiltinESMExports();
`);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  let edit = "";
  let editPath = output;
  let authenticated = true;
  let fastTimers = false;
  let failTracking = false;
  let crashImport = false;
  let cancelFolder = "";
  const run = (...args: string[]) => new Promise<{ code: number; data: any }>((resolve) => {
    execFile(process.execPath, ["--import", tsx, ...(edit || fastTimers || failTracking || crashImport || cancelFolder ? ["--import", preload] : []), cli, ...args, ...(cancelFolder ? [] : ["--json"])], {
      cwd: project,
      env: { PATH: process.env.PATH, VARDUM_CONFIG_HOME: configHome, VARDUM_API_KEY: authenticated ? "test-key" : "", VARDUM_TEST_EDIT: edit, VARDUM_TEST_PATH: editPath, VARDUM_TEST_FAST_TIMERS: fastTimers ? "1" : "", VARDUM_TEST_TRACKING_PATH: failTracking ? join(project, ".vardum.push.lock") : "", VARDUM_TEST_CRASH_IMPORT: crashImport ? "1" : "", VARDUM_TEST_CANCEL_FOLDER: cancelFolder },
      timeout: 10000,
    }, (error, stdout, stderr) => {
      const code = error ? Number(error.code) : 0;
      const output = code ? stderr : stdout;
      resolve({ code, data: cancelFolder ? { stdout, stderr } : output.trim() ? JSON.parse(output) : {} });
    });
  });
  return {
    project, output, state, origin, lockPath, run,
    setEdit(value: string, path = output) { edit = value; editPath = path; },
    unauthenticated() { authenticated = false; },
    fastTimers() { fastTimers = true; },
    failTracking(value = true) { failTracking = value; },
    crashImport(value = true) { crashImport = value; },
    cancelFolder(value = "q") { cancelFolder = value; },
    mutations: () => state.requests.filter(({ method, url }) => method !== "GET" && !url.endsWith("/items/import-plan")),
    lock: async () => JSON.parse(await readFile(lockPath, "utf8")),
  };
}

test("mapped push sends the bytes it hashed even if the file changes after capture, and advances its verified lock", async (t) => {
  const f = await fixture(t);
  const captured = Buffer.from([0, 1, 2, 255, 13, 10, 128, 5]);
  await writeFile(f.output, captured);
  f.setEdit("after-close");
  const result = await f.run("push");
  assert.equal(result.code, 0, result.data.error);
  assert.deepEqual(f.state.uploads, [captured]);
  assert.equal(f.state.requestedSize, captured.length);
  assert.equal(await readFile(f.output, "utf8"), "changed");
  const locked = (await f.lock()).items.output;
  assert.equal(locked.checksum, checksum(captured));
  assert.equal(locked.versionId, v2);
  assert.equal(locked.fingerprint, `${v2}:`);
  assert.equal(locked.downloadUrl, `${f.origin}/w/demo/__v/${v2}/image.png`);
  assert.deepEqual(result.data.actions.map((action: any) => action.applied), [true]);
  assert.equal(f.state.requests.filter(({ url }) => url === "/api/upload-limits").length, 1);
});

test("mapped dry-run and unchanged files still reject unavailable or malformed limits, oversize and empty contents before mutations", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.lockPath, "utf8");
  for (const dryRun of [false, true]) {
    const args = dryRun ? ["--dry-run"] : [];
    f.state.limitsStatus = 503;
    assert.match((await f.run("push", ...args)).data.error, /503/);
    f.state.limitsStatus = 200;
    for (const invalid of [null, [], {}, { image: "8", video: 16, file: 4 }, { image: 8, video: 16, file: 0 }, { image: 8.5, video: 16, file: 4 }, { image: 8, video: Number.MAX_SAFE_INTEGER + 1, file: 4 }]) {
      f.state.limits = invalid;
      assert.match((await f.run("push", ...args)).data.error, /invalid upload limits/);
    }
    f.state.limits = { image: 2, video: 16, file: 4 };
    assert.match((await f.run("push", ...args)).data.error, /limit/); // "old" matches the lock, but is over the ceiling.
    f.state.limits = { image: 8, video: 16, file: 4 };
    await writeFile(f.output, "");
    assert.match((await f.run("push", ...args)).data.error, /non-empty/);
    await writeFile(f.output, "old");
  }
  assert.deepEqual(f.mutations(), []);
  assert.equal(await readFile(f.lockPath, "utf8"), before);
});

test("mapped dry-run, conflict, force, authentication and symlink guards retain their behavior", async (t) => {
  const f = await fixture(t);
  await writeFile(f.output, "edit");
  const before = await readFile(f.lockPath, "utf8");
  const dry = await f.run("push", "--dry-run");
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.data.actions.map((action: any) => action.applied), [false]);
  assert.equal(await readFile(f.lockPath, "utf8"), before);
  f.state.version = v2;
  assert.match((await f.run("push")).data.error, /diverged/);
  assert.deepEqual(f.mutations(), []);
  f.state.version = v1;
  const lock = await f.lock();
  lock.items.output.fingerprint = "old fingerprint";
  await writeFile(f.lockPath, JSON.stringify(lock));
  assert.equal((await f.run("push", "--force")).code, 0);
  const after = f.mutations().length;
  await rm(f.output);
  assert.match((await f.run("push")).data.error, /Writable output is missing/);
  assert.equal(f.mutations().length, after);
  await symlink(join(f.project, "elsewhere.png"), f.output);
  assert.match((await f.run("push")).data.error, /symlink/);
  assert.equal(f.mutations().length, after);
  f.unauthenticated();
  f.state.requests.length = 0;
  assert.match((await f.run("push")).data.error, /key|login/i);
  assert.deepEqual(f.state.requests, []);
});

test("folder push sends bounded multipart bytes and persists asset tracking after processing; unchanged and dry-run paths validate", async (t) => {
  const f = await fixture(t);
  const folder = join(f.project, "folder");
  await mkdir(folder);
  const path = join(folder, "clip.mp4");
  const bytes = Buffer.from([0, 255, 1, 2, 13, 10, 42, 43, 44]);
  await writeFile(path, bytes); // Above the image ceiling, below the video ceiling.
  const dry = await f.run("push-folder", "folder", "media", "--dry-run");
  assert.equal(dry.code, 0, dry.data.error);
  assert.deepEqual(f.mutations(), []);
  await assert.rejects(readFile(join(f.project, ".vardum.push.lock")), /ENOENT/);
  const result = await f.run("push-folder", "folder", "media");
  assert.equal(result.code, 0, result.data.error);
  assert.deepEqual(f.state.created, ["media/clip"]);
  assert.deepEqual(f.state.createdNames, ["clip"]);
  assert.equal(f.state.uploadFilename, "clip.mp4");
  assert.deepEqual(f.state.uploads, [bytes]);
  const lockPath = join(f.project, ".vardum.push.lock");
  const before = await readFile(lockPath, "utf8");
  assert.deepEqual(JSON.parse(before).entries["folder:media/"].assets, { "media/clip": f.state.assetId });
  assert.equal((await f.run("push-folder", "folder", "media")).data.changed, 0);
  f.state.limits = { image: 8, video: 8, file: 4 };
  const mutations = f.mutations().length;
  for (const args of [[], ["--dry-run"]])
    assert.match((await f.run("push-folder", "folder", "media", ...args)).data.error, /limit/);
  assert.equal(f.mutations().length, mutations);
  assert.equal(await readFile(lockPath, "utf8"), before);
});

test("root folder tracking retains constructor keys across repeated pushes", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, "folder"));
  await writeFile(join(f.project, "folder/constructor.png"), "same");
  const first = await f.run("push-folder", "folder", "");
  assert.equal(first.code, 0, first.data.error);
  assert.deepEqual(f.state.created, ["constructor"]);
  const second = await f.run("push-folder", "folder", "");
  assert.equal(second.code, 0, second.data.error);
  assert.equal(second.data.changed, 0);
  const lock = JSON.parse(await readFile(join(f.project, ".vardum.push.lock"), "utf8"));
  assert.deepEqual(lock.entries["folder:"].assets, { constructor: f.state.assetId });
});

test("library-only plans agree with TTY for exact mixed actions and paired normalized prefixes without writes", async (t) => {
  const f = await fixture(t);
  const folder = join(f.project, "folder");
  await mkdir(folder);
  for (const name of ["alpha.png", "icon.png", "legacy.png", "update.png"]) await writeFile(join(folder, name), "same");
  const ready = (key: string, bytes = "same"): SyncAsset => ({ id: key, key, displayName: "Original display name",
    versionId: v1, checksum: checksum(Buffer.from(bytes)), mimeType: "image/png", size: bytes.length });
  f.state.assets = [ready("brand/mobile/icon"), ready("brand/mobile/legacy.png"), ready("brand/mobile/update", "old")];
  const client = new VardumClient(f.origin, "test-key");
  // The fixture rejects the original wire bug, rather than silently accepting any prefix.
  await assert.rejects(client.syncAssets("workspace", "brand/mobile"), /400/);
  f.state.requests.length = 0;
  const configBefore = await readFile(join(f.project, "vardum.json"));
  const lockBefore = await readFile(f.lockPath);
  const cachePath = join(f.project, "../config/vardum/version-check.json");
  await rm(cachePath);
  const one = await f.run("push-folder", "folder", "brand/mobile", "--dry-run");
  const two = await f.run("push-folder", "folder", "brand/mobile/", "--dry-run");
  assert.equal(one.code, 0, one.data.error);
  assert.deepEqual(two.data, one.data);
  assert.deepEqual(one.data.library.map((row: any) => [row.source, row.key, row.libraryAction]), [
    ["alpha.png", "brand/mobile/alpha", "new"], ["icon.png", "brand/mobile/icon", "skip"],
    ["legacy.png", "brand/mobile/legacy.png", "skip"], ["update.png", "brand/mobile/update", "update"],
  ]);
  assert.equal(one.data.changed, 2);
  assert.deepEqual(one.data.actions, [
    { action: "push", path: "brand/mobile/alpha", applied: false },
    { action: "push", path: "brand/mobile/update", applied: false },
  ]);
  assert.ok(one.data.library.every((row: any) => row.applied === false));
  assert.match(one.data.library[1].notice, /Reusing existing asset/);
  assert.match(one.data.library[2].notice, /Preserving existing filename key/);
  assert.equal(one.data.library[1].assetId, "brand/mobile/icon");
  assert.equal(one.data.library[2].assetId, "brand/mobile/legacy.png");
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  const answers = ["brand/mobile", ""];
  const prompts = { question: async () => answers.shift()! } as unknown as Interface;
  const files = await imageFiles(folder);
  const selected = await planPushFolder(prompts, client, "workspace", folder, files, (prefix) =>
    prepareFolderPlan(client, "workspace", prefix, files,
      { schema: 1, server: f.origin, workspace: "workspace", source: folder, prefix, files: {} }, false));
  assert.ok(selected);
  assert.deepEqual(selected.rows.map((row) => [row.source, row.key, row.libraryAction]),
    one.data.library.map((row: any) => [row.source, row.key, row.libraryAction]));
  assert.ok(logs.some((line) => line.includes("1 new asset") && line.includes("1 update version") && line.includes("2 skip identical")));
  assert.ok(logs.some((line) => line.includes("icon.png → brand/mobile/icon")));
  assert.ok(logs.some((line) => line.includes("legacy.png → brand/mobile/legacy.png")));
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(await readFile(join(f.project, "vardum.json")), configBefore);
  assert.deepEqual(await readFile(f.lockPath), lockBefore);
  for (const name of [".vardum.push.lock", ".vardum.push.pending.json", ".vardum.push.mutex"])
    await assert.rejects(readFile(join(f.project, name)), /ENOENT/);
  await assert.rejects(readFile(cachePath), /ENOENT/);
});

test("library plans block known stem/filename ambiguity before local or remote mutations", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, "folder"));
  await writeFile(join(f.project, "folder/icon.png"), "same");
  f.state.unready = ["brand/mobile/icon", "brand/mobile/icon.png"].map((key) => ({ id: randomUUID(), key, displayName: key }));
  for (const flags of [[], ["--dry-run"]]) {
    const result = await f.run("push-folder", "folder", "brand/mobile", ...flags);
    assert.match(result.data.error, /Both brand\/mobile\/icon and brand\/mobile\/icon.png exist/);
    assert.deepEqual(result.data.actions, []);
    assert.deepEqual(f.mutations(), []);
  }
  for (const name of [".vardum.push.lock", ".vardum.push.pending.json", ".vardum.push.mutex"])
    await assert.rejects(readFile(join(f.project, name)), /ENOENT/);
});

test("a confirmed mixed plan rejects changes to a skipped source or remote target before any upload", async (t) => {
  for (const drift of ["source", "remote"]) {
    const f = await fixture(t);
    await mkdir(join(f.project, "folder"));
    await writeFile(join(f.project, "folder/alpha.png"), "same");
    const skipPath = join(f.project, "folder/skip.png");
    await writeFile(skipPath, "same");
    f.state.assets = [{ id: randomUUID(), key: "images/skip", displayName: "skip", versionId: v1,
      checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 }];
    f.state.beforeIdentityRecheck = async () => {
      if (drift === "source") await writeFile(skipPath, "edit");
      else f.state.assets[0] = { ...f.state.assets[0]!, versionId: v2 };
    };
    const result = await f.run("push-folder", "folder", "images");
    assert.equal(result.code, 1, drift);
    assert.match(result.data.error, /changed.*folder plan/, drift);
    assert.deepEqual(result.data.actions, [], drift);
    assert.deepEqual(result.data.library.map((row: any) => [row.libraryAction, row.applied]), [["new", false], ["skip", false]]);
    assert.deepEqual(f.mutations(), [], drift);
    for (const name of [".vardum.push.lock", ".vardum.push.pending.json", ".vardum.push.mutex"])
      await assert.rejects(readFile(join(f.project, name)), /ENOENT/);
  }
});

test("legacy dry-run reports unavailable upload activity without negotiating or inventing safe completion", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, "folder"));
  await writeFile(join(f.project, "folder/icon.png"), "same");
  f.state.assets = [{ id: randomUUID(), key: "images/icon", displayName: "icon", versionId: v1,
    checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 }];
  f.state.omitResumeMetadata = true;
  const dry = await f.run("push-folder", "folder", "images", "--dry-run");
  assert.equal(dry.code, 0, dry.data.error);
  assert.equal(dry.data.library[0].libraryAction, "skip");
  assert.equal(dry.data.library[0].uncertain, true);
  assert.equal(dry.data.library[0].applied, false);
  assert.deepEqual(dry.data.actions, []);
  assert.ok(!f.state.requests.some(({ url }) => url === "/api/capabilities"));
  const push = await f.run("push-folder", "folder", "images");
  assert.match(push.data.error, /missing hasUnfinishedUploads/);
  assert.deepEqual(f.mutations(), []);
});

test("TTY quit and EOF cancellation leave the update cache, sources, locks and remote library untouched", async (t) => {
  for (const cancel of ["q", "eof"]) {
    const f = await fixture(t);
    await mkdir(join(f.project, "folder"));
    const source = join(f.project, "folder/icon.png");
    await writeFile(source, "same");
    const configBefore = await readFile(join(f.project, "vardum.json"));
    const lockBefore = await readFile(f.lockPath);
    const cache = join(f.project, "../config/vardum/version-check.json");
    await rm(cache);
    f.cancelFolder(cancel);
    const result = await f.run("push-folder", "folder");
    assert.equal(result.code, cancel === "q" ? 0 : 1, result.data.stderr);
    assert.match(result.data.stdout, /icon.png → images\/icon/);
    if (cancel === "eof") assert.match(result.data.stderr, /cancelled/);
    assert.deepEqual(f.mutations(), []);
    assert.equal(await readFile(source, "utf8"), "same");
    assert.deepEqual(await readFile(join(f.project, "vardum.json")), configBefore);
    assert.deepEqual(await readFile(f.lockPath), lockBefore);
    await assert.rejects(readFile(cache), /ENOENT/);
    for (const name of [".vardum.push.lock", ".vardum.push.pending.json", ".vardum.push.mutex"])
      await assert.rejects(readFile(join(f.project, name)), /ENOENT/);
  }
});

test("folder naming collisions fail before any asset or upload mutation", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, "folder"));
  await writeFile(join(f.project, "folder/logo.png"), "png");
  await writeFile(join(f.project, "folder/logo.webp"), "webp");
  for (const args of [[], ["--dry-run"]]) {
    const result = await f.run("push-folder", "folder", "images", ...args);
    assert.match(result.data.error, /same asset key/);
    assert.deepEqual(f.mutations(), []);
  }
  await assert.rejects(readFile(join(f.project, ".vardum.push.lock")), /ENOENT/);
});

test("folder push preserves a published filename key, original name and versions on repeat", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("same");
  await mkdir(join(f.project, "folder"));
  await writeFile(join(f.project, "folder/logo.png"), bytes);
  f.state.assets = [{ id: "legacy", key: "images/logo.png", displayName: "logo", versionId: v1,
    checksum: checksum(bytes), mimeType: "image/png", size: bytes.length }];
  const result = await f.run("push-folder", "folder", "images");
  assert.equal(result.code, 0, result.data.error);
  assert.equal(result.data.changed, 0);
  assert.deepEqual(f.mutations(), []);
  assert.equal(JSON.parse(await readFile(join(f.project, ".vardum.push.lock"), "utf8"))
    .entries["folder:images/"].assets["images/logo.png"], "legacy");
});

test("legacy aliases cannot collapse two files onto one target and unready identities are reused", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, "folder"));
  await writeFile(join(f.project, "folder/logo.png"), "png");
  await writeFile(join(f.project, "folder/logo.png.webp"), "webp");
  f.state.assets = [{ id: "legacy", key: "images/logo.png", displayName: "logo", versionId: v1,
    checksum: checksum(Buffer.from("png")), mimeType: "image/png", size: 3 }];
  assert.match((await f.run("push-folder", "folder", "images")).data.error, /same asset key/);
  assert.deepEqual(f.mutations(), []);
  await rm(join(f.project, "folder/logo.png.webp"));
  f.state.unready = [{ id: randomUUID(), key: "images/logo.png", displayName: "logo.png" }];
  f.state.assets = [];
  const result = await f.run("push-folder", "folder", "images");
  assert.equal(result.code, 0, result.data.error);
  assert.deepEqual(f.state.created, []);
  assert.equal(result.data.actions[0].assetId, f.state.unready[0]!.id);
});

test("folder tracking aliases merge before delete even when the next prefix ends with a slash", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, "folder"));
  await writeFile(join(f.project, "folder/logo.png"), "same");
  f.state.assets = [{ id: "current", key: "images/logo", displayName: "logo", versionId: v1,
    checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 }];
  const pushLockPath = join(f.project, ".vardum.push.lock");
  await writeFile(pushLockPath, JSON.stringify({ schema: 1, workspace: "workspace", entries: {
    "folder:images": { directory: "folder", prefix: "images", assets: { "images/removed.png": "removed" } },
    "folder:images/": { directory: "folder", prefix: "images/", assets: { "images/logo": "current" } },
  } }));
  const result = await f.run("push-folder", "folder", "images/", "--delete");
  assert.equal(result.code, 0, result.data.error);
  assert.deepEqual(result.data.actions, [{ action: "delete", path: "images/removed.png", applied: true }]);
  const updated = JSON.parse(await readFile(pushLockPath, "utf8"));
  assert.deepEqual(Object.keys(updated.entries), ["folder:images/"]);
  assert.deepEqual(updated.entries["folder:images/"].assets, { "images/logo": "current" });
});

test("folder read failures or changed planned bytes cannot create an empty remote asset or advance its lock", async (t) => {
  for (const edit of ["rewrite", "oversize", "remove", "directory"]) {
    const f = await fixture(t);
    const folder = join(f.project, "folder");
    await mkdir(folder);
    const path = join(folder, "image.png");
    await writeFile(path, "plan");
    f.setEdit(edit, path);
    const result = await f.run("push-folder", "folder", "images");
    assert.equal(result.code, 1, edit);
    assert.match(result.data.error, /changed since the folder plan|limit|ENOENT|regular file/, edit);
    assert.deepEqual(f.state.created, [], edit);
    assert.deepEqual(f.mutations(), [], edit);
    assert.deepEqual(result.data.actions.map((action: any) => action.applied), [false], edit);
    await assert.rejects(readFile(join(f.project, ".vardum.push.lock")), /ENOENT/, edit);
  }
});

test("folder sparse oversize and endpoint failures reject before remote asset creation even in dry-run", async (t) => {
  const f = await fixture(t);
  const folder = join(f.project, "folder");
  await mkdir(folder);
  const path = join(folder, "large.png");
  await writeFile(path, "");
  await truncate(path, 2 ** 32 + 1);
  for (const args of [[], ["--dry-run"]]) {
    assert.match((await f.run("push-folder", "folder", "images", ...args)).data.error, /limit/);
    f.state.limitsStatus = 503;
    assert.match((await f.run("push-folder", "folder", "images", ...args)).data.error, /503/);
    f.state.limitsStatus = 200;
    f.state.limits = { image: 8, video: 16 }; // A missing unused ceiling still fails closed.
    assert.match((await f.run("push-folder", "folder", "images", ...args)).data.error, /invalid upload limits/);
    f.state.limits = { image: 8, video: 16, file: 4 };
  }
  assert.deepEqual(f.mutations(), []);
});

test("the client's final upload guard rejects a direct over-limit byte array before signing or storage", async (t) => {
  const f = await fixture(t);
  const client = new VardumClient(f.origin, "test-key");
  await assert.rejects(client.uploadVersion("workspace", "mapped", "big.png", "image/png", Buffer.alloc(9)), /limit/);
  assert.deepEqual(f.mutations(), []);
  await assert.rejects(client.uploadVersion("workspace", "mapped", "empty.png", "image/png", Buffer.alloc(0)), /non-empty/);
  assert.equal(f.state.requests.length, 1); // Valid limits are cached across all guards.
});

async function folderFixture(t: test.TestContext, name = "logo.png", prefix = "images") {
  const f = await fixture(t);
  const folder = join(f.project, "folder");
  await mkdir(folder);
  await writeFile(join(folder, name), "same");
  const pendingPath = join(f.project, ".vardum.push.pending.json");
  return {
    ...f, folder, pendingPath,
    pending: async () => JSON.parse(await readFile(pendingPath, "utf8")),
    push: (...args: string[]) => f.run("push-folder", "folder", prefix, ...args),
  };
}

test("folder response loss replays the durable asset/version IDs and completes without a second version", async (t) => {
  for (const failure of ["createResponseLost", "versionResponseLost", "finalizeResponseLost"] as const) {
    const f = await folderFixture(t);
    f.state[failure] = true;
    const first = await f.push();
    assert.equal(first.code, 1, failure);
    const journal = await f.pending();
    const intent = journal.files["images/logo"];
    assert.equal(journal.server, f.origin);
    assert.equal(journal.workspace, "workspace");
    assert.equal(journal.source, f.folder);
    assert.equal(journal.prefix, "images/");
    assert.equal(intent.checksum, checksum(Buffer.from("same")));
    assert.equal(intent.size, 4);
    assert.equal(intent.filename, "logo.png");
    assert.equal(intent.displayName, "logo");
    assert.equal(intent.mimeType, "image/png");
    assert.equal(first.data.actions[0].assetId, intent.assetId);
    assert.equal(first.data.actions[0].versionId, intent.versionId);
    assert.equal(first.data.actions[0].applied, false);
    assert.equal(intent.phase, { createResponseLost: "asset-create-requested", versionResponseLost: "version-create-requested", finalizeResponseLost: "finalize-requested" }[failure]);
    assert.doesNotMatch(await readFile(f.pendingPath, "utf8"), /test-key|\/storage|policy|uploadUrl/);
    await assert.rejects(readFile(join(f.project, ".vardum.push.mutex")), /ENOENT/);
    const second = await f.push();
    assert.equal(second.code, 0, second.data.error);
    assert.equal(second.data.actions[0].phase, "ready");
    assert.equal(second.data.actions[0].applied, true);
    assert.equal(second.data.actions[0].assetId, intent.assetId);
    assert.equal(second.data.actions[0].versionId, intent.versionId);
    assert.equal(f.state.created.length, 1);
    assert.equal(f.state.versions.size, 1);
    assert.equal(f.state.uploads.length, 1);
    assert.equal(f.state.versionIntents[0].id, intent.versionId);
    assert.equal(f.state.versionIntents[0].expectedCurrentVersionId, null);
    assert.equal(f.state.versionIntents[0].expectedChecksum, intent.checksum);
    await assert.rejects(readFile(f.pendingPath), /ENOENT/);
    const third = await f.push();
    assert.equal(third.code, 0, third.data.error);
    assert.equal(third.data.changed, 0);
    assert.equal(f.state.versions.size, 1);
  }
});

test("storage failure resumes the same pending intent; partial JSON identifies completed and pending files", async (t) => {
  const f = await folderFixture(t, "alpha.png");
  await writeFile(join(f.folder, "constructor.png"), "same");
  f.state.storageFailAt = 2;
  const first = await f.push();
  assert.equal(first.code, 1);
  assert.match(first.data.error, /Storage upload failed/);
  assert.deepEqual(first.data.actions.map((action: any) => [action.phase, action.applied]), [["ready", true], ["upload-requested", false]]);
  assert.deepEqual(first.data.library.map((row: any) => [row.source, row.libraryAction, row.phase, row.applied]),
    [["alpha.png", "new", "ready", true], ["constructor.png", "new", "upload-requested", false]]);
  const journal = await f.pending();
  assert.equal(journal.files["images/alpha"].phase, "ready");
  assert.equal(journal.files["images/constructor"].phase, "upload-requested");
  const second = await f.push();
  assert.equal(second.code, 0, second.data.error);
  assert.equal(f.state.created.length, 2);
  assert.equal(f.state.versions.size, 2);
  assert.equal(f.state.uploads.length, 3);
  assert.deepEqual(second.data.actions.map((action: any) => action.applied), [true, true]);
  assert.ok(second.data.library.every((row: any) => row.resumed === true && row.libraryAction === "new"));
  assert.equal((await f.push()).data.changed, 0);
});

test("a pending constructor file can be planned after reading a partially populated JSON journal", async (t) => {
  const f = await folderFixture(t, "alpha.png", "");
  await writeFile(join(f.folder, "constructor.png"), "same");
  f.state.storageFailures = 1;
  assert.equal((await f.push()).code, 1);
  assert.deepEqual(Object.keys((await f.pending()).files), ["alpha"]);
  const result = await f.push();
  assert.equal(result.code, 0, result.data.error);
  assert.equal(f.state.versions.size, 2);
});

test("processing timeout resumes exact version completion even when a newer version is current", async (t) => {
  const f = await folderFixture(t);
  f.fastTimers();
  f.state.processing = true;
  f.state.readyCurrentElsewhere = true;
  const first = await f.push();
  assert.equal(first.code, 1);
  assert.match(first.data.error, /Timed out.*resume/);
  assert.equal(first.data.actions[0].phase, "processing");
  assert.equal(first.data.actions[0].applied, false);
  const version = [...f.state.versions.values()][0];
  const mutations = f.mutations().length;
  version.status = "ready";
  const second = await f.push();
  assert.equal(second.code, 0, second.data.error);
  assert.equal(second.data.actions[0].versionId, version.id);
  assert.equal(second.data.actions[0].applied, true);
  assert.equal(f.mutations().length, mutations);
  assert.equal(f.state.versions.size, 1);
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.assets[0]!.versionId, v1);
});

test("an existing unready asset adopts its matching active version and preserves its original name", async (t) => {
  const f = await folderFixture(t);
  const assetId = randomUUID();
  const versionId = randomUUID();
  f.state.assetRecords.set(assetId, { id: assetId, key: "images/logo", displayName: "Original name" });
  f.state.versions.set(versionId, {
    id: versionId, assetId, number: 1, status: "pending", filename: "logo.png",
    mimeType: "image/png", size: 4, expectedChecksum: checksum(Buffer.from("same")),
    checksum: null, retryable: false, error: null, expiresAt: f.state.expiresAt,
  });
  const result = await f.push();
  assert.equal(result.code, 0, result.data.error);
  assert.equal(result.data.actions[0].assetId, assetId);
  assert.equal(result.data.actions[0].versionId, versionId);
  assert.equal(f.state.versions.size, 1);
  assert.deepEqual(f.state.created, []);
  assert.equal(f.state.assetRecords.get(assetId).displayName, "Original name");
  assert.equal((await f.push()).data.changed, 0);
});

test("a lost adoption response finds the same actual ready version after its intent ID was never inserted", async (t) => {
  const f = await folderFixture(t);
  const assetId = randomUUID();
  const versionId = randomUUID();
  f.state.assetRecords.set(assetId, { id: assetId, key: "images/logo", displayName: "Original name" });
  const version = {
    id: versionId, assetId, number: 1, status: "pending", filename: "logo.png",
    mimeType: "image/png", size: 4, expectedChecksum: checksum(Buffer.from("same")),
    checksum: null as string | null, retryable: false, error: null, expiresAt: f.state.expiresAt,
  };
  f.state.versions.set(versionId, version);
  f.state.versionResponseLost = true;
  const lost = await f.push();
  assert.equal(lost.code, 1);
  const intent = (await f.pending()).files["images/logo"];
  assert.notEqual(intent.versionId, versionId);
  assert.equal(intent.phase, "version-create-requested");
  assert.deepEqual([lost.data.library[0].versionId, lost.data.library[0].phase, lost.data.library[0].applied],
    [intent.versionId, intent.phase, false]);
  version.status = "ready";
  version.checksum = version.expectedChecksum;
  f.state.assets = [{ id: assetId, key: "images/logo", displayName: "Original name", versionId,
    checksum: version.checksum!, mimeType: "image/png", size: 4 }];
  const result = await f.push();
  assert.equal(result.code, 0, result.data.error);
  assert.equal(result.data.actions[0].versionId, versionId);
  assert.equal(result.data.actions[0].applied, true);
  assert.equal(result.data.library[0].versionId, versionId);
  assert.equal(result.data.library[0].phase, "ready");
  assert.equal(result.data.library[0].applied, true);
  assert.equal(f.state.versions.size, 1);
  assert.equal(f.state.uploads.length, 0);
});

test("unchanged ready bytes still enter admission when any unfinished upload contains different bytes", async (t) => {
  for (const unfinishedStatus of ["pending", "processing", "failed"] as const) {
    const f = await folderFixture(t);
    const assetId = randomUUID();
    const versionId = randomUUID();
    f.state.assets = [{ id: assetId, key: "images/logo", displayName: "Original name", versionId: v2,
      checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 }];
    f.state.versions.set(v2, { id: v2, assetId, number: 2, status: "ready", filename: "logo.png",
      mimeType: "image/png", size: 4, expectedChecksum: checksum(Buffer.from("same")),
      checksum: checksum(Buffer.from("same")), retryable: false, error: null, expiresAt: f.state.expiresAt });
    f.state.versions.set(versionId, { id: versionId, assetId, number: 1, status: unfinishedStatus, filename: "logo.png",
      mimeType: "image/png", size: 4, expectedChecksum: checksum(Buffer.from("edit")),
      checksum: null, retryable: true, error: null, expiresAt: f.state.expiresAt });
    const result = await f.push();
    assert.equal(result.code, 1, unfinishedStatus);
    assert.match(result.data.error, /another unfinished upload/);
    assert.equal(result.data.actions[0].applied, false);
    assert.equal(result.data.actions[0].phase, "version-create-requested");
    assert.equal(f.state.versions.size, 2);
    assert.equal(f.state.uploads.length, 0);
    assert.equal(f.state.created.length, 0);
    assert.equal((await f.pending()).files["images/logo"].expectedCurrentVersionId, v2);
  }
});

test("contradictory sync and identity listings fail before recording or mutating an intent", async (t) => {
  for (const scenario of ["replaced", "deleted"]) {
    const f = await folderFixture(t);
    f.state.assets = [{ id: randomUUID(), key: "images/logo", displayName: "Original name", versionId: v1,
      checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 }];
    if (scenario === "replaced") f.state.unready = [{ id: randomUUID(), key: "images/logo", displayName: "Replacement" }];
    else f.state.omitIdentities = true;
    assert.match((await f.push()).data.error, /changed asset identity during the folder plan/);
    assert.deepEqual(f.mutations(), []);
    await assert.rejects(readFile(f.pendingPath), /ENOENT/);
  }
});

test("unrelated nested sync assets need no identity lookup when the local file is unchanged", async (t) => {
  const f = await folderFixture(t);
  const localId = randomUUID();
  f.state.assets = [
    { id: localId, key: "images/logo", displayName: "Original name", versionId: v1,
      checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 },
    { id: randomUUID(), key: "images/unrelated/nested", displayName: "Unrelated", versionId: v2,
      checksum: checksum(Buffer.from("other")), mimeType: "image/png", size: 5 },
  ];
  f.state.omitIdentityKeys.add("images/unrelated/nested");
  const result = await f.push();
  assert.equal(result.code, 0, result.data.error);
  assert.equal(result.data.changed, 0);
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(JSON.parse(await readFile(join(f.project, ".vardum.push.lock"), "utf8"))
    .entries["folder:images/"].assets, { "images/logo": localId });
});

test("a missing previously accepted version cannot be silently recreated", async (t) => {
  const f = await folderFixture(t);
  f.state.storageFailures = 1;
  assert.equal((await f.push()).code, 1);
  const before = await readFile(f.pendingPath, "utf8");
  f.state.versions.clear();
  const mutations = f.mutations().length;
  const result = await f.push();
  assert.equal(result.code, 1);
  assert.match(result.data.error, /Previously accepted version.*missing/);
  assert.equal(f.mutations().length, mutations);
  assert.equal(await readFile(f.pendingPath, "utf8"), before);
});

test("ready exact versions must match the durable checksum before tracking or applied flags advance", async (t) => {
  const f = await folderFixture(t);
  f.state.wrongReadyChecksum = true;
  const result = await f.push();
  assert.equal(result.code, 1);
  assert.match(result.data.error, /checksum differs/);
  assert.equal(result.data.actions[0].applied, false);
  await assert.rejects(readFile(join(f.project, ".vardum.push.lock")), /ENOENT/);
  assert.equal((await f.pending()).files["images/logo"].versionId, result.data.actions[0].versionId);
  f.state.wrongReadyChecksum = false;
  assert.equal((await f.push()).code, 0);
  assert.equal(f.state.versions.size, 1);
});

test("failed retryable versions use retry; failed nonretryable and expired uploads retain actionable journals", async (t) => {
  const f = await folderFixture(t);
  f.state.storageFailures = 1;
  assert.equal((await f.push()).code, 1);
  const version = [...f.state.versions.values()][0];
  version.status = "failed";
  version.retryable = true;
  version.error = "temporary processor failure";
  const result = await f.push();
  assert.equal(result.code, 0, result.data.error);
  assert.equal(f.state.retryRequests, 1);
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.versions.size, 1);
  for (const scenario of ["failed", "expired"]) {
    const blocked = await folderFixture(t);
    if (scenario === "failed") { blocked.state.versionStatus = "failed"; blocked.state.retryable = false; }
    else blocked.state.expiresAt = new Date(Date.now() - 1000).toISOString();
    const first = await blocked.push();
    assert.equal(first.code, 1);
    assert.match(first.data.error, /inspect asset.*archive .*pending.*new upload/i);
    assert.equal(blocked.state.uploads.length, 0);
    assert.equal(blocked.state.retryRequests, 0);
    const intent = (await blocked.pending()).files["images/logo"];
    assert.equal(first.data.actions[0].versionId, intent.versionId);
    await blocked.push();
    assert.equal(blocked.state.versions.size, 1);
    assert.equal(blocked.state.uploads.length, 0);
  }
});

test("missing storage objects are reuploaded once using the same intent while unrelated finalize conflicts stop", async (t) => {
  const f = await folderFixture(t);
  f.state.finalizeMissingObject = true;
  const result = await f.push();
  assert.equal(result.code, 0, result.data.error);
  assert.equal(f.state.uploads.length, 2);
  assert.equal(f.state.versions.size, 1);
  const blocked = await folderFixture(t);
  blocked.state.finalizeRejected = true;
  assert.match((await blocked.push()).data.error, /does not match/);
  assert.equal(blocked.state.uploads.length, 1);
  assert.equal((await blocked.pending()).files["images/logo"].phase, "finalize-requested");
});

test("capability negotiation and malformed protocol responses fail before unsafe mutations", async (t) => {
  for (const capability of [undefined, 0, "1", true, null]) {
    const f = await folderFixture(t);
    f.state.capability = capability;
    const result = await f.push();
    assert.equal(result.code, 1);
    assert.match(result.data.error, /folderUploadResume/);
    assert.deepEqual(f.mutations(), []);
    await assert.rejects(readFile(f.pendingPath), /ENOENT/);
    await assert.rejects(readFile(join(f.project, ".vardum.push.mutex")), /ENOENT/);
  }
  const f = await folderFixture(t);
  f.state.malformedVersion = true;
  assert.match((await f.push()).data.error, /invalid resumable/);
  assert.equal(f.state.uploads.length, 0);
  assert.equal((await f.pending()).files["images/logo"].phase, "version-create-requested");
});

test("pending context and changed bytes fail closed; dry-run preserves every local journal and tracking byte", async (t) => {
  const f = await folderFixture(t);
  f.state.storageFailures = 1;
  assert.equal((await f.push()).code, 1);
  const before = await readFile(f.pendingPath, "utf8");
  const configPath = join(f.project, "vardum.json");
  const originalConfig = await readFile(configPath, "utf8");
  const mutations = f.mutations().length;
  for (const patch of [{ workspace: "other" }, { server: `${f.origin}/different` }]) {
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(originalConfig), ...patch }));
    assert.match((await f.push()).data.error, /different server, workspace, source directory or prefix/);
    assert.equal(await readFile(f.pendingPath, "utf8"), before);
  }
  await writeFile(configPath, originalConfig);
  assert.match((await f.run("push-folder", "folder", "other")).data.error, /different server, workspace, source directory or prefix/);
  await mkdir(join(f.project, "other-folder"));
  await writeFile(join(f.project, "other-folder/logo.png"), "same");
  assert.match((await f.run("push-folder", "other-folder", "images")).data.error, /different server, workspace, source directory or prefix/);
  await writeFile(join(f.folder, "logo.png"), "edit");
  assert.match((await f.push()).data.error, /differs from the pending upload/);
  await writeFile(join(f.folder, "logo.png"), "same");
  const dry = await f.push("--dry-run");
  assert.equal(dry.code, 0, dry.data.error);
  assert.equal(dry.data.actions[0].phase, "upload-requested");
  assert.equal(dry.data.actions[0].applied, false);
  assert.equal(await readFile(f.pendingPath, "utf8"), before);
  assert.equal(f.mutations().length, mutations);
  await assert.rejects(readFile(join(f.project, ".vardum.push.lock")), /ENOENT/);
  await assert.rejects(readFile(join(f.project, ".vardum.push.mutex")), /ENOENT/);
});

test("folder state symlinks and a held local process mutex cannot be followed or overwritten", async (t) => {
  for (const filename of [".vardum.push.pending.json", ".vardum.push.lock", ".vardum.push.mutex"]) {
    const f = await folderFixture(t);
    const target = join(f.project, "outside-state");
    await writeFile(target, "keep me");
    await symlink(target, join(f.project, filename));
    assert.match((await f.push()).data.error, /symlink|unsafe/);
    assert.equal(await readFile(target, "utf8"), "keep me");
    assert.deepEqual(f.mutations(), []);
  }
  const f = await folderFixture(t);
  const path = join(f.project, ".vardum.push.mutex");
  const lock = JSON.stringify({ pid: process.pid });
  await writeFile(path, lock);
  assert.match((await f.push()).data.error, /Another folder push/);
  assert.equal(await readFile(path, "utf8"), lock);
  assert.deepEqual(f.mutations(), []);
  await writeFile(path, JSON.stringify({ pid: 2147483647 }));
  assert.match((await f.push()).data.error, /interrupted.*remove.*Keep .*pending/);
  assert.deepEqual(f.mutations(), []);
});

test("lost delete responses can be retried when the tracked asset is already absent", async (t) => {
  const f = await folderFixture(t);
  f.state.assets = [{ id: randomUUID(), key: "images/logo", displayName: "logo", versionId: v1,
    checksum: checksum(Buffer.from("same")), mimeType: "image/png", size: 4 }];
  const deletedId = randomUUID();
  await writeFile(join(f.project, ".vardum.push.lock"), JSON.stringify({ schema: 1, server: f.origin, workspace: "workspace", entries: {
    "folder:images/": { directory: "folder", prefix: "images/", assets: { "images/removed": deletedId } },
  } }));
  f.state.deleteResponseLost = true;
  assert.equal((await f.push("--delete")).code, 1);
  const second = await f.push("--delete");
  assert.equal(second.code, 0, second.data.error);
  assert.deepEqual(second.data.actions, [{ action: "delete", path: "images/removed", applied: true }]);
  assert.equal(f.state.deleted.size, 1);
});

function readyFolderAsset(f: Awaited<ReturnType<typeof folderFixture>>, key = "images/logo", bytes = "same", filename = "logo.png") {
  const assetId = randomUUID();
  const versionId = randomUUID();
  const hash = checksum(Buffer.from(bytes));
  f.state.assets.push({ id: assetId, key, displayName: "Existing source", versionId,
    checksum: hash, mimeType: "image/png", size: Buffer.byteLength(bytes) });
  f.state.versions.set(versionId, { id: versionId, assetId, number: 1, status: "ready", filename,
    mimeType: "image/png", size: Buffer.byteLength(bytes), expectedChecksum: hash,
    checksum: hash, retryable: false, error: null, expiresAt: null });
  return { assetId, versionId };
}

test("--output uploads sources and adds exact original output paths without pulling or changing the delivery lock", async (t) => {
  const f = await folderFixture(t, "logo.jpg");
  await mkdir(join(f.folder, "nested"));
  await writeFile(join(f.folder, "nested/icon.svg"), "same");
  const lockBefore = await readFile(f.lockPath, "utf8");
  const result = await f.push("--output", "assets/images/");
  assert.equal(result.code, 0, result.data.error);
  assert.equal(f.state.versions.size, 2);
  assert.equal(f.state.imports.length, 1);
  assert.deepEqual(f.state.imports[0].files.map((file: any) => file.outputPath), ["assets/images/logo.jpg", "assets/images/nested/icon.svg"]);
  assert.deepEqual(result.data.library.map((file: any) => [file.libraryAction, file.applied]), [["new", true], ["new", true]]);
  assert.deepEqual(result.data.mappings.map((file: any) => [file.mappingAction, file.result, file.applied]), [["add", "added", true], ["add", "added", true]]);
  assert.equal(await readFile(f.lockPath, "utf8"), lockBefore);
  assert.equal(await readFile(join(f.folder, "logo.jpg"), "utf8"), "same");
  await assert.rejects(readFile(join(f.project, "assets/images/logo.jpg")), /ENOENT/);
  await assert.rejects(readFile(f.pendingPath), /ENOENT/);
  const repeat = await f.push("--output", "assets/images");
  assert.equal(repeat.code, 0, repeat.data.error);
  assert.equal(repeat.data.changed, 0);
  assert.equal(f.state.versions.size, 2);
  assert.equal(f.state.uploads.length, 2);
  assert.equal(f.state.mappings.size, 2);
  assert.deepEqual(repeat.data.library.map((file: any) => file.libraryAction), ["skip", "skip"]);
  assert.deepEqual(repeat.data.mappings.map((file: any) => file.result), ["kept", "kept"]);
  assert.equal(f.state.imports[1].files.length, 2); // Even keep/skip sources are revalidated.
});

test("new-mode dry-run preflights and reports new/update/skip separately from add/keep without local writes", async (t) => {
  const f = await folderFixture(t);
  await writeFile(join(f.folder, "alpha.png"), "same");
  await writeFile(join(f.folder, "update.png"), "same");
  const existing = readyFolderAsset(f);
  readyFolderAsset(f, "images/update", "old");
  f.state.mappings.set("outputs/logo.png", { ...existing, key: "images/logo", outputPath: "outputs/logo.png", mappingId: "existing-mapping" });
  const cachePath = join(f.project, "../config/vardum/version-check.json");
  await rm(cachePath);
  const lockBefore = await readFile(f.lockPath, "utf8");
  const result = await f.push("--output", "outputs", "--dry-run");
  assert.equal(result.code, 0, result.data.error);
  assert.deepEqual(result.data.library.map((file: any) => file.libraryAction), ["new", "skip", "update"]);
  assert.deepEqual(result.data.mappings.map((file: any) => file.mappingAction), ["add", "keep", "add"]);
  assert.ok([...result.data.library, ...result.data.mappings].every((file) => file.applied === false));
  assert.equal(result.data.changed, 4);
  assert.equal(f.state.importPlans.length, 1);
  assert.equal(f.state.imports.length, 0);
  assert.deepEqual(f.mutations(), []);
  for (const path of [f.pendingPath, join(f.project, ".vardum.push.mutex"), join(f.project, ".vardum.push.lock"), cachePath])
    await assert.rejects(readFile(path), /ENOENT/);
  assert.equal(await readFile(f.lockPath, "utf8"), lockBefore);
});

test("unchanged source adds a mapping after exact ready verification without creating a version, including a different original filename", async (t) => {
  const f = await folderFixture(t);
  const existing = readyFolderAsset(f, "images/logo", "same", "original-name.png");
  const result = await f.push("--output", "");
  assert.equal(result.code, 0, result.data.error);
  assert.equal(f.state.created.length, 0);
  assert.equal(f.state.uploads.length, 0);
  assert.equal(f.state.versions.size, 1);
  assert.equal(result.data.library[0].libraryAction, "skip");
  assert.equal(result.data.mappings[0].outputPath, "logo.png");
  assert.equal(f.state.imports[0].files[0].versionId, existing.versionId);
  assert.ok(f.state.requests.some(({ method, url }) => method === "GET" && url.endsWith(`/versions/${existing.versionId}`)));
});

test("all source identities are journaled before the first upload; skip mapping and failed upload resume together", async (t) => {
  const f = await folderFixture(t, "alpha.png");
  await writeFile(join(f.folder, "skip.png"), "same");
  const skip = readyFolderAsset(f, "images/skip");
  f.state.storageFailures = 1;
  const first = await f.push("--output", "outputs");
  assert.equal(first.code, 1);
  const journal = await f.pending();
  assert.equal(journal.schema, 2);
  assert.equal(journal.vard, "vard");
  assert.equal(journal.outputPrefix, "outputs/");
  assert.deepEqual(Object.keys(journal.files), ["images/alpha", "images/skip"]);
  assert.equal(journal.files["images/skip"].versionId, skip.versionId);
  assert.equal(journal.files["images/skip"].phase, "ready");
  assert.equal(journal.files["images/skip"].mappingPhase, "planned");
  assert.equal(f.state.imports.length, 0);
  assert.equal(first.data.library.length, 2);
  const second = await f.push("--output", "outputs/");
  assert.equal(second.code, 0, second.data.error);
  assert.equal(f.state.versions.size, 2);
  assert.equal(f.state.imports[0].files.length, 2);
  assert.equal(f.state.imports[0].files.find((file: any) => file.key === "images/skip").versionId, skip.versionId);
});

test("lost mapping apply responses retain ready intents and retry with identical IDs without a new version or duplicate mapping", async (t) => {
  const f = await folderFixture(t);
  f.state.importResponseLost = true;
  const first = await f.push("--output", "outputs");
  assert.equal(first.code, 1);
  const intent = (await f.pending()).files["images/logo"];
  assert.equal(intent.phase, "ready");
  assert.equal(intent.mappingPhase, "apply-requested");
  assert.equal(first.data.library[0].applied, true);
  assert.equal(first.data.mappings[0].applied, false);
  assert.match(first.data.appliedMeaning, /false does not rule out remote changes/);
  assert.equal(f.state.mappings.size, 1);
  const second = await f.push("--output", "outputs");
  assert.equal(second.code, 0, second.data.error);
  assert.deepEqual(f.state.imports[0].files, f.state.imports[1].files);
  assert.equal(second.data.mappings[0].result, "kept");
  assert.equal(f.state.versions.size, 1);
  assert.equal(f.state.created.length, 1);
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.mappings.size, 1);
});

test("a crash after remote mapping apply resumes the durable request after removing only its abandoned mutex", async (t) => {
  const f = await folderFixture(t);
  f.crashImport();
  const first = await f.push("--output", "outputs");
  assert.equal(first.code, 77);
  assert.equal(f.state.mappings.size, 1);
  assert.equal((await f.pending()).files["images/logo"].mappingPhase, "apply-requested");
  assert.match((await f.push("--output", "outputs")).data.error, /interrupted.*mutex/);
  f.crashImport(false);
  await rm(join(f.project, ".vardum.push.mutex"));
  const second = await f.push("--output", "outputs");
  assert.equal(second.code, 0, second.data.error);
  assert.deepEqual(f.state.imports[0].files, f.state.imports[1].files);
  assert.equal(f.state.versions.size, 1);
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.mappings.size, 1);
});

test("tracking failures report completed mappings and preserve their ready journal for a no-new-version retry", async (t) => {
  const f = await folderFixture(t);
  f.failTracking();
  const first = await f.push("--output", "outputs");
  assert.equal(first.code, 1);
  assert.match(first.data.error, /tracking write failure/);
  assert.equal(first.data.library[0].applied, true);
  assert.equal(first.data.mappings[0].applied, true);
  const journal = await f.pending();
  assert.equal(journal.files["images/logo"].phase, "ready");
  assert.equal(journal.files["images/logo"].mappingPhase, "applied");
  assert.equal(journal.files["images/logo"].mappingId, first.data.mappings[0].mappingId);
  f.state.importPlanStatus = 403;
  const rejectedRetry = await f.push("--output", "outputs");
  assert.match(rejectedRetry.data.error, /permission denied/);
  assert.equal(rejectedRetry.data.library[0].applied, true);
  assert.equal(rejectedRetry.data.mappings[0].applied, true);
  f.state.importPlanStatus = 200;
  f.failTracking(false);
  const second = await f.push("--output", "outputs");
  assert.equal(second.code, 0, second.data.error);
  assert.equal(f.state.versions.size, 1);
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.mappings.size, 1);
});

test("--output requires both exact capabilities before journal or mutex creation, including dry-run", async (t) => {
  for (const capability of [undefined, 0, "1", true, null]) {
    const f = await folderFixture(t);
    f.state.importCapability = capability;
    for (const flags of [[], ["--dry-run"]]) {
      const result = await f.push("--output", "outputs", ...flags);
      assert.equal(result.code, 1);
      assert.match(result.data.error, /folderVardImport/);
      assert.deepEqual(f.mutations(), []);
      assert.equal(f.state.importPlans.length, 0);
      await assert.rejects(readFile(f.pendingPath), /ENOENT/);
      await assert.rejects(readFile(join(f.project, ".vardum.push.mutex")), /ENOENT/);
    }
  }
  const f = await folderFixture(t);
  f.state.capability = 0;
  assert.match((await f.push("--output", "outputs", "--dry-run")).data.error, /folderUploadResume/);
  assert.deepEqual(f.mutations(), []);
});

test("permission and projected collision rejections are preflighted before uploads, journal, tracking, or mutex writes", async (t) => {
  for (const status of [403, 409]) {
    const f = await folderFixture(t);
    f.state.importPlanStatus = status;
    for (const flags of [[], ["--dry-run"]]) {
      const result = await f.push("--output", "outputs", ...flags);
      assert.equal(result.code, 1);
      assert.match(result.data.error, status === 403 ? /permission denied/ : /rule collision/);
      assert.deepEqual(f.mutations(), []);
      for (const path of [f.pendingPath, join(f.project, ".vardum.push.mutex"), join(f.project, ".vardum.push.lock")])
        await assert.rejects(readFile(path), /ENOENT/);
    }
  }
});

test("--output rejects invalid prefixes, files, complete paths, flag combinations and extra arguments before remote writes", async (t) => {
  const f = await folderFixture(t);
  for (const args of [
    ["--output", "/absolute"], ["--output", "../escape"], ["--output", "a//b"],
    ["--output", "a\\b"], ["--output", "con"], ["--output", "a."], ["--output", ".git"],
    ["--output", "a".repeat(256)], ["--output", "outputs", "--delete"],
    ["--output", "outputs", "--force"], ["--output", "outputs", "--output", "other"],
    ["--output", "outputs", "extra"], ["--output", "outputs", "--vard", "other"],
  ]) {
    const result = await f.push(...args);
    assert.equal(result.code, 1, args.join(" "));
    assert.deepEqual(f.mutations(), []);
  }
  assert.equal((await f.run("push", "--output", "outputs")).code, 1);
  await writeFile(join(f.folder, "aux.png"), "same");
  assert.match((await f.push("--output", "outputs")).data.error, /Unsafe output path/);
  await rm(join(f.folder, "aux.png"));
  await mkdir(join(f.folder, "nested"));
  await writeFile(join(f.folder, "nested", `${"a".repeat(240)}.png`), "same");
  assert.match((await f.push("--output", `${"a".repeat(250)}/${"b".repeat(4)}`)).data.error, /at most 500/);
  assert.deepEqual(f.mutations(), []);
  assert.equal(f.state.importPlans.length, 0);
});

test("schema 1 library journals cannot retarget into Vards; schema 2 journals reject downgrade, Vard and output changes", async (t) => {
  const library = await folderFixture(t);
  library.state.storageFailures = 1;
  assert.equal((await library.push()).code, 1);
  const before = await readFile(library.pendingPath, "utf8");
  const mutations = library.mutations().length;
  assert.match((await library.push("--output", "outputs")).data.error, /different folder mode/);
  assert.equal(await readFile(library.pendingPath, "utf8"), before);
  assert.equal(library.mutations().length, mutations);
  const f = await folderFixture(t);
  f.state.importStatus = 503;
  assert.equal((await f.push("--output", "outputs")).code, 1);
  const original = await readFile(f.pendingPath, "utf8");
  const initialMutations = f.mutations().length;
  assert.match((await f.push()).data.error, /different folder mode/);
  assert.match((await f.push("--output", "other")).data.error, /different Vard or output prefix/);
  const configPath = join(f.project, "vardum.json");
  await writeFile(configPath, JSON.stringify({ schema: 1, server: f.origin, workspace: "workspace", vard: "other" }));
  assert.match((await f.push("--output", "outputs")).data.error, /different Vard or output prefix/);
  assert.equal(await readFile(f.pendingPath, "utf8"), original);
  assert.equal(f.mutations().length, initialMutations);
});

test("malformed import plans cannot authorize local state or uploads; malformed apply responses retain exact ready retry state", async (t) => {
  for (const malformed of ["identity", "checksum", "action", "mapping", "version", "count"]) {
    const f = await folderFixture(t);
    f.state.malformedImportPlan = malformed;
    assert.match((await f.push("--output", "outputs")).data.error, /invalid folder import plan/);
    assert.deepEqual(f.mutations(), []);
    await assert.rejects(readFile(f.pendingPath), /ENOENT/);
  }
  const f = await folderFixture(t);
  f.state.malformedImportApply = true;
  assert.match((await f.push("--output", "outputs")).data.error, /invalid folder import apply/);
  assert.equal((await f.pending()).files["images/logo"].phase, "ready");
  assert.equal((await f.pending()).files["images/logo"].mappingPhase, "apply-requested");
  f.state.malformedImportApply = false;
  assert.equal((await f.push("--output", "outputs")).code, 0);
  assert.equal(f.state.versions.size, 1);
  assert.equal(f.state.mappings.size, 1);
});

test("concurrent current-version updates cannot retarget a ready pending source to a historical version", async (t) => {
  const f = await folderFixture(t);
  f.state.importStatus = 503;
  assert.equal((await f.push("--output", "outputs")).code, 1);
  const original = await readFile(f.pendingPath, "utf8");
  const originalId = f.state.assets[0]!.versionId;
  f.state.assets[0]!.versionId = randomUUID();
  f.state.importStatus = 200;
  const mutations = f.mutations().length;
  const result = await f.push("--output", "outputs");
  assert.match(result.data.error, /exact ready version as current/);
  assert.equal(result.data.library[0].applied, true);
  assert.equal(result.data.mappings[0].applied, false);
  assert.equal(f.mutations().length, mutations);
  assert.equal(await readFile(f.pendingPath, "utf8"), original);
  assert.notEqual(f.state.assets[0]!.versionId, originalId);
  assert.equal(f.state.mappings.size, 0);
});

test("an import preserves unrelated tracking from another folder push completed during its preflight", async (t) => {
  const f = await folderFixture(t);
  const trackingPath = join(f.project, ".vardum.push.lock");
  const oldEntry = { directory: "previous", prefix: "historic/", assets: { "historic/old": randomUUID() } };
  await writeFile(trackingPath, JSON.stringify({ schema: 1, server: f.origin, workspace: "workspace",
    entries: { "previous:historic/": oldEntry } }));
  await mkdir(join(f.project, "other-folder"));
  await writeFile(join(f.project, "other-folder/other.png"), "same");
  let interleaved = false;
  f.state.beforeImportPlanResponse = async () => {
    f.state.beforeImportPlanResponse = null;
    // The import has already read tracking but has not acquired its mutex.
    // Run an actual second command to completion while its plan is held open.
    await assert.rejects(readFile(join(f.project, ".vardum.push.mutex")), /ENOENT/);
    const other = await f.run("push-folder", "other-folder", "elsewhere");
    assert.equal(other.code, 0, other.data.error);
    await assert.rejects(readFile(f.pendingPath), /ENOENT/);
    await assert.rejects(readFile(join(f.project, ".vardum.push.mutex")), /ENOENT/);
    interleaved = true;
  };
  const result = await f.push("--output", "outputs");
  assert.equal(result.code, 0, result.data.error);
  assert.equal(interleaved, true);
  const tracking = JSON.parse(await readFile(trackingPath, "utf8"));
  assert.deepEqual(tracking.entries["previous:historic/"], oldEntry);
  const otherAsset = f.state.assets.find((asset) => asset.key === "elsewhere/other")!;
  assert.deepEqual(tracking.entries["other-folder:elsewhere/"], {
    directory: "other-folder", prefix: "elsewhere/", assets: { "elsewhere/other": otherAsset.id },
  });
  assert.equal(tracking.entries["folder:images/"].assets["images/logo"], result.data.library[0].assetId);
});

test("an import revalidates its confirmed authoritative plan before any journal or upload writes", async (t) => {
  for (const drift of ["collision", "mapping", "version", "action"]) {
    const f = await folderFixture(t);
    if (drift === "version" || drift === "action") readyFolderAsset(f);
    const lockBefore = await readFile(f.lockPath);
    f.state.beforeImportPlanResponse = async () => {
      f.state.beforeImportPlanResponse = null;
      if (drift === "collision") f.state.importPlanStatus = 409;
      if (drift === "mapping") {
        const file = f.state.importPlans[0].files[0];
        f.state.mappings.set("outputs/logo.png", { ...file, mappingId: "concurrent-mapping" });
      }
      if (drift === "version") f.state.assets[0] = { ...f.state.assets[0]!, versionId: v2 };
      if (drift === "action") f.state.assets[0] = { ...f.state.assets[0]!, checksum: checksum(Buffer.from("edit")) };
    };
    const result = await f.push("--output", "outputs");
    assert.equal(result.code, 1, drift);
    assert.match(result.data.error, /Projected folder rule collision|folder import plan changed/, drift);
    assert.equal(f.state.importPlans.length, 2);
    assert.equal(f.state.uploads.length, 0);
    assert.equal(f.state.created.length, 0);
    assert.equal(f.state.imports.length, 0);
    assert.deepEqual(f.mutations(), []);
    assert.ok([...result.data.library, ...result.data.mappings].every((row: any) => row.applied === false));
    assert.deepEqual(await readFile(f.lockPath), lockBefore);
    for (const name of [".vardum.push.lock", ".vardum.push.pending.json", ".vardum.push.mutex"])
      await assert.rejects(readFile(join(f.project, name)), /ENOENT/);
  }
});

test("an import reports the adopted active version consistently when its storage upload fails", async (t) => {
  const f = await folderFixture(t);
  const assetId = randomUUID();
  const versionId = randomUUID();
  f.state.assetRecords.set(assetId, { id: assetId, key: "images/logo", displayName: "Existing source" });
  f.state.versions.set(versionId, {
    id: versionId, assetId, number: 1, status: "pending", filename: "logo.png",
    mimeType: "image/png", size: 4, expectedChecksum: checksum(Buffer.from("same")),
    checksum: null, retryable: false, error: null, expiresAt: f.state.expiresAt,
  });
  f.state.storageFailures = 1;
  const first = await f.push("--output", "outputs");
  assert.equal(first.code, 1);
  assert.match(first.data.error, /Storage upload failed/);
  const intent = (await f.pending()).files["images/logo"];
  assert.equal(intent.versionId, versionId);
  assert.equal(intent.assetId, assetId);
  assert.equal(intent.phase, "upload-requested");
  assert.equal(intent.mappingPhase, "planned");
  assert.deepEqual([first.data.library[0].assetId, first.data.library[0].versionId], [assetId, versionId]);
  assert.deepEqual([first.data.mappings[0].assetId, first.data.mappings[0].versionId], [assetId, versionId]);
  assert.equal(first.data.library[0].applied, false);
  assert.equal(first.data.mappings[0].applied, false);
  assert.equal(f.state.imports.length, 0);
  assert.equal(f.state.mappings.size, 0);
  assert.equal(f.state.created.length, 0);
  assert.equal(f.state.versions.size, 1);
  const retry = await f.push("--output", "outputs");
  assert.equal(retry.code, 0, retry.data.error);
  assert.equal(retry.data.library[0].versionId, versionId);
  assert.equal(retry.data.mappings[0].versionId, versionId);
  assert.equal(f.state.imports[0].files[0].versionId, versionId);
  assert.equal(f.state.versions.size, 1);
});
