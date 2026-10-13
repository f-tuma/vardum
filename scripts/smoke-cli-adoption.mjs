import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const oldVersion = "11111111-1111-4111-8111-111111111111";
const newVersion = "22222222-2222-4222-8222-222222222222";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

/** Exercise the real installed executable, isolated from source loaders and credentials. */
export async function smokeInstalledAdoption(installed) {
  const root = join(installed.root, "adoption");
  await mkdir(root);
  const state = { items: [], requests: [], mode: "ok", duringDownload: async () => {} };
  const makeItem = (id, transformed = false, pinned = false) => ({
    id, assetId: id, key: id, outputPath: `${id}.png`, versionId: oldVersion,
    fingerprint: `${oldVersion}:${transformed ? "w=1" : ""}`,
    downloadUrl: `/w/pilot/__v/${oldVersion}/${id}${transformed ? "?w=1&format=png" : ""}`,
    sourceChecksum: transformed ? digest("different source SVG") : digest(png),
    writable: false, pinned, transformation: transformed ? { w: 1, format: "png" } : null,
    mimeType: "image/png", size: png.length,
  });
  state.items = [makeItem("original"), makeItem("transformed", true), makeItem("pinned", false, true)];
  const server = createServer(async (req, res) => {
    state.requests.push(req.url);
    if (req.headers["x-api-key"] !== "fixture-read-key") { res.writeHead(403); res.end(); return; }
    if (req.url.endsWith("/manifest")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ schema: 1, id: "pilot", workspaceId: "workspace", items: state.items })); return; }
    if (!req.url.startsWith(`/w/pilot/__v/${oldVersion}/`) && !req.url.startsWith(`/w/pilot/__v/${newVersion}/`)) { res.writeHead(404); res.end(); return; }
    await state.duringDownload();
    if (state.mode === "redirect") { res.writeHead(302, { location: "http://foreign.invalid/output" }); res.end(); return; }
    if (state.mode === "denied") { res.writeHead(403); res.end(); return; }
    res.setHeader("content-type", "image/png"); res.end(png);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const project = join(root, "project"), home = join(root, "home");
  await mkdir(project); await mkdir(home);
  const config = { schema: 1, server: origin, workspace: "workspace", vard: "pilot" };
  await writeFile(join(project, "vardum.json"), JSON.stringify(config));
  for (const item of state.items) await writeFile(join(project, item.outputPath), png);
  const environment = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, VARDUM_API_KEY: "fixture-read-key" };
  async function run(...args) {
    try { const r = await execute(process.execPath, [installed.cli.binary, ...args, "--json"], { cwd: project, env: environment, timeout: 15000 }); return { code: 0, data: JSON.parse(r.stdout) }; }
    catch (error) { return { code: Number(error.code), data: JSON.parse(error.stderr) }; }
  }
  const lockPath = join(project, ".vardum.lock");
  const seedUpdateCache = async () => { await mkdir(join(home, "vardum"), { recursive: true }); await writeFile(join(home, "vardum/version-check.json"), JSON.stringify({ latest: "0.0.0", at: Date.now() })); };
  let passed = 0;
  try {
    await seedUpdateCache();
    assert.equal((await run("pull")).code, 1); passed++;
    // Ordinary update-cache behavior is outside the adoption no-write assertion.
    await rm(home, { recursive: true }); await mkdir(home);
    const planned = await run("status", "--adopt-existing");
    assert.equal(planned.code, 0); assert.equal(planned.data.changed, 3);
    assert.equal(planned.data.actions.every(x => x.action === "adopt" && x.decision === "adopt" && !x.applied), true);
    assert.deepEqual((await readdir(project)).sort(), ["original.png", "pinned.png", "transformed.png", "vardum.json"]);
    assert.deepEqual(await readdir(home), []); passed++;
    const applied = await run("pull", "--adopt-existing");
    assert.equal(applied.code, 0); assert.equal(applied.data.actions.every(x => x.applied), true);
    const oldLock = await readFile(lockPath); const lock = JSON.parse(oldLock);
    assert.equal(lock.schema, 2); assert.equal(Object.keys(lock.items).length, 3);
    for (const item of state.items) { assert.deepEqual(await readFile(join(project,item.outputPath)),png); assert.equal(lock.items[item.id].checksum,digest(png)); assert.equal(lock.items[item.id].versionId,oldVersion); }
    assert.deepEqual(await readdir(home), []); passed++;
    state.items = [makeItem("new")]; state.items[0].versionId = newVersion; state.items[0].downloadUrl = `/w/pilot/__v/${newVersion}/new`;
    for (const name of ["original.png", "transformed.png", "pinned.png"]) await rm(join(project,name));
    state.requests.length = 0;
    await seedUpdateCache();
    const frozen = await run("pull", "--frozen"); assert.equal(frozen.code, 0);
    assert.equal(state.requests.some(x=>x.endsWith("/manifest")),false);
    assert.deepEqual(await readFile(lockPath),oldLock);
    for (const name of ["original.png", "transformed.png", "pinned.png"]) assert.deepEqual(await readFile(join(project,name)),png);
    passed++;
    for (const flags of [["--frozen"],["--force"],["--delete"],["--server",origin]]) {
      const r = await run("pull", "--adopt-existing", ...flags); assert.equal(r.code,1); assert.deepEqual(await readFile(lockPath),oldLock); passed++;
    }
    state.items = [makeItem("missing")];
    const missing = await run("status", "--adopt-existing"); assert.equal(missing.code,0); assert.equal(missing.data.actions[0].decision,"download");
    assert.equal((await run("pull", "--adopt-existing")).code,1); assert.deepEqual(await readFile(lockPath),oldLock); passed++;
    state.items = [makeItem("different")]; const different = Buffer.from(png); different[0] ^= 1; await writeFile(join(project,"different.png"),different);
    const conflict = await run("status", "--adopt-existing"); assert.equal(conflict.code,0); assert.equal(conflict.data.actions[0].decision,"conflict");
    assert.equal((await run("pull", "--adopt-existing")).code,1); assert.deepEqual(await readFile(join(project,"different.png")),different); assert.deepEqual(await readFile(lockPath),oldLock); passed++;
    state.items = [makeItem("original")];
    for (state.mode of ["redirect", "denied"]) { assert.equal((await run("pull", "--adopt-existing")).code,1); assert.deepEqual(await readFile(lockPath),oldLock); passed++; }
    state.mode = "ok";
    assert.equal((await readdir(project)).some(x=>x.includes("mutex")||x.endsWith(".tmp")),false);
    console.log(`Installed CLI adoption passed ${passed} checks: original/transformed/pinned, dry-run, default conflict, frozen old snapshot, missing/different files and auth boundary`);
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
