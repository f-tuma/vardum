import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import sharp from "sharp";

export async function checkAssetUses(t: TestContext, app: FastifyInstance, admin: Pool,
  objects: Map<string, Buffer>, cookies: Record<string, string>) {
  const headers = { cookie: cookies.owner! };
  const api = "/api/workspaces/ws";
  const sourceId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="8" height="16" fill="blue"/></svg>');
  const checksum = createHash("sha256").update(bytes).digest("hex");
  objects.set(`uses-${first}`, bytes);
  objects.set(`uses-${second}`, bytes);
  await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws','reuse/source','Shared logo','fixture','fixture')", [sourceId]);
  for (const [id, number] of [[first, 1], [second, 2]] as const) await admin.query(
    "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1,'ws',$2,$3,'ready',$4,'logo.svg','image/svg+xml',$5,$6,'fixture','fixture')",
    [id, sourceId, number, `uses-${id}`, bytes.length, checksum]);
  await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [first, sourceId]);
  await admin.query("UPDATE asset_version SET width=16,height=16 WHERE asset_id=$1", [sourceId]);
  const create = (key: string, transformation: unknown = { format: "png", w: 8 }) => app.inject({
    method: "POST", url: `${api}/asset-uses`, headers,
    payload: { key, sourceAssetId: sourceId, displayName: "Shared logo", transformation },
  });
  const stable = (key: string, extra = {}) => app.inject({ url: `/w/demo/${key}`, headers, ...extra });
  let one: { id: string; revision: number };
  let two: { id: string; revision: number };

  await t.test("three independent uses share bytes/current and preserve source-only CLI listing", async () => {
    const a = await create("reuse/web/logo.png"); assert.equal(a.statusCode, 201, a.body); one = a.json();
    const b = await create("reuse/mobile/logo", { format: "webp", w: 12 }); assert.equal(b.statusCode, 201, b.body); two = b.json();
    const c = await create("reuse/original/logo.svg", null); assert.equal(c.statusCode, 201, c.body);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM asset_version WHERE asset_id=$1", [sourceId])).rows[0].n, 2);
    const list = await app.inject({ url: `${api}/asset-uses?sourceAssetId=${sourceId}&limit=2`, headers });
    assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().uses.length, 2); assert.ok(list.json().nextCursor);
    const next = await app.inject({ url: `${api}/asset-uses?sourceAssetId=${sourceId}&limit=2&cursor=${list.json().nextCursor}`, headers });
    assert.equal(next.json().uses.length, 1); assert.equal(next.json().nextCursor, null);
    const legacy = await app.inject({ url: `${api}/assets?search=reuse`, headers });
    assert.deepEqual(legacy.json().assets.map((row: { id: string }) => row.id), [sourceId]);
    const browser = await app.inject({ url: `${api}/assets?pagination=cursor&prefix=reuse/`, headers });
    assert.deepEqual(browser.json().folders.map((row: { name: string }) => row.name), ["mobile", "original", "web"]);
    const link = await stable("reuse/web/logo.png"); assert.equal(link.statusCode, 302, link.body);
    assert.match(link.headers.location!, new RegExp(`/__v/${first}/reuse/source\\?`));
    assert.match(link.headers.location!, /w=8&fit=inside&format=png&q=80&sig=/);
    const canonical = await app.inject({ url: link.headers.location!, headers });
    assert.equal(canonical.statusCode, 200, canonical.body); assert.equal(canonical.headers["content-type"], "image/png");
    const oldImmutable = link.headers.location!;
    const edited = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${one.id}`, headers,
      payload: { displayName: "Web logo", transformation: { format: "png", w: 10, bg: "#Ab12Ef" }, expectedRevision: 1 } });
    assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().revision, 2);
    const opaqueUrl = (await stable("reuse/web/logo.png")).headers.location!;
    assert.notEqual(opaqueUrl, oldImmutable);
    assert.match(opaqueUrl, /&bg=%23ab12ef&sig=/);
    const settings = (await app.inject({ url: `${api}/asset-uses?sourceAssetId=${sourceId}`, headers })).json();
    assert.equal(settings.uses.find((row: { id: string }) => row.id === one.id).transformation.bg, "#ab12ef");
    const opaque = await app.inject({ url: opaqueUrl, headers });
    assert.equal(opaque.statusCode, 200, opaque.body);
    assert.equal((await sharp(opaque.rawPayload).metadata()).hasAlpha, false);
    const decoded = await sharp(opaque.rawPayload).raw().toBuffer();
    assert.deepEqual([...decoded.subarray((5 * 10 + 9) * 3, (5 * 10 + 9) * 3 + 3)], [171, 18, 239]);
    assert.equal((await sharp(canonical.rawPayload).metadata()).hasAlpha, true, "captured original transformation retains transparency");
    assert.deepEqual(objects.get(`uses-${first}`), bytes, "background rendering never changes the retained SVG original");
    assert.match((await stable("reuse/mobile/logo")).headers.location!, /w=12&.*format=webp/);
    assert.equal((await app.inject({ url: oldImmutable, headers })).statusCode, 200, "captured immutable settings survive edit");
    const stale = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${one.id}`, headers,
      payload: { displayName: "Stale", transformation: null, expectedRevision: 1 } });
    assert.equal(stale.statusCode, 409, stale.body);
    const before = (await admin.query("SELECT revision,updated_at FROM asset_use WHERE id=$1", [one.id])).rows[0];
    const noop = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${one.id}`, headers,
      payload: { displayName: "Web logo", transformation: { format: "png", w: 10, bg: "#AB12EF" }, expectedRevision: 2 } });
    assert.equal(noop.statusCode, 200, noop.body);
    assert.deepEqual((await admin.query("SELECT revision,updated_at FROM asset_use WHERE id=$1", [one.id])).rows[0], before);
    const changedPath = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${one.id}`, headers,
      payload: { key: "another/logo.png", displayName: "Web logo", transformation: null, expectedRevision: 2 } });
    assert.equal(changedPath.statusCode, 400);
  });

  await t.test("private use authorizes before Location and on canonical targets, including HEAD/range/custom domain", async () => {
    for (const method of ["GET", "HEAD"] as const) for (const [role, expected] of [["anonymous", 401], ["outsider", 403], ["viewer", 302]] as const) {
      for (const [url, host] of [["/w/demo/reuse/web/logo.png", "localhost"], ["/w/reuse/web/logo.png", "cdn.example.test"]]) {
        const res = await app.inject({ method, url: url!, headers: { host: host!, ...(role === "anonymous" ? {} : { cookie: cookies[role]! }) } });
        assert.equal(res.statusCode, expected, res.body); assert.equal(res.headers["cache-control"], "private, no-store");
        if (expected !== 302) assert.equal(res.headers.location, undefined);
      }
    }
    const location = (await stable("reuse/web/logo.png")).headers.location!;
    for (const method of ["GET", "HEAD"] as const) {
      const denied = await app.inject({ method, url: location, headers: { range: "bytes=0-4" } });
      assert.equal(denied.statusCode, 401); assert.equal(denied.headers.location, undefined);
    }
    const range = await stable("reuse/original/logo.svg");
    const partial = await app.inject({ url: range.headers.location!, headers: { ...headers, range: "bytes=0-4" } });
    assert.equal(partial.statusCode, 206); assert.equal(partial.rawPayload.length, 5);
    const transformedRange = await app.inject({ url: location, headers: { ...headers, range: "bytes=0-4" } });
    assert.equal(transformedRange.statusCode, 200); assert.equal(transformedRange.headers["content-range"], undefined);
    const legacy = await app.inject({ url: "/assets/demo/reuse/web/logo.png", headers });
    assert.equal(legacy.statusCode, 308); assert.equal(legacy.headers.location, "/w/demo/reuse/web/logo.png");
    const { transformedAssetUrl } = await import("../src/transformation.js");
    const override = await app.inject({ url: transformedAssetUrl("demo", "reuse/web/logo.png", { format: "jpeg" }), headers });
    assert.equal(override.statusCode, 400); assert.equal(override.headers.location, undefined);
    const badActor = await app.inject({ method: "POST", url: `${api}/asset-uses`, headers: { cookie: cookies.viewer! },
      payload: { sourceAssetId: sourceId, key: "reuse/viewer", displayName: "Forbidden", transformation: null } });
    assert.equal(badActor.statusCode, 403);
    const crossTenant = await app.inject({ method: "POST", url: "/api/workspaces/other-ws/asset-uses", headers: { cookie: cookies.outsider! },
      payload: { sourceAssetId: sourceId, key: "cross-tenant", displayName: "Forbidden", transformation: null } });
    assert.equal(crossTenant.statusCode, 409);
    const { pool } = await import("../src/db/index.js");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM asset_use")).rows[0].n, 0);
    await assert.rejects(admin.query("UPDATE asset_use SET workspace_id='other-ws' WHERE id=$1", [one.id]), /immutable|foreign key/);
  });

  await t.test("live current, restore, public privacy and incompatible new MIME preserve explicit contracts", async () => {
    const pending = await app.inject({ method: "POST", url: `${api}/assets/${sourceId}/versions`, headers,
      payload: { filename: "logo.svg", mimeType: "image/svg+xml", size: bytes.length } });
    assert.equal(pending.statusCode, 201, pending.body);
    assert.match((await stable("reuse/web/logo.png")).headers.location!, new RegExp(first));
    await admin.query("UPDATE asset_version SET status='processing' WHERE id=$1", [pending.json().id]);
    const processingUses = await app.inject({ url: `${api}/asset-uses?sourceAssetId=${sourceId}`, headers });
    assert.ok(processingUses.json().uses.every((row: { sourceProcessing: boolean; currentVersionId: string }) => row.sourceProcessing && row.currentVersionId === first));
    await admin.query("UPDATE asset_version SET status='failed' WHERE id=$1", [pending.json().id]);
    const failedUses = await app.inject({ url: `${api}/asset-uses?sourceAssetId=${sourceId}`, headers });
    assert.ok(failedUses.json().uses.every((row: { sourceProcessing: boolean }) => !row.sourceProcessing));
    assert.match((await stable("reuse/web/logo.png")).headers.location!, new RegExp(first));
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [second, sourceId]);
    assert.match((await stable("reuse/web/logo.png")).headers.location!, new RegExp(second));
    const restore = await app.inject({ method: "POST", url: `${api}/assets/${sourceId}/versions/${first}/restore`, headers });
    assert.equal(restore.statusCode, 200, restore.body);
    assert.match((await stable("reuse/web/logo.png")).headers.location!, new RegExp(first));
    const publish = await app.inject({ method: "PATCH", url: `${api}/assets/${sourceId}/visibility`, headers, payload: { isPublic: true } });
    assert.equal(publish.statusCode, 200, publish.body);
    const publicUse = await app.inject({ url: "/w/demo/reuse/web/logo.png" });
    assert.equal(publicUse.statusCode, 302); assert.equal(publicUse.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
    assert.equal((await app.inject({ url: publicUse.headers.location! })).statusCode, 200);
    await app.inject({ method: "PATCH", url: `${api}/assets/${sourceId}/visibility`, headers, payload: { isPublic: false } });
    assert.equal((await app.inject({ url: publicUse.headers.location! })).statusCode, 401);
    await admin.query("UPDATE asset_version SET mime_type='video/mp4' WHERE id=$1", [second]);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [second, sourceId]);
    for (const key of ["reuse/web/logo.png", "reuse/original/logo.svg"]) {
      const unavailable = await stable(key); assert.equal(unavailable.statusCode, 422, unavailable.body);
      assert.equal(unavailable.headers.location, undefined); assert.equal(unavailable.headers["cache-control"], "private, no-store");
    }
    const listing = await app.inject({ url: `${api}/asset-uses?sourceAssetId=${sourceId}`, headers });
    assert.ok(listing.json().uses.every((row: { availabilityError: unknown; previewUrl: unknown }) => row.availabilityError && row.previewUrl === null));
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [first, sourceId]);
    assert.equal((await create("reuse/wrong.jpg")).statusCode, 422);
    assert.equal((await create("reuse/unrecognized.ico")).statusCode, 422);
    assert.equal((await create("reuse/size-only", { w: 8 })).statusCode, 400);
    assert.equal((await create("reuse/background-only", { w: 8, bg: "#123456" })).statusCode, 400);
  });

  await t.test("known impossible source size is rejected on create, edit and stable resolution", async () => {
    const full = await create("reuse/full-size", { format: "png" });
    assert.equal(full.statusCode, 201, full.body);
    await admin.query("UPDATE asset_version SET width=5000,height=5000 WHERE id=$1", [first]);
    const unavailable = await stable("reuse/full-size");
    assert.equal(unavailable.statusCode, 422, unavailable.body); assert.equal(unavailable.headers.location, undefined);
    assert.equal((await create("reuse/full-size-new", { format: "png" })).statusCode, 422);
    const badEdit = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${full.json().id}`, headers,
      payload: { displayName: "Impossible", transformation: { format: "png" }, expectedRevision: 1 } });
    assert.equal(badEdit.statusCode, 422, badEdit.body);
    const repair = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${full.json().id}`, headers,
      payload: { displayName: "Small preview", transformation: { format: "png", w: 320 }, expectedRevision: 1 } });
    assert.equal(repair.statusCode, 200, repair.body);
    assert.equal((await stable("reuse/full-size")).statusCode, 302);
    await admin.query("UPDATE asset_version SET width=16,height=16 WHERE id=$1", [first]);
  });

  await t.test("shared namespace rejects alias overwrites, ancestors, folders and import preflight before upload", async () => {
    for (const key of ["reuse/web/logo.png", "reuse/web/logo.png/child", "reuse/web"]) {
      const res = await app.inject({ method: "POST", url: `${api}/assets`, headers, payload: { key, displayName: "Overwrite" } });
      assert.equal(res.statusCode, 409, res.body);
    }
    assert.equal((await create("reuse/source")).statusCode, 409);
    assert.equal((await create("reuse/source/child")).statusCode, 409);
    assert.equal((await create("reuse")).statusCode, 409);
    assert.equal((await create("reuse/web")).statusCode, 409);
    const folder = await app.inject({ method: "POST", url: `${api}/folders`, headers, payload: { prefix: "reuse/web/", name: "logo.png" } });
    assert.equal(folder.statusCode, 409, folder.body);
    const nonempty = await app.inject({ method: "DELETE", url: `${api}/folders?prefix=reuse/web/`, headers });
    assert.equal(nonempty.statusCode, 409, nonempty.body);
    const noUpload = await app.inject({ method: "POST", url: `${api}/assets/${one.id}/versions`, headers,
      payload: { filename: "logo.png", mimeType: "image/png", size: 10 } });
    assert.equal(noUpload.statusCode, 404, noUpload.body);
    const vard = await app.inject({ method: "POST", url: `${api}/vards`, headers, payload: { name: "Use upload collision" } });
    assert.equal(vard.statusCode, 201, vard.body);
    const importPlan = await app.inject({ method: "POST", url: `${api}/vards/${vard.json().id}/items/import-plan`, headers,
      payload: { files: [{ assetId: randomUUID(), key: "reuse/web/logo.png", outputPath: "logo.png", checksum, mimeType: "image/png", size: 10 }] } });
    assert.equal(importPlan.statusCode, 409, importPlan.body);
    const raceKey = "reuse/race";
    const raced = await Promise.all([create(raceKey), app.inject({ method: "POST", url: `${api}/assets`, headers, payload: { key: raceKey, displayName: "Racer" } })]);
    assert.deepEqual(raced.map((res) => res.statusCode).sort(), [201, 409], raced.map(res => res.body).join("\n"));
  });

  await t.test("create versus source delete commits only a valid source/use pair", async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = randomUUID(); const version = randomUUID();
      await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws',$2,'Race source','fixture','fixture')", [id, `race-source-${attempt}`]);
      await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1,'ws',$2,1,'ready',$3,'logo.svg','image/svg+xml',$4,$5,'fixture','fixture')", [version, id, `race-${version}`, bytes.length, checksum]);
      await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [version, id]);
      const useRequest = () => app.inject({ method: "POST", url: `${api}/asset-uses`, headers,
        payload: { sourceAssetId: id, key: `race-use-${attempt}`, displayName: "Race use", transformation: null } });
      const deleteRequest = () => app.inject({ method: "DELETE", url: `${api}/assets/${id}`, headers });
      const responses = attempt % 2 ? await Promise.all([deleteRequest(), useRequest()]) : await Promise.all([useRequest(), deleteRequest()]);
      const codes = responses.map(res => res.statusCode).sort();
      assert.ok(JSON.stringify(codes) === "[201,409]" || JSON.stringify(codes) === "[204,409]", responses.map(res => res.body).join("\n"));
      const state = (await admin.query("SELECT (SELECT count(*)::int FROM asset WHERE id=$1) AS sources,(SELECT count(*)::int FROM asset_use WHERE source_asset_id=$1) AS uses", [id])).rows[0];
      assert.ok((state.sources === 1 && state.uses === 1) || (state.sources === 0 && state.uses === 0));
      await admin.query("DELETE FROM asset_use WHERE source_asset_id=$1", [id]);
      await admin.query("DELETE FROM asset WHERE id=$1", [id]);
    }
    await assert.rejects(admin.query("INSERT INTO asset_use(workspace_id,source_asset_id,key,display_name,output_mime_type,created_by,updated_by) VALUES ('other-ws',$1,'bad-reference','Bad','image/svg+xml','fixture','fixture')", [sourceId]), /foreign key/);
  });

  await t.test("authorized whole-workspace deletion removes linked records before source cascade", async () => {
    const workspaceId = `use-delete-${randomUUID()}`;
    const source = randomUUID();
    await admin.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) SELECT $1,organization_id,'Use deletion',$1,'fixture','fixture' FROM workspace WHERE id='ws'", [workspaceId]);
    await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,$2,'source','Source','fixture','fixture')", [source, workspaceId]);
    await admin.query("INSERT INTO asset_use(workspace_id,source_asset_id,key,display_name,output_mime_type,created_by,updated_by) VALUES ($1,$2,'linked','Linked','image/svg+xml','fixture','fixture')", [workspaceId, source]);
    const removed = await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}`, headers, payload: { confirmation: workspaceId } });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM asset_use WHERE workspace_id=$1", [workspaceId])).rows[0].n, 0);
  });

  await t.test("source delete is blocked, use remove is guarded and never schedules source cleanup", async () => {
    const blocked = await app.inject({ method: "DELETE", url: `${api}/assets/${sourceId}`, headers });
    assert.equal(blocked.statusCode, 409, blocked.body); assert.equal(blocked.json().code, "source_in_use");
    await assert.rejects(admin.query("DELETE FROM asset WHERE id=$1", [sourceId]), /foreign key/);
    const stale = await app.inject({ method: "DELETE", url: `${api}/asset-uses/${one.id}?expectedRevision=1`, headers });
    assert.equal(stale.statusCode, 409, stale.body);
    const removed = await app.inject({ method: "DELETE", url: `${api}/asset-uses/${one.id}?expectedRevision=2`, headers });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await stable("reuse/web/logo.png")).statusCode, 404);
    assert.equal((await stable("reuse/mobile/logo")).statusCode, 302);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM asset_version WHERE asset_id=$1", [sourceId])).rows[0].n, 3);
    assert.ok(objects.has(`uses-${first}`));
    const emptied = await app.inject({ method: "DELETE", url: `${api}/folders?prefix=reuse/web/`, headers });
    assert.equal(emptied.statusCode, 204, emptied.body);
    assert.ok(two.id);
  });
}
