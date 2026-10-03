import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Runs only inside private-delivery's disposable PG cluster and fake HTTP object store.
export async function checkFrozenIdentity(t: TestContext, fixture: {
  root: string; app: FastifyInstance; admin: Pool; objects: Map<string, Buffer>;
  keyHeaders: Record<string, Record<string, string>>; bytes: Buffer;
  run: (project: { path: string; key: string }, ...args: string[]) => Promise<{ stdout: string }>;
  storageReads: () => number;
  releasedClients?: string;
}) {
  const { root, app, admin, objects, keyHeaders, bytes, run, storageReads } = fixture;
  const { identityVersionUrl, transformedVersionUrl } = await import("../src/transformation.js");
  const { config } = await import("../src/config.js");
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const sql = (query: string, params: unknown[] = []) => admin.query(query, params);
  const create = async (key: string, content = bytes, space = "ws", status = "ready") => {
    const id = randomUUID(), version = randomUUID();
    objects.set(version, content);
    await sql("INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) VALUES ($1,$2,$3,'Identity fixture',false,'fixture','fixture')", [id, space, key]);
    await sql("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1::uuid,$2,$3,1,$4,$1::text,'source.svg','image/svg+xml',$5,$6,'fixture','fixture')", [version, space, id, status, content.length, hash(content)]);
    await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [version, id]);
    return { id, version, key };
  };
  const first = await create("identity/source.svg");
  const moved = await create("identity/nested/move.svg");
  const transformed = await create("identity/variant.svg");
  const foreign = await create("identity/foreign.svg", bytes, "other-ws");
  const pending = await create("identity/pending.svg", bytes, "ws", "pending");
  const deleted = await create("identity/deleted.svg");
  const vard = randomUUID();
  await sql("INSERT INTO vard(id,workspace_id,name,is_public,created_by,updated_by) VALUES ($1,'ws','Frozen identity fixture',true,'fixture','fixture')", [vard]);
  for (const [asset, path, transformation] of [
    [first.id, "assets/a.svg", null], [moved.id, "assets/b.svg", null],
    [transformed.id, "assets/small.png", JSON.stringify({ w: 8, format: "png" })],
  ]) await sql("INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,transformation,created_by,updated_by) VALUES ('ws',$1,$2,$3,$4,'fixture','fixture')", [vard, asset, path, transformation]);
  const manifestPath = `/api/workspaces/ws/vards/${vard}/manifest`;
  const legacy = (await app.inject({ url: manifestPath, headers: keyHeaders.read })).json();
  assert.equal(legacy.delivery, undefined);
  const opted = await app.inject({ url: `${manifestPath}?delivery=version-id-v1`, headers: keyHeaders.read });
  assert.equal(opted.statusCode, 200, opted.body);
  assert.equal(opted.json().delivery, "version-id-v1");
  assert.equal((await app.inject({ url: `${manifestPath}?delivery=unknown`, headers: keyHeaders.read })).statusCode, 400);
  assert.equal((await app.inject({ url: `/v/${vard}?delivery=version-id-v1` })).statusCode, 404);
  const schema2 = { schema: 2, server: origin, workspace: "ws", vard, items: Object.create(null) };
  const expected = new Map<string, Buffer>();
  for (const item of legacy.items) {
    const response = await app.inject({ url: item.downloadUrl, headers: keyHeaders.read });
    assert.equal(response.statusCode, 200, response.body);
    expected.set(item.outputPath, response.rawPayload);
    schema2.items[item.id] = { path: item.outputPath, versionId: item.versionId, fingerprint: item.fingerprint,
      downloadUrl: `${origin}${item.downloadUrl}`, checksum: hash(response.rawPayload) };
  }
  const project = async (name: string, lock?: unknown, key = keyHeaders.read!["x-api-key"]!) => {
    const result = { path: join(root, `identity-${name}`), key };
    await mkdir(result.path);
    await writeFile(join(result.path, "vardum.json"), JSON.stringify({ schema: 1, server: origin, workspace: "ws", vard }));
    if (lock) await writeFile(join(result.path, ".vardum.lock"), JSON.stringify(lock, null, 2));
    return result;
  };
  const frozen = await project("schema3");
  await run(frozen, "pull");
  const lockPath = (p: { path: string }) => join(p.path, ".vardum.lock");
  const frozenText = await readFile(lockPath(frozen), "utf8");
  const snapshot = JSON.parse(frozenText);
  assert.equal(snapshot.schema, 3);
  assert.equal(snapshot.delivery, "version-id-v1");
  // Optional explicit published-archive fixtures prove the server's legacy defaults.
  // Normal source tests do not claim this independently installed binary proof.
  if (fixture.releasedClients) {
    const execFile = promisify(execFileCallback);
    const base = fixture.releasedClients;
    const cliEntry = join(base, "node_modules/@vardum/cli/dist/index.js");
    const mcpEntry = join(base, "node_modules/@vardum/mcp/dist/index.js");
    assert.equal((await execFile(process.execPath, [cliEntry, "--version"])).stdout.trim(), "0.6.0");
    assert.equal((await execFile(process.execPath, [mcpEntry, "--version"])).stdout.trim(), "0.2.0");
    const published = await project("published-cli");
    const home = join(root, "published-home");
    await mkdir(join(home, "vardum"), { recursive: true });
    await writeFile(join(home, "vardum/version-check.json"), JSON.stringify({ latest: "0.6.0", at: Date.now() }));
    const publishedRun = (...args: string[]) => execFile(process.execPath, [cliEntry, ...args, "--json"], {
      cwd: published.path, timeout: 20000,
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, VARDUM_API_KEY: published.key },
    });
    await publishedRun("pull");
    const publishedText = await readFile(lockPath(published), "utf8");
    assert.equal(JSON.parse(publishedText).schema, 2);
    await rm(join(published.path, "assets"), { recursive: true });
    await publishedRun("pull", "--frozen");
    for (const [path, content] of expected) assert.deepEqual(await readFile(join(published.path, path)), content);
    assert.equal(await readFile(lockPath(published), "utf8"), publishedText);
    const require = createRequire(join(base, "package.json"));
    const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
    const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
    const client = new Client({ name: "published-compatibility", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry],
        env: { PATH: process.env.PATH, VARDUM_SERVER: origin, VARDUM_API_KEY: published.key }, stderr: "pipe" }));
      assert.equal((await client.listTools()).tools.length, 11);
      const result = await client.callTool({ name: "get_vard", arguments: { workspaceId: "ws", vardId: vard, resolved: true } });
      assert.equal(result.isError, undefined);
      const returned = JSON.parse(result.content[0].text);
      assert.equal(returned.delivery, undefined);
      assert.deepEqual(returned.items, legacy.items);
    } finally { await client.close(); }
    console.log("Actual retained published archives: CLI 0.6.0 created/restored unchanged schema 2 originals/variants; MCP 0.2.0 advertised 11 tools and retrieved the unchanged legacy resolved manifest.");
  }
  const migrating = await project("migrate", schema2);
  const missing = await project("missing", schema2);
  const corrupt = await project("corrupt", schema2);
  const denied = await project("denied", schema2, keyHeaders.revoked!["x-api-key"]!);
  await mkdir(join(migrating.path, "assets"));
  await writeFile(join(migrating.path, "assets/a.svg"), "local edits remain untouched by migration");
  const resolver = "/api/workspaces/ws/snapshot-delivery/resolve";
  const payload = { items: [{ id: "one", versionId: first.version, transformation: null }] };
  for (const headers of [{}, keyHeaders.other!, keyHeaders.revoked!, keyHeaders.insufficient!]) {
    const before = storageReads();
    assert.equal((await app.inject({ method: "POST", url: resolver, headers, payload })).statusCode, 401);
    assert.equal(storageReads(), before);
  }
  for (const [body, status] of [
    [{ items: [...payload.items, ...payload.items] }, 400],
    [{ items: Array.from({ length: 1001 }, (_, i) => ({ ...payload.items[0], id: String(i) })) }, 400],
    [{ items: [{ ...payload.items[0], versionId: foreign.version }] }, 404],
    [{ items: [{ ...payload.items[0], versionId: pending.version }] }, 404],
    [{ items: [{ ...payload.items[0], transformation: { w: 4097 } }] }, 400],
  ] as const) {
    const before = storageReads();
    const response = await app.inject({ method: "POST", url: resolver, headers: keyHeaders.read, payload: body });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(storageReads(), before);
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
  const signed = identityVersionUrl("ws", transformed.version, { w: 8, format: "png" });
  const oldSigned = transformedVersionUrl("demo", transformed.key, transformed.version, { w: 8, format: "png" });
  for (const url of [
    signed.replace(transformed.version, first.version), signed.replace("/__id/ws/", "/__id/other-ws/"),
    signed.replace("w=8", "w=9"),
    identityVersionUrl("ws", transformed.version) + new URL(oldSigned, origin).search,
    oldSigned.split("?")[0] + new URL(signed, origin).search,
  ]) {
    const before = storageReads();
    const response = await app.inject({ url, headers: keyHeaders.read });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(storageReads(), before);
  }
  await sql("DELETE FROM asset_version WHERE id=$1", [deleted.version]);
  for (const url of [identityVersionUrl("other-ws", first.version), identityVersionUrl("ws", foreign.version),
    identityVersionUrl("ws", pending.version), identityVersionUrl("ws", deleted.version)]) {
    const before = storageReads();
    assert.equal((await app.inject({ url, headers: keyHeaders.read })).statusCode, 404);
    assert.equal(storageReads(), before);
  }
  const beforeSecret = config.TRANSFORM_SECRET;
  try {
    await sql("UPDATE asset SET key='renamed/source.svg' WHERE id=$1", [first.id]);
    await sql("UPDATE asset SET key='outside-identity/move.svg' WHERE id=$1", [moved.id]);
    await sql("UPDATE asset SET key='renamed/variant.svg' WHERE id=$1", [transformed.id]);
    const replacement = Buffer.from(bytes.toString().replace("red", "blue"));
    const newer = randomUUID();
    objects.set(newer, replacement);
    await sql("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1::uuid,'ws',$2,2,'ready',$1::text,'new.svg','image/svg+xml',$3,$4,'fixture','fixture')", [newer, first.id, replacement.length, hash(replacement)]);
    await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [newer, first.id]);
    for (const source of [first, moved, transformed]) await create(source.key, replacement);
    await sql("UPDATE workspace SET slug='identity-renamed' WHERE id='ws'");
    await sql("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ('identity-slug-reuser','other','Old slug owner','demo','fixture','fixture')");
    await sql("DELETE FROM vard WHERE id=$1", [vard]);
    await rm(join(frozen.path, "assets"), { recursive: true });
    assert.equal(JSON.parse((await run(frozen, "pull", "--frozen")).stdout).changed, 3);
    for (const [path, content] of expected) assert.deepEqual(await readFile(join(frozen.path, path)), content);
    assert.equal(await readFile(lockPath(frozen), "utf8"), frozenText);
    const currentNames = (await sql("SELECT key FROM asset WHERE id=ANY($1::uuid[]) ORDER BY key", [[first.id, moved.id, transformed.id]])).rows.map(row => row.key);
    assert.deepEqual(currentNames, ["outside-identity/move.svg", "renamed/source.svg", "renamed/variant.svg"]);
    assert.equal((await sql("SELECT slug FROM workspace WHERE id='ws'")).rows[0].slug, "identity-renamed");
    assert.equal((await app.inject({ url: manifestPath, headers: keyHeaders.read })).statusCode, 404);
    assert.equal((await app.inject({ url: legacy.items[0].downloadUrl, headers: keyHeaders.read })).statusCode, 404);
    await rm(join(frozen.path, "assets"), { recursive: true });
    const readsBeforeDenial = storageReads();
    await assert.rejects(run({ ...frozen, key: keyHeaders.revoked!["x-api-key"]! }, "pull", "--frozen"), /401/);
    assert.equal(storageReads(), readsBeforeDenial);
    assert.equal(await readFile(lockPath(frozen), "utf8"), frozenText);
    for (const p of [missing, corrupt, denied]) {
      await mkdir(join(p.path, "assets"));
      await writeFile(join(p.path, "assets/a.svg"), "keep local edits");
    }
    const migrationFailure = async (p: typeof missing, pattern: RegExp) => {
      const before = await readFile(lockPath(p), "utf8");
      await assert.rejects(run(p, "migrate-lock"), pattern);
      assert.equal(await readFile(lockPath(p), "utf8"), before);
      assert.equal(await readFile(join(p.path, "assets/a.svg"), "utf8"), "keep local edits");
      await assert.rejects(readFile(join(p.path, "assets/b.svg")), /ENOENT/);
    };
    objects.delete(moved.version);
    const readsBeforeMissing = storageReads();
    await migrationFailure(missing, /502/);
    assert.ok(storageReads() >= readsBeforeMissing + 2, "first output was verified before the later missing source failed");
    objects.set(moved.version, replacement);
    await migrationFailure(corrupt, /checksum mismatch/);
    objects.set(moved.version, bytes);
    await migrationFailure(denied, /401/);
    config.TRANSFORM_SECRET = "rotated-identity-fixture-secret-at-least-32-characters";
    const rotationReads = storageReads();
    assert.equal((await app.inject({ url: signed, headers: keyHeaders.read })).statusCode, 403);
    assert.equal(storageReads(), rotationReads);
    assert.equal((await app.inject({ url: identityVersionUrl("ws", first.version), headers: keyHeaders.read })).statusCode, 200);
    const migrationText = await readFile(lockPath(migrating), "utf8");
    await run(migrating, "migrate-lock", "--dry-run");
    assert.equal(await readFile(lockPath(migrating), "utf8"), migrationText);
    await run(migrating, "migrate-lock");
    const migratedText = await readFile(lockPath(migrating), "utf8");
    const migrated = JSON.parse(migratedText);
    assert.equal(migrated.schema, 3);
    assert.equal(await readFile(join(migrating.path, "assets/a.svg"), "utf8"), "local edits remain untouched by migration");
    for (const [id, old] of Object.entries(schema2.items)) {
      const { downloadUrl: oldUrl, ...oldIdentity } = old as Record<string, unknown>;
      const { downloadUrl: nextUrl, ...newIdentity } = migrated.items[id];
      assert.deepEqual(newIdentity, oldIdentity);
      assert.match(nextUrl, /\/w\/__id\/ws\/__v\//);
      assert.notEqual(nextUrl, oldUrl);
    }
    await rm(join(migrating.path, "assets"), { recursive: true });
    await run(migrating, "pull", "--frozen");
    for (const [path, content] of expected) assert.deepEqual(await readFile(join(migrating.path, path)), content);
    assert.equal(await readFile(lockPath(migrating), "utf8"), migratedText);
    // Current privacy still gates every retained identity; signatures grant no read permission.
    await sql("UPDATE asset SET is_public=true WHERE id=$1", [transformed.id]);
    const newSigned = identityVersionUrl("ws", transformed.version, { w: 8, format: "png" });
    const publiclyDelivered = await app.inject({ url: newSigned });
    assert.equal(publiclyDelivered.statusCode, 200);
    assert.equal(publiclyDelivered.headers["cache-control"], "public, max-age=31536000, immutable");
    await sql("UPDATE asset SET is_public=false WHERE id=$1", [transformed.id]);
    const visibilityReads = storageReads();
    const privateAgain = await app.inject({ url: newSigned });
    assert.equal(privateAgain.statusCode, 401);
    assert.equal(privateAgain.headers["cache-control"], "private, no-store");
    assert.equal(storageReads(), visibilityReads);
    assert.equal(await readFile(lockPath(migrating), "utf8"), migratedText);
    console.log("Identity proof: real source rename/move, old key and slug reuse, newer current version, deleted Vard and absent local files retained exact originals/variants. Explicit schema 2 migration survived obsolete names/signatures; later storage/checksum/auth failures left locks and files unchanged.");
  } finally {
    config.TRANSFORM_SECRET = beforeSecret;
    // Restore the shared fixture's slug only after every rename assertion; source names stay moved.
    await sql("DELETE FROM workspace WHERE id='identity-slug-reuser'");
    await sql("UPDATE workspace SET slug='demo' WHERE id='ws'");
  }
}
