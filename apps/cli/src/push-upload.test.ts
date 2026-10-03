import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VardumClient, type ManifestItem, type SyncAsset } from "./client.js";
import { checksum } from "./sync.js";

const cli = fileURLToPath(new URL("./index.ts", import.meta.url));
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
    requests: [] as Array<{ method: string; url: string }>,
    created: [] as string[],
    uploads: [] as Buffer[],
    uploadFilename: "",
    uploadMimeType: "",
    requestedSize: 0,
    assetId: "mapped",
    version: v1,
    bytes: original,
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
    const jsonBody = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    if (url === "/api/upload-limits") {
      res.statusCode = state.limitsStatus;
      res.end(JSON.stringify(state.limits));
    } else if (url.endsWith("/manifest")) {
      res.end(JSON.stringify({ schema: 1, id: "vard", workspaceId: "workspace", items: [item()] }));
    } else if (url.startsWith("/api/workspaces/workspace/sync/assets?")) {
      res.end(JSON.stringify({ workspaceSlug: "demo", assets: state.assets, nextCursor: null }));
    } else if (url === "/api/workspaces/workspace/assets" && req.method === "POST") {
      const body = await jsonBody();
      state.created.push(body.key);
      state.assetId = `new-${state.created.length}`;
      res.end(JSON.stringify({ id: state.assetId, ...body }));
    } else if (url.endsWith("/versions")) {
      const body = await jsonBody();
      state.requestedSize = body.size;
      state.uploadFilename = body.filename;
      state.uploadMimeType = body.mimeType;
      state.assetId = decodeURIComponent(url.split("/").at(-2)!);
      res.end(JSON.stringify({ id: v2, upload: { method: "POST", url: `${origin}/storage`, fields: { policy: "fixture" } } }));
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
      res.end("{}");
    } else if (url.endsWith("/finalize")) {
      state.version = v2;
      state.bytes = state.uploads.at(-1)!;
      state.assets = [{
        id: state.assetId, key: state.created.at(-1) ?? "image.png", displayName: state.uploadFilename,
        versionId: v2, checksum: checksum(state.bytes), mimeType: state.uploadMimeType, size: state.bytes.length,
      }];
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
const originalOpen = fs.open;
let opened = 0;
fs.open = async (path, flags, ...rest) => {
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
  const run = (...args: string[]) => new Promise<{ code: number; data: any }>((resolve) => {
    execFile(process.execPath, ["--import", tsx, ...(edit ? ["--import", preload] : []), cli, ...args, "--json"], {
      cwd: project,
      env: { PATH: process.env.PATH, VARDUM_CONFIG_HOME: configHome, VARDUM_API_KEY: authenticated ? "test-key" : "", VARDUM_TEST_EDIT: edit, VARDUM_TEST_PATH: editPath },
      timeout: 10000,
    }, (error, stdout, stderr) => {
      const code = error ? Number(error.code) : 0;
      resolve({ code, data: JSON.parse(code ? stderr : stdout) });
    });
  });
  return {
    project, output, state, origin, lockPath, run,
    setEdit(value: string, path = output) { edit = value; editPath = path; },
    unauthenticated() { authenticated = false; },
    mutations: () => state.requests.filter(({ method }) => method !== "GET"),
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
  assert.deepEqual(f.state.created, ["media/clip.mp4"]);
  assert.deepEqual(f.state.uploads, [bytes]);
  const lockPath = join(f.project, ".vardum.push.lock");
  const before = await readFile(lockPath, "utf8");
  assert.deepEqual(JSON.parse(before).entries["folder:media"].assets, { "media/clip.mp4": "new-1" });
  assert.equal((await f.run("push-folder", "folder", "media")).data.changed, 0);
  f.state.limits = { image: 8, video: 8, file: 4 };
  const mutations = f.mutations().length;
  for (const args of [[], ["--dry-run"]])
    assert.match((await f.run("push-folder", "folder", "media", ...args)).data.error, /limit/);
  assert.equal(f.mutations().length, mutations);
  assert.equal(await readFile(lockPath, "utf8"), before);
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
