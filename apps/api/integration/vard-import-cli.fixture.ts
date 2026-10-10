import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import sharp from "sharp";

const execFile = promisify(execFileCallback);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// A real CLI consumer of the real auth/routes/worker, isolated from operator services.
// The multipart object fixture is deliberately separate from hosted real RustFS acceptance.
export async function checkVardImportCli(
  t: TestContext,
  fixture: {
    admin: Pool;
    app: FastifyInstance;
    objects: Map<string, Buffer>;
    keyHeaders: Record<string, Record<string, string>>;
    root: string;
    cliPath?: string;
  },
) {
  const { admin, app, objects, keyHeaders, root } = fixture;
  const { processAsset } = await import("../src/asset-processor.js");
  const prefix = `cli-import-${randomUUID()}/`;
  const vardId = randomUUID();
  const iconId = randomUUID();
  const iconVersion = randomUUID();
  const mappingId = randomUUID();
  const objectKey = `${prefix}original-icon`;
  const filenames = [
    "icon.png", "icon-light.png", "splash-icon.png", "splash-icon-light.png",
    "favicon.png", "android-icon-foreground.png", "android-icon-background.png",
    "android-icon-monochrome.png",
  ];
  const originals = new Map<string, Buffer>();
  for (const [index, filename] of filenames.entries()) {
    originals.set(filename, await sharp({
      create: {
        width: filename === "favicon.png" ? 48 : 64,
        height: filename === "favicon.png" ? 48 : 64,
        channels: 4, background: { r: 20 + index * 20, g: 40, b: 90, alpha: 1 },
      },
    }).png().toBuffer());
  }
  const icon = originals.get("icon.png")!;
  objects.set(objectKey, icon);
  await admin.query(
    "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,'ws',$2,'Icon','fixture','fixture')",
    [iconId, `${prefix}icon`],
  );
  await admin.query(
    "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,width,height,created_by,updated_by) VALUES($1,'ws',$2,1,'ready',$3,'icon.png','image/png',$4,$5,64,64,'fixture','fixture')",
    [iconVersion, iconId, objectKey, icon.length, hash(icon)],
  );
  await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [iconVersion, iconId]);
  await admin.query(
    "INSERT INTO vard(id,workspace_id,name,created_by,updated_by) VALUES($1,'ws',$2,'fixture','fixture')",
    [vardId, `CLI import ${vardId}`],
  );
  await admin.query(
    "INSERT INTO vard_item(id,workspace_id,vard_id,asset_id,output_path,created_by,updated_by) VALUES($1,'ws',$2,$3,'images/icon.png','fixture','fixture')",
    [mappingId, vardId, iconId],
  );
  const originalMapping = (await admin.query("SELECT * FROM vard_item WHERE id=$1", [mappingId])).rows[0];
  let loseApplyResponse = false;
  let applyResponsesLost = 0;
  const requests: Array<{ method: string; path: string }> = [];
  const bridge = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const path = req.url!;
      requests.push({ method: req.method!, path });
      const response = await app.inject({
        method: req.method as "GET" | "POST" | "PUT" | "DELETE",
        url: path,
        headers: req.headers,
        ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}),
      });
      if (response.statusCode < 300 && /\/versions\/[^/]+\/finalize$/.test(path)) {
        const parts = path.split("/");
        const versionId = parts.at(-2)!;
        const assetId = parts.at(-4)!;
        const version = (await admin.query("SELECT ingest_job_id FROM asset_version WHERE id=$1", [versionId])).rows[0];
        await processAsset({ workspaceId: "ws", assetId, versionId, requestId: "cli-fixture" },
          { jobId: version.ingest_job_id });
      }
      if (loseApplyResponse && path.endsWith("/items/import") && response.statusCode === 200) {
        loseApplyResponse = false;
        applyResponsesLost++;
        req.socket.destroy();
        return;
      }
      res.statusCode = response.statusCode;
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && name !== "transfer-encoding") res.setHeader(name, value);
      }
      res.end(response.rawPayload);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await admin.query("DELETE FROM vard WHERE id=$1", [vardId]);
    const rows = (await admin.query(
      "SELECT av.storage_key,av.ingest_job_id FROM asset_version av JOIN asset a ON a.id=av.asset_id WHERE starts_with(a.key,$1)", [prefix],
    )).rows;
    // The bridge invokes processing directly, so it must also retire its own
    // durable jobs before deleting the corresponding fixture assets.
    const { boss, assetIngestQueue } = await import("../src/queue.js");
    for (const row of rows) {
      if (!row.ingest_job_id) continue;
      await boss.cancel(assetIngestQueue, row.ingest_job_id);
      const job = await boss.getJobById(assetIngestQueue, row.ingest_job_id);
      assert.ok(!job || !["created", "retry", "active"].includes(job.state));
    }
    await admin.query("DELETE FROM asset WHERE starts_with(key,$1)", [prefix]);
    for (const row of rows) objects.delete(row.storage_key);
  });
  const address = bridge.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const project = join(root, "vard-import-cli");
  const source = join(project, "source");
  const home = join(root, "vard-import-cli-home");
  await mkdir(source, { recursive: true });
  await mkdir(join(home, "vardum"), { recursive: true });
  await writeFile(join(home, "vardum/version-check.json"), JSON.stringify({ latest: "0.0.0", at: Date.now() }));
  const config = JSON.stringify({ schema: 1, server: origin, workspace: "ws", vard: vardId });
  await writeFile(join(project, "vardum.json"), config);
  for (const [filename, bytes] of originals) await writeFile(join(source, filename), bytes);
  const cli = fixture.cliPath ?? fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
  const run = (cwd: string, args: string[]) => execFile(process.execPath,
    ["--import", import.meta.resolve("tsx"), cli, ...args, "--json"], {
      cwd, timeout: 25_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, VARDUM_API_KEY: keyHeaders.write!["x-api-key"]! },
    });
  const push = (extra: string[] = []) => run(project, ["push-folder", "source", prefix, "--output", "images/", ...extra]);
  const versionState = async () => (await admin.query(
    "SELECT av.id,av.asset_id,av.number,av.checksum,av.status FROM asset_version av JOIN asset a ON a.id=av.asset_id WHERE starts_with(a.key,$1) ORDER BY av.id", [prefix],
  )).rows;
  const mappings = async () => (await admin.query("SELECT * FROM vard_item WHERE vard_id=$1 ORDER BY output_path", [vardId])).rows;

  await t.test("preflight dry-run and lost additive response resume preserve source, old lock and identities", async () => {
    assert.equal(JSON.parse((await run(project, ["pull"])).stdout).changed, 1);
    const oneIconLock = await readFile(join(project, ".vardum.lock"), "utf8");
    const beforeVersions = await versionState();
    const beforeMappings = await mappings();
    const beforeFiles = await readdir(project);
    const start = requests.length;
    const dry = await push(["--dry-run"]);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);
    assert.equal(requests.slice(start).some((request) =>
      request.method !== "GET" && !request.path.endsWith("/items/import-plan")), false);
    assert.deepEqual(await readdir(project), beforeFiles);
    assert.deepEqual(await versionState(), beforeVersions);
    assert.deepEqual(await mappings(), beforeMappings);
    loseApplyResponse = true;
    await assert.rejects(push(), (error: any) => {
      const result = JSON.parse(error.stderr);
      assert.match(result.error, /fetch failed/, error.stderr);
      return true;
    });
    assert.equal(applyResponsesLost, 1, "fault occurs after the real additive transaction commits");
    assert.equal((await mappings()).length, 8);
    assert.equal((await versionState()).length, 8);
    const committedVersions = await versionState();
    const committedMappings = await mappings();
    const journal = JSON.parse(await readFile(join(project, ".vardum.push.pending.json"), "utf8"));
    assert.ok(journal);
    await push();
    assert.deepEqual(await versionState(), committedVersions, "resume never uploads a duplicate version");
    assert.deepEqual(await mappings(), committedMappings, "resume keeps all committed mapping rows");
    assert.deepEqual((await mappings()).find((item) => item.id === mappingId), originalMapping);
    assert.equal(await readFile(join(project, ".vardum.lock"), "utf8"), oneIconLock);
    assert.deepEqual(await readdir(join(project, "images")), ["icon.png"], "import does not pull over project outputs");
    for (const [filename, bytes] of originals) assert.deepEqual(await readFile(join(source, filename)), bytes);
    assert.equal(JSON.parse((await push()).stdout).changed, 0);
    assert.deepEqual(await versionState(), committedVersions);
    assert.deepEqual(await mappings(), committedMappings);
    assert.equal((await readdir(project)).some((filename) => /\.vardum\.push\.(pending|mutex)/.test(filename)), false);

    const oldProject = join(root, "vard-import-old-snapshot");
    await mkdir(oldProject);
    await writeFile(join(oldProject, "vardum.json"), config);
    await writeFile(join(oldProject, ".vardum.lock"), oneIconLock);
    assert.equal(JSON.parse((await run(oldProject, ["pull", "--frozen"])).stdout).changed, 1);
    assert.deepEqual(await readFile(join(oldProject, "images/icon.png")), icon);
    assert.deepEqual(await readdir(join(oldProject, "images")), ["icon.png"]);
    assert.equal(await readFile(join(oldProject, ".vardum.lock"), "utf8"), oneIconLock);
  });

  await t.test("eight-file normal/frozen consumption and a real updated version retain mapping IDs", async () => {
    assert.equal(JSON.parse((await run(project, ["pull"])).stdout).changed, 7);
    for (const [filename, bytes] of originals) assert.deepEqual(await readFile(join(project, "images", filename)), bytes);
    const eightLock = await readFile(join(project, ".vardum.lock"), "utf8");
    assert.equal(Object.keys(JSON.parse(eightLock).items).length, 8);
    const oldMappings = await mappings();
    const changedFavicon = await sharp({ create: { width: 48, height: 48, channels: 4, background: "blue" } }).png().toBuffer();
    await writeFile(join(source, "favicon.png"), changedFavicon);
    await push();
    assert.equal((await versionState()).length, 9);
    assert.deepEqual(await mappings(), oldMappings);
    assert.equal(JSON.parse((await run(project, ["pull"])).stdout).changed, 1);
    assert.deepEqual(await readFile(join(project, "images/favicon.png")), changedFavicon);
    assert.equal(JSON.parse((await push()).stdout).changed, 0);
    const cold = join(root, "vard-import-eight-snapshot");
    await mkdir(cold);
    await writeFile(join(cold, "vardum.json"), config);
    await writeFile(join(cold, ".vardum.lock"), eightLock);
    assert.equal(JSON.parse((await run(cold, ["pull", "--frozen"])).stdout).changed, 8);
    for (const [filename, bytes] of originals) assert.deepEqual(await readFile(join(cold, "images", filename)), bytes);
    assert.equal(await readFile(join(cold, ".vardum.lock"), "utf8"), eightLock);
    assert.equal((await admin.query("SELECT bool_or(is_public) AS public FROM asset WHERE starts_with(key,$1)", [prefix])).rows[0].public, false);
  });
}
