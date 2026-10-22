import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import sharp from "sharp";
import { mutateLegacyVersion } from "./legacy-version.fixture.js";

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
    "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,width,height,created_by,updated_by) VALUES ($1,'ws',$2,$3,'ready',$4,'logo.svg','image/svg+xml',$5,$6,16,16,'fixture','fixture')",
    [id, sourceId, number, `uses-${id}`, bytes.length, checksum]);
  await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [first, sourceId]);
  const create = (key: string, transformation: unknown = { format: "png", w: 8 }) => app.inject({
    method: "POST", url: `${api}/asset-uses`, headers,
    payload: { key, sourceAssetId: sourceId, displayName: "Shared logo", transformation },
  });
  const stable = (key: string, extra = {}) => app.inject({ url: `/w/demo/${key}`, headers, ...extra });
  let one: { id: string; revision: number };
  let two: { id: string; revision: number };
  const bindingVardIds: string[] = [], bindingUseIds: string[] = [];
  t.after(async () => {
    await capable(async (client) => {
      await client.query("DELETE FROM vard WHERE id=ANY($1::uuid[])", [bindingVardIds]);
      await client.query("DELETE FROM asset_use WHERE id=ANY($1::uuid[])", [bindingUseIds]);
    });
  });
  async function capable<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('vardum.vard_definition_schema','2',true)");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async function editor(vardId: string) {
    const response = await app.inject({ url: `${api}/vards/${vardId}/editor?definitionSchema=2`, headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  async function bindingVard() {
    const response = await app.inject({ method: "POST", url: `${api}/vards`, headers,
      payload: { name: `Use binding ${randomUUID()}` } });
    assert.equal(response.statusCode, 201, response.body);
    bindingVardIds.push(response.json().id);
    return editor(response.json().id);
  }
  const bind = (vardId: string, expectedRevision: string, useId: string) =>
    app.inject({ method: "PUT", url: `${api}/vards/${vardId}/editor/items`, headers,
      payload: { definitionSchema: 2, expectedRevision,
        items: [{ id: null, outputPath: "linked.svg", binding: { kind: "use", assetUseId: useId } }] } });
  async function waitForLock(predicate: string, count = 1) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await admin.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND ${predicate}`);
      if (result.rows[0].n >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("expected real PostgreSQL lock waiters before releasing the barrier");
  }
  async function queued<A, B>(firstAction: () => PromiseLike<A>, secondAction: () => PromiseLike<B>): Promise<[A, B]> {
    const blocker = await admin.connect();
    const pending: Promise<unknown>[] = [];
    const predicate = "l.locktype='advisory' AND l.classid=74122 AND l.objid=((hashtext('ws')::bigint & 4294967295)::oid) AND l.objsubid=2";
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(74122,hashtext('ws'))");
      const first = Promise.resolve().then(firstAction);
      pending.push(first); void first.catch(() => {});
      await waitForLock(predicate);
      const second = Promise.resolve().then(secondAction);
      pending.push(second); void second.catch(() => {});
      await waitForLock(predicate, 2);
      await blocker.query("COMMIT");
      return await Promise.all([first, second]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled(pending);
    }
  }

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
    // The existing PNG quality=80 encoder can quantize palette RGB by a step.
    const backgroundPixel = [...decoded.subarray((5 * 10 + 9) * 3, (5 * 10 + 9) * 3 + 3)];
    assert.ok(backgroundPixel.every((value, channel) => Math.abs(value - [171, 18, 239][channel]!) <= 2));
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

  await t.test("padded linked uses persist settings, sign their final canvas and preserve captured output after edits", async () => {
    const spec = { w: 40, h: 32, fit: "contain", format: "png", bg: "#204060", pad: 25 };
    const created = await create("reuse/padded/logo.png", spec);
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id;
    assert.deepEqual((await admin.query("SELECT transformation FROM asset_use WHERE id=$1", [id])).rows[0].transformation, spec);
    const capturedUrl = (await stable("reuse/padded/logo.png")).headers.location!;
    assert.match(capturedUrl, /w=40&h=32&fit=contain&format=png&q=80&bg=%23204060&pad=25&sig=/);
    const captured = await app.inject({ url: capturedUrl, headers });
    assert.equal(captured.statusCode, 200, captured.body);
    const metadata = await sharp(captured.rawPayload).metadata();
    assert.equal(metadata.width, 40); assert.equal(metadata.height, 32); assert.equal(metadata.hasAlpha, false);
    const listing = (await app.inject({ url: `${api}/asset-uses?sourceAssetId=${sourceId}`, headers })).json();
    assert.deepEqual(listing.uses.find((row: { id: string }) => row.id === id).transformation, spec);
    const edited = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${id}`, headers,
      payload: { displayName: "Shared logo", transformation: { ...spec, pad: 10 }, expectedRevision: 1 } });
    assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().revision, 2);
    const nextUrl = (await stable("reuse/padded/logo.png")).headers.location!;
    assert.notEqual(nextUrl, capturedUrl); assert.match(nextUrl, /&pad=10&sig=/);
    const next = await app.inject({ url: nextUrl, headers });
    assert.equal(next.statusCode, 200, next.body); assert.notDeepEqual(next.rawPayload, captured.rawPayload);
    assert.deepEqual((await app.inject({ url: capturedUrl, headers })).rawPayload, captured.rawPayload);
    const before = (await admin.query("SELECT transformation,revision FROM asset_use WHERE id=$1", [id])).rows[0];
    const invalid = await app.inject({ method: "PATCH", url: `${api}/asset-uses/${id}`, headers,
      payload: { displayName: "Shared logo", transformation: { ...spec, fit: "cover" }, expectedRevision: 2 } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual((await admin.query("SELECT transformation,revision FROM asset_use WHERE id=$1", [id])).rows[0], before);
    assert.equal((await app.inject({ method: "DELETE", url: `${api}/asset-uses/${id}?expectedRevision=2`, headers })).statusCode, 204);
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
    await mutateLegacyVersion(admin, "UPDATE asset_version SET mime_type='video/mp4' WHERE id=$1", [second]);
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
    await mutateLegacyVersion(admin, "UPDATE asset_version SET width=5000,height=5000 WHERE id=$1", [first]);
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
    await mutateLegacyVersion(admin, "UPDATE asset_version SET width=16,height=16 WHERE id=$1", [first]);
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

  await t.test("use deletion checks revision before live references and refuses without mutation or audit", async () => {
    const created = await create(`reuse/bound/${randomUUID()}`, null);
    assert.equal(created.statusCode, 201, created.body);
    const useId = created.json().id;
    bindingUseIds.push(useId);
    const definition = await bindingVard();
    const bound = await bind(definition.id, definition.revision, useId);
    assert.equal(bound.statusCode, 200, bound.body);
    const before = (await admin.query("SELECT * FROM asset_use WHERE id=$1", [useId])).rows;
    const auditBefore = (await admin.query("SELECT * FROM audit_event WHERE target_id=$1 ORDER BY id", [useId])).rows;
    const stale = await app.inject({ method: "DELETE", url: `${api}/asset-uses/${useId}?expectedRevision=2`, headers });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().code, undefined, "OCC precedes the reference diagnostic");
    const refused = await app.inject({ method: "DELETE", url: `${api}/asset-uses/${useId}?expectedRevision=1`, headers });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().code, "asset_use_in_use");
    assert.deepEqual((await admin.query("SELECT * FROM asset_use WHERE id=$1", [useId])).rows, before);
    assert.deepEqual((await admin.query("SELECT * FROM audit_event WHERE target_id=$1 ORDER BY id", [useId])).rows, auditBefore);
    const cleared = await app.inject({ method: "PUT", url: `${api}/vards/${definition.id}/editor/items`, headers,
      payload: { definitionSchema: 2, expectedRevision: bound.json().revision, items: [] } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const removed = await app.inject({ method: "DELETE", url: `${api}/asset-uses/${useId}?expectedRevision=1`, headers });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM asset WHERE id=$1", [sourceId])).rows[0].n, 1);
  });

  await t.test("binding creation and use deletion serialize in both guarded orders", async () => {
    for (const bindingFirst of [true, false]) {
      const created = await create(`reuse/bind-delete/${randomUUID()}`, null);
      assert.equal(created.statusCode, 201, created.body);
      const useId = created.json().id;
      bindingUseIds.push(useId);
      const definition = await bindingVard();
      const add = () => bind(definition.id, definition.revision, useId);
      const remove = () => app.inject({ method: "DELETE", url: `${api}/asset-uses/${useId}?expectedRevision=1`, headers });
      const responses = bindingFirst ? await queued(add, remove) : await queued(remove, add);
      // A missing/foreign use is an invalid binding input (400), without
      // disclosing whether another workspace owns that UUID.
      assert.deepEqual(responses.map(response => response.statusCode), bindingFirst ? [200, 409] : [204, 400],
        responses.map(response => response.body).join("\n"));
      const items = (await admin.query("SELECT * FROM vard_item WHERE vard_id=$1", [definition.id])).rows;
      const uses = (await admin.query("SELECT * FROM asset_use WHERE id=$1", [useId])).rows;
      assert.equal(items.length, bindingFirst ? 1 : 0);
      assert.equal(uses.length, bindingFirst ? 1 : 0);
      if (bindingFirst) {
        assert.equal(responses[1].json().code, "asset_use_in_use");
        assert.equal(items[0].asset_use_id, useId);
        assert.equal(items[0].asset_id, sourceId);
        assert.equal(items[0].definition_schema, 2);
      } else {
        assert.equal((await editor(definition.id)).revision, definition.revision,
          "failed binding after deletion leaves the parent configuration unchanged");
      }
      const deletedAudit = (await admin.query("SELECT * FROM audit_event WHERE target_id=$1 AND action='asset_use.deleted'", [useId])).rows;
      assert.equal(deletedAudit.length, bindingFirst ? 0 : 1);
    }
  });

  await t.test("the use-reference FK race returns409 after rolling back the deletion transaction", async () => {
    const created = await create(`reuse/fk-backstop/${randomUUID()}`, null);
    assert.equal(created.statusCode, 201, created.body);
    const useId = created.json().id;
    bindingUseIds.push(useId);
    const definition = await bindingVard();
    const writer = await admin.connect();
    let removal: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT set_config('vardum.vard_definition_schema','2',true)");
      await writer.query("UPDATE vard SET definition_schema=2 WHERE id=$1", [definition.id]);
      await writer.query("INSERT INTO vard_item(workspace_id,vard_id,definition_schema,asset_id,asset_use_id,output_path,created_by,updated_by) VALUES('ws',$1,2,$2,$3,'linked.svg','fixture','fixture')",
        [definition.id, sourceId, useId]);
      removal = Promise.resolve(app.inject({ method: "DELETE", url: `${api}/asset-uses/${useId}?expectedRevision=1`, headers }));
      void removal.catch(() => {});
      await waitForLock("a.query LIKE 'delete from \"asset_use\"%' AND a.wait_event_type='Lock'");
      await writer.query("COMMIT");
      const result = await removal;
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().code, "asset_use_in_use");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM asset_use WHERE id=$1", [useId])).rows[0].n, 1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM vard_item WHERE asset_use_id=$1", [useId])).rows[0].n, 1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1 AND action='asset_use.deleted'", [useId])).rows[0].n, 0);
      assert.equal((await editor(definition.id)).storedDefinitionSchema, 2,
        "a following request can reuse the pool after the failed FK transaction");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      if (removal) await removal;
    }
  });

  await t.test("authorized whole-workspace deletion removes Vards before linked uses and preserves cleanup payloads", async () => {
    const workspaceId = `use-delete-${randomUUID()}`;
    const source = randomUUID(), version = randomUUID(), useId = randomUUID(), vardId = randomUUID();
    const storageKey = `originals/${workspaceId}/${source}/${version}/source`;
    await admin.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) SELECT $1,organization_id,'Use deletion',$1,'fixture','fixture' FROM workspace WHERE id='ws'", [workspaceId]);
    await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,$2,'source','Source','fixture','fixture')", [source, workspaceId]);
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES($1,$2,$3,1,'ready',$4,'source.svg','image/svg+xml',$5,$6,'fixture','fixture')",
      [version, workspaceId, source, storageKey, bytes.length, checksum]);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [version, source]);
    await admin.query("INSERT INTO asset_use(id,workspace_id,source_asset_id,key,display_name,output_mime_type,created_by,updated_by) VALUES ($1,$2,$3,'linked','Linked','image/svg+xml','fixture','fixture')", [useId, workspaceId, source]);
    await capable(async (client) => {
      await client.query("INSERT INTO vard(id,workspace_id,definition_schema,name,created_by,updated_by) VALUES($1,$2,2,'Workspace live binding','fixture','fixture')", [vardId, workspaceId]);
      await client.query("INSERT INTO vard_item(workspace_id,vard_id,definition_schema,asset_id,asset_use_id,output_path,created_by,updated_by) VALUES($1,$2,2,$3,$4,'linked.svg','fixture','fixture')", [workspaceId, vardId, source, useId]);
    });
    const removed = await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}`, headers, payload: { confirmation: workspaceId } });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM asset_use WHERE workspace_id=$1", [workspaceId])).rows[0].n, 0);
    for (const table of ["workspace", "vard", "vard_item", "asset", "asset_version"]) {
      const column = table === "workspace" ? "id" : "workspace_id";
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [workspaceId])).rows[0].n, 0);
    }
    const cleanup = (await admin.query("SELECT data FROM pgboss.job WHERE name='asset-delete' AND singleton_key=$1", [`workspace-delete:${workspaceId}:${source}`])).rows;
    assert.deepEqual(cleanup.map(row => row.data), [{ versionIds: [version], storageKeys: [storageKey] }]);
    const sweep = (await admin.query("SELECT data,start_after>now()+interval '19 minutes' AS delayed FROM pgboss.job WHERE name='asset-delete' AND singleton_key=$1", [`workspace-delete:${workspaceId}:origin-sweep`])).rows;
    assert.deepEqual(sweep.map(row => row.data), [{ versionIds: [], storageKeys: [], prefixes: [`originals/${workspaceId}/`] }]);
    assert.equal(sweep[0].delayed, true);
  });

  await t.test("source delete is blocked, use remove is guarded and never schedules source cleanup", async () => {
    const blocked = await app.inject({ method: "DELETE", url: `${api}/assets/${sourceId}`, headers });
    assert.equal(blocked.statusCode, 409, blocked.body); assert.equal(blocked.json().code, "source_in_use");
    // Earlier cases now retain schema2 Vard references until fixture cleanup.
    // Declare capability here to isolate the source/use RESTRICT FK itself.
    await assert.rejects(capable(client => client.query("DELETE FROM asset WHERE id=$1", [sourceId])),
      (error: any) => error.code === "23503");
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
