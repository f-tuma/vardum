import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

const api = "/api/workspaces/ws";
type Fixture = { app: FastifyInstance; admin: Pool; objects: Map<string, Buffer>; cookies: Record<string, string> };

async function seed(t: TestContext, { admin, objects }: Pick<Fixture, "admin" | "objects">) {
  const assetId = randomUUID(), versionId = randomUUID(), vardId = randomUUID();
  const key = `archive-${assetId}/nested/logo.svg`;
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="red"/></svg>');
  const checksum = createHash("sha256").update(bytes).digest("hex");
  objects.set(versionId, bytes);
  await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws',$2,'Archive proof','fixture','fixture')", [assetId, key]);
  await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1::uuid,'ws',$2,1,'ready',$1::text,'logo.svg','image/svg+xml',$3,$4,'fixture','fixture')", [versionId, assetId, bytes.length, checksum]);
  await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, assetId]);
  await admin.query("INSERT INTO vard(id,workspace_id,name,folder_rules,created_by,updated_by) VALUES ($1,'ws','Archive folder proof',$2,'fixture','fixture')", [vardId, JSON.stringify([{ sourcePrefix: key.split('/')[0] + '/', outputPrefix: "assets/" }])]);
  t.after(async () => {
    await admin.query("DELETE FROM vard WHERE id=$1", [vardId]);
    await admin.query("DELETE FROM asset WHERE id=$1", [assetId]);
    objects.delete(versionId);
  });
  return { assetId, versionId, vardId, key, bytes, checksum };
}

export async function checkAssetArchive(t: TestContext, fixture: Fixture, keyHeaders: Record<string, Record<string, string>>) {
  const { app, admin, cookies } = fixture;
  const source = await seed(t, fixture);
  const { assetId, versionId, vardId, key, bytes } = source;
  const headers = { cookie: cookies.owner! };
  const endpoint = `${api}/assets/${assetId}/archive`;
  const state = { archived: true, expectedCurrentVersionId: versionId, expectedArchivedAt: null };
  const manifest = () => app.inject({ url: `${api}/vards/${vardId}/manifest`, headers });
  const originalManifest = (await manifest()).json();
  const immutable = `/w/demo/__v/${versionId}/${key}`;
  const versionsBefore = (await admin.query("SELECT * FROM asset_version WHERE asset_id=$1", [assetId])).rows;
  const sourceBefore = (await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows[0];

  await t.test("archive requires read/update authority, tenant identity and current-state CAS", async () => {
    for (const [auth, status] of [[{}, 401], [{ cookie: cookies.viewer! }, 403], [{ cookie: cookies.outsider! }, 403], [keyHeaders.read!, 401], [keyHeaders.insufficient!, 401]] as const) {
      const response = await app.inject({ method: "PATCH", url: endpoint, headers: auth, payload: state });
      assert.equal(response.statusCode, status, response.body);
    }
    const foreign = await app.inject({ method: "PATCH", url: `/api/workspaces/other-ws/assets/${assetId}/archive`, headers: { cookie: cookies.outsider! }, payload: state });
    assert.equal(foreign.statusCode, 404, foreign.body);
    for (const payload of [{ ...state, expectedCurrentVersionId: randomUUID() }, { ...state, expectedArchivedAt: "2026-01-01T00:00:00.000Z" }]) {
      assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload })).statusCode, 409);
    }
    assert.deepEqual((await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows[0], sourceBefore);
  });

  await t.test("unfinished work prevents archival before a worker can promote bytes", async () => {
    for (const status of ["pending", "processing", "failed"]) {
      const unfinished = randomUUID();
      await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,retryable,storage_key,filename,mime_type,size,created_by,updated_by) VALUES ($1::uuid,'ws',$2,2,$3,$4,$1::text,'logo.svg','image/svg+xml',1,'fixture','fixture')", [unfinished, assetId, status, status === "failed"]);
      const response = await app.inject({ method: "PATCH", url: endpoint, headers, payload: state });
      assert.equal(response.statusCode, 409, response.body);
      await admin.query("DELETE FROM asset_version WHERE id=$1", [unfinished]);
    }
  });

  let archivedAt: string;
  await t.test("archive preserves versions, stable/immutable delivery, sync and folder membership", async () => {
    const response = await app.inject({ method: "PATCH", url: endpoint, headers, payload: state });
    assert.equal(response.statusCode, 200, response.body);
    archivedAt = response.json().archivedAt;
    assert.ok(archivedAt);
    const current = (await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows[0];
    for (const field of ["id", "key", "current_version_id", "is_public", "display_name", "created_at", "created_by"])
      assert.deepEqual(current[field], sourceBefore[field], field);
    assert.deepEqual((await admin.query("SELECT * FROM asset_version WHERE asset_id=$1", [assetId])).rows, versionsBefore);
    const stable = await app.inject({ url: `/w/demo/${key}`, headers });
    assert.equal(stable.statusCode, 302, stable.body);
    assert.equal(stable.headers.location, immutable);
    assert.deepEqual((await app.inject({ url: immutable, headers })).rawPayload, bytes);
    assert.equal((await app.inject({ url: immutable })).statusCode, 401);
    assert.deepEqual((await manifest()).json(), originalManifest);
    const sync = await app.inject({ url: `${api}/sync/assets?prefix=${key.split('/')[0]}/`, headers });
    assert.deepEqual(sync.json().assets.map((row: { id: string }) => row.id), [assetId]);
  });

  await t.test("archive discovery is explicit and archived sources reject writes without audit/version changes", async () => {
    const before = await admin.query("SELECT * FROM asset WHERE id=$1", [assetId]);
    const auditBefore = await admin.query("SELECT * FROM audit_event WHERE target_id=$1 ORDER BY id", [assetId]);
    for (const query of [`search=${assetId}`, `pagination=cursor&search=${assetId}`]) {
      const normal = await app.inject({ url: `${api}/assets?${query}`, headers });
      assert.deepEqual(normal.json().assets, []);
      const archive = await app.inject({ url: `${api}/assets?${query}&archived=true`, headers });
      assert.deepEqual(archive.json().assets.map((row: { id: string }) => row.id), [assetId]);
      assert.equal(archive.json().assets[0].archivedAt, archivedAt);
      assert.deepEqual(archive.json().folders, []);
    }
    const detail = await app.inject({ url: `${api}/assets/${assetId}`, headers });
    assert.equal(detail.json().archivedAt, archivedAt);
    const repeat = await app.inject({ method: "PATCH", url: endpoint, headers, payload: { ...state, expectedArchivedAt: archivedAt } });
    assert.equal(repeat.statusCode, 200, repeat.body);
    assert.equal(repeat.json().archivedAt, archivedAt, "a current-state no-op preserves its archive timestamp");
    for (const request of [
      { method: "PATCH", url: `${api}/assets/${assetId}`, payload: { displayName: "Changed" } },
      { method: "PATCH", url: `${api}/assets/${assetId}/visibility`, payload: { isPublic: true } },
      { method: "DELETE", url: `${api}/assets/${assetId}` },
      { method: "POST", url: `${api}/assets/${assetId}/versions`, payload: { filename: "logo.svg", mimeType: "image/svg+xml", size: 1 } },
      { method: "POST", url: `${api}/assets/${assetId}/versions/${versionId}/restore` },
      { method: "POST", url: `${api}/assets/${assetId}/versions/${versionId}/finalize` },
      { method: "POST", url: `${api}/assets/${assetId}/versions/${versionId}/retry` },
      { method: "POST", url: `${api}/assets`, payload: { id: assetId, key, displayName: "Replay" } },
      { method: "POST", url: `${api}/assets`, payload: { key, displayName: "Overwrite" } },
      { method: "POST", url: `${api}/vards/${vardId}/items/import-plan`, payload: { files: [{ assetId, key, outputPath: "assets/nested/logo.svg", checksum: "a".repeat(64), mimeType: "image/svg+xml", size: bytes.length }] } },
      { method: "DELETE", url: `${api}/folders?prefix=${key.split('/')[0]}/` },
    ] as const) {
      const response = await app.inject({ ...request, headers });
      assert.equal(response.statusCode, 409, `${request.method} ${request.url}: ${response.body}`);
    }
    assert.deepEqual((await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows, before.rows);
    assert.deepEqual((await admin.query("SELECT * FROM asset_version WHERE asset_id=$1", [assetId])).rows, versionsBefore);
    assert.deepEqual((await admin.query("SELECT * FROM audit_event WHERE target_id=$1 ORDER BY id", [assetId])).rows, auditBefore.rows);
  });

  await t.test("unarchive checks CAS and restores normal discovery and mutation", async () => {
    const stale = await app.inject({ method: "PATCH", url: endpoint, headers, payload: { ...state, archived: false } });
    assert.equal(stale.statusCode, 409);
    const response = await app.inject({ method: "PATCH", url: endpoint, headers: { cookie: cookies.editor! }, payload: { ...state, archived: false, expectedArchivedAt: archivedAt } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().archivedAt, null);
    assert.deepEqual((await app.inject({ url: `${api}/assets?pagination=cursor&search=${assetId}`, headers })).json().assets.map((row: { id: string }) => row.id), [assetId]);
    assert.equal((await app.inject({ method: "PATCH", url: `${api}/assets/${assetId}`, headers, payload: { displayName: "Restored" } })).statusCode, 200);
    const audit = (await admin.query("SELECT action FROM audit_event WHERE target_id=$1 AND action IN ('asset.archived','asset.unarchived') ORDER BY created_at", [assetId])).rows;
    assert.deepEqual(audit.map((row) => row.action), ["asset.archived", "asset.unarchived"]);
  });
}

export async function checkArchivedFrozen(t: TestContext, fixture: Fixture & {
  origin: string; root: string; key: string;
  run: (project: { path: string; key: string }, ...args: string[]) => Promise<{ stdout: string; stderr: string }>;
}) {
  const { app, cookies, origin, root, key, run } = fixture;
  const source = await seed(t, fixture);
  const project = { path: join(root, "archived-frozen"), key };
  await mkdir(project.path);
  await writeFile(join(project.path, "vardum.json"), JSON.stringify({ schema: 1, server: origin, workspace: "ws", vard: source.vardId }));
  assert.equal(JSON.parse((await run(project, "pull")).stdout).changed, 1);
  const locked = await readFile(join(project.path, ".vardum.lock"), "utf8");
  const response = await app.inject({ method: "PATCH", url: `${api}/assets/${source.assetId}/archive`, headers: { cookie: cookies.owner! },
    payload: { archived: true, expectedCurrentVersionId: source.versionId, expectedArchivedAt: null } });
  assert.equal(response.statusCode, 200, response.body);
  await rm(join(project.path, "assets"), { recursive: true });
  assert.equal(JSON.parse((await run(project, "pull", "--frozen")).stdout).changed, 1);
  assert.deepEqual(await readFile(join(project.path, "assets/nested/logo.svg")), source.bytes);
  assert.equal(await readFile(join(project.path, ".vardum.lock"), "utf8"), locked);
}
