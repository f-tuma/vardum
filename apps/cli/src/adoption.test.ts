import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { adoptExistingOutputs, withSnapshotMutex, type AdoptionAction } from "./adoption.js";
import { AdoptionSizeMismatchError, VardumClient, type ManifestItem, type VardConfig } from "./client.js";
import { checksum } from "./sync.js";

const version = "11111111-1111-4111-8111-111111111111";
const output = (id: string, path = `${id}.png`): ManifestItem => ({ id, assetId: id, key: id, outputPath: path, writable: false, pinned: false, transformation: null, versionId: version, fingerprint: version, downloadUrl: `/w/test/__v/${version}/${id}`, sourceChecksum: null, mimeType: "image/png", size: null });
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "vard76-adoption-"));
  const config: VardConfig = { schema: 1, server: "https://example.test", workspace: "test", vard: "test" };
  const configPath = join(directory, "vardum.json");
  await writeFile(configPath, JSON.stringify(config));
  const items = [output("one")];
  const files = new Map([["one", "matching bytes"]]);
  await writeFile(join(directory, "one.png"), files.get("one")!);
  let duringDownload: () => Promise<void> = async () => {};
  const requested: string[] = [];
  const client = {
    manifest: async () => ({ schema: 1, id: "test", workspaceId: "test", items }),
    downloadChecksum: async (url: string, maximumBytes: number) => {
      const id = new URL(url, config.server).pathname.split("/").at(-1)!;
      requested.push(id);
      await duringDownload();
      const bytes = Buffer.from(files.get(id)!);
      if (bytes.length > maximumBytes) throw new Error("oversized");
      return { checksum: checksum(bytes), bytes: bytes.length };
    },
  } as unknown as VardumClient;
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function run(dryRun = false) {
    const actions: AdoptionAction[] = [];
    const invoke = () => adoptExistingOutputs({ directory, path: configPath, config, client }, dryRun, v => v as VardConfig, entry => actions.push(entry));
    const result = dryRun ? await invoke() : await withSnapshotMutex(directory, invoke);
    return { ...result, actions };
  }
  return { directory, config, items, files, requested, run, mutate: (fn: () => Promise<void>) => { duringDownload = fn; } };
}
test("adoption verifies actual output, dry-run writes nothing, and publishes a complete schema2 lock without replacing files", async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.directory, "one.png"));
  f.items[0]!.sourceChecksum = checksum(Buffer.from("different source"));
  f.items[0]!.transformation = { w: 32, format: "png" };
  f.items[0]!.pinned = true;
  const planned = await f.run(true);
  assert.deepEqual(planned.actions.map(x => [x.action, x.decision, x.applied]), [["adopt", "adopt", false]]);
  assert.deepEqual((await readdir(f.directory)).sort(), ["one.png", "vardum.json"]);
  const applied = await f.run();
  assert.deepEqual(applied.actions.map(x => [x.action, x.applied]), [["adopt", true]]);
  assert.deepEqual(await readFile(join(f.directory, "one.png")), before);
  const lock = JSON.parse(await readFile(join(f.directory, ".vardum.lock"), "utf8"));
  assert.equal(lock.schema, 2); assert.equal(lock.items.one.checksum, checksum(before));
  assert.equal(lock.items.one.versionId, version);
  assert.equal(lock.items.one.downloadUrl, `https://example.test${f.items[0]!.downloadUrl}`);
  assert.equal((await f.run()).changed, 0);
  assert.deepEqual((await readdir(f.directory)).sort(), [".vardum.lock", "one.png", "vardum.json"]);
});
test("missing and different files remain distinct plans and adoption never partially publishes", async t => {
  const f = await fixture(t);
  f.items.push(output("two")); f.files.set("two", "missing bytes");
  f.items.push(output("three")); f.files.set("three", "other bytes");
  await writeFile(join(f.directory, "three.png"), "local bytes");
  const planned = await f.run(true);
  assert.deepEqual(planned.actions.map(x => x.decision), ["adopt", "download", "conflict"]);
  await assert.rejects(f.run(), /Supply missing or updated files/);
  assert.deepEqual((await readdir(f.directory)).sort(), ["one.png", "three.png", "vardum.json"]);
});
for (const mutation of ["edit", "replace", "delete", "config", "lock", "symlink-parent"]) {
  test(`adoption rejects detected ${mutation} drift without retaining writes`, async t => {
    const f = await fixture(t);
    if (mutation === "symlink-parent") {
      await mkdir(join(f.directory, "images"));
      await rename(join(f.directory, "one.png"), join(f.directory, "images/one.png"));
      f.items[0]!.outputPath = "images/one.png";
    }
    f.mutate(async () => {
      if (mutation === "edit") await writeFile(join(f.directory, "one.png"), "edited content");
      if (mutation === "replace") { await rm(join(f.directory, "one.png")); await writeFile(join(f.directory, "one.png"), "matching bytes"); }
      if (mutation === "delete") await rm(join(f.directory, "one.png"));
      if (mutation === "config") await writeFile(join(f.directory, "vardum.json"), JSON.stringify({ ...f.config, vard: "changed" }));
      if (mutation === "lock") await writeFile(join(f.directory, ".vardum.lock"), "concurrent lock");
      if (mutation === "symlink-parent") { await rename(join(f.directory, "images"), join(f.directory, "original-images")); await symlink(join(f.directory, "original-images"), join(f.directory, "images")); }
    });
    await assert.rejects(f.run());
    const names = await readdir(f.directory);
    assert.equal(names.some(x => x.includes(".tmp") || x.includes("mutex")), false);
    if (mutation === "lock") assert.equal(await readFile(join(f.directory, ".vardum.lock"), "utf8"), "concurrent lock");
    else assert.equal(names.includes(".vardum.lock"), false);
  });
}
test("late download rejection leaves all local bytes and previous lock unchanged", async t => {
  const f = await fixture(t); await f.run();
  const before = await readFile(join(f.directory, ".vardum.lock"));
  f.items.push(output("two")); f.files.set("two", "too long to fit");
  await writeFile(join(f.directory, "two.png"), "x");
  await assert.rejects(f.run(), /oversized/);
  assert.deepEqual(await readFile(join(f.directory, ".vardum.lock")), before);
  assert.equal(await readFile(join(f.directory, "one.png"), "utf8"), "matching bytes");
  assert.equal(await readFile(join(f.directory, "two.png"), "utf8"), "x");
  assert.equal((await readdir(f.directory)).some(x => x.includes("mutex") || x.includes(".tmp")), false);
});
test("collisions, traversal, symlinks and cross-origin output are rejected before verification", async t => {
  for (const kind of ["collision", "traversal", "symlink", "origin"]) {
    const f = await fixture(t);
    if (kind === "collision") f.items.push(output("two", "ONE.png"));
    if (kind === "traversal") f.items[0]!.outputPath = "../escape.png";
    if (kind === "symlink") { await rename(join(f.directory, "one.png"), join(f.directory, "target.png")); await symlink(join(f.directory, "target.png"), join(f.directory, "one.png")); }
    if (kind === "origin") f.items[0]!.downloadUrl = `https://foreign.test/w/test/__v/${version}/one`;
    await assert.rejects(f.run()); assert.deepEqual(f.requested, []);
    assert.equal((await readdir(f.directory)).some(x => x.includes("mutex") || x.includes(".tmp") || x === ".vardum.lock"), false);
  }
});
test("bounded authenticated checksum download rejects redirects, denial, oversized and truncated output", async t => {
  let mode = "ok"; const keys: unknown[] = [];
  const server = createServer((req,res) => {
    keys.push(req.headers["x-api-key"]);
    if (mode === "redirect") { res.writeHead(302, { location: "http://foreign.test/" }); res.end(); }
    else if (mode === "denied") { res.writeHead(403); res.end("denied"); }
    else if (mode === "truncated") { res.setHeader("content-length", "100"); res.end("short"); }
    else res.end(mode === "oversized" ? "oversized" : "safe");
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = new VardumClient(`http://127.0.0.1:${address.port}`, "fixture-read-key");
  assert.deepEqual(await client.downloadChecksum("/output",4), { checksum: checksum(Buffer.from("safe")), bytes:4 });
  for (mode of ["redirect", "denied", "oversized", "truncated"]) await assert.rejects(client.downloadChecksum("/output",4));
  assert.equal(keys.every(x => x === "fixture-read-key"), true);
  const count = keys.length; await assert.rejects(client.downloadChecksum("http://foreign.test/",4)); assert.equal(keys.length,count);
});

test("larger remote bytes are a bounded conflict plan and captured manifest identity does not change", async t => {
  const f = await fixture(t);
  f.mutate(async () => { f.items[0]!.versionId = "22222222-2222-4222-8222-222222222222"; });
  await f.run();
  const lock = JSON.parse(await readFile(join(f.directory, ".vardum.lock"), "utf8"));
  assert.equal(lock.items.one.versionId, version);
  const g = await fixture(t);
  g.mutate(async () => { throw new AdoptionSizeMismatchError("too large"); });
  const plan = await g.run(true);
  assert.equal(plan.actions[0]!.decision, "conflict"); assert.equal(plan.ready, false);
  await assert.rejects(g.run(), /resolve conflicts first/);
  assert.equal((await readdir(g.directory)).some(x => x.includes("mutex") || x.endsWith(".tmp") || x === ".vardum.lock"), false);
});

test("cooperating adopters serialize, and an unchanged snapshot is not replaced", async t => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.mutate(async () => { entered(); await gate; });
  const first = f.run();
  await ready;
  try { await assert.rejects(f.run(), /Another Vardum file operation/); }
  finally { release(); }
  assert.equal((await first).applied, true);
  const before = await readFile(join(f.directory, ".vardum.lock"));
  f.mutate(async () => {});
  const second = await f.run();
  assert.equal(second.changed, 0); assert.equal(second.snapshotChanged, false); assert.equal(second.applied, false);
  assert.deepEqual(await readFile(join(f.directory, ".vardum.lock")), before);
  assert.equal((await readdir(f.directory)).some(x => x.includes("mutex") || x.endsWith(".tmp")), false);
});
