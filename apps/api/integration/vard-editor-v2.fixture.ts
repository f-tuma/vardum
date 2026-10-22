import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { VardEditorDefinitionV2, VardEditorItemInputV2, Transformation } from "@vardum/shared";
import type { FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
import sharp from "sharp";

const execFile = promisify(execFileCallback);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Source = { id: string; versionId: string; key: string; workspaceId: string; bytes: Buffer };
type Use = { id: string; revision: number; key: string; displayName: string };

/** Real API/auth/runtime-role PG fixture, sharing private-delivery's disposable services. */
export async function checkVardEditorV2(t: TestContext, fixture: {
  admin: Pool; app: FastifyInstance; objects: Map<string, Buffer>;
  keyHeaders: Record<string, Record<string, string>>; cookies: Record<string, string>;
  root: string; cliPath?: string;
}) {
  const { admin, app, objects, keyHeaders, cookies } = fixture;
  const prefix = `editor-v2-${randomUUID()}/`, base = "/api/workspaces/ws/vards";
  const headers = keyHeaders.write!, readHeaders = keyHeaders.read!;
  const vardIds: string[] = [], sourceIds: string[] = [], useIds: string[] = [], objectKeys: string[] = [];
  const blue = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#0044ff"/></svg>');
  const green = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#00bb44"/></svg>');
  async function capable<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('vardum.vard_definition_schema','2',true)");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  t.after(async () => {
    await capable(async (client) => {
      await client.query("DELETE FROM vard WHERE id=ANY($1::uuid[])", [vardIds]);
      await client.query("DELETE FROM asset_use WHERE id=ANY($1::uuid[])", [useIds]);
      await client.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [sourceIds]);
    });
    for (const key of objectKeys) objects.delete(key);
  });
  function ok(response: Awaited<ReturnType<typeof app.inject>>, status = 200) {
    assert.equal(response.statusCode, status, response.body);
    return status === 204 ? undefined : response.json();
  }
  const get = (id: string, principal = readHeaders, workspaceId = "ws") =>
    app.inject({ url: `/api/workspaces/${workspaceId}/vards/${id}/editor?definitionSchema=2`, headers: principal });
  const editor = async (id: string) => ok(await get(id)) as VardEditorDefinitionV2;
  const put = (id: string, revision: string, items: VardEditorItemInputV2[], principal = headers) =>
    app.inject({ method: "PUT", url: `${base}/${id}/editor/items`, headers: principal,
      payload: { definitionSchema: 2, expectedRevision: revision, items } });
  const patch = (id: string, revision: string, fields: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `${base}/${id}/editor`, headers,
      payload: { definitionSchema: 2, expectedRevision: revision, ...fields } });
  const manifest = async (id: string) => ok(await app.inject({ url: `${base}/${id}/manifest`, headers: readHeaders }));
  const literal = (definition: VardEditorDefinitionV2): VardEditorItemInputV2[] =>
    definition.items.map(({ id, outputPath, binding }) => ({ id, outputPath, binding }));
  const linked = (use: Use, outputPath: string): VardEditorItemInputV2 =>
    ({ id: null, outputPath, binding: { kind: "use", assetUseId: use.id } });
  const direct = (source: Source, outputPath: string): VardEditorItemInputV2 =>
    ({ id: null, outputPath, binding: { kind: "source", assetId: source.id,
      versionId: null, transformation: null, writable: false } });
  async function makeVard(isPublic = false) {
    const result = ok(await app.inject({ method: "POST", url: base, headers,
      payload: { name: `Schema2 ${randomUUID()}`, isPublic } }), 201);
    vardIds.push(result.id);
    return editor(result.id);
  }
  async function addVersion(source: Pick<Source, "id" | "workspaceId">, bytes = blue, status = "ready") {
    const id = randomUUID(), storageKey = `${prefix}${id}`;
    objects.set(storageKey, bytes); objectKeys.push(storageKey);
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,width,height,created_by,updated_by) SELECT $1,$2,$3,coalesce(max(number),0)+1,$4,$5,'source.svg','image/svg+xml',$6,$7,16,8,'fixture','fixture' FROM asset_version WHERE asset_id=$3",
      [id, source.workspaceId, source.id, status, storageKey, bytes.length, digest(bytes)]);
    return id;
  }
  async function makeSource(workspaceId = "ws") {
    const id = randomUUID(), key = `${prefix}${id}`, source = { id, key, workspaceId };
    sourceIds.push(id);
    await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,$2,$3,'V2 source','fixture','fixture')", [id, workspaceId, key]);
    const versionId = await addVersion(source);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, id]);
    return { ...source, versionId, bytes: blue };
  }
  async function makeUse(source: Source, recipe: Transformation | null, suffix = ".png") {
    const key = `${prefix}use-${randomUUID()}${suffix}`;
    const result = ok(await app.inject({ method: "POST", url: `/api/workspaces/${source.workspaceId}/asset-uses`,
      headers: source.workspaceId === "ws" ? headers : { cookie: cookies.outsider! },
      payload: { key, sourceAssetId: source.id, displayName: "Live fixture use", transformation: recipe } }), 201);
    useIds.push(result.id);
    return { ...result, key } as Use;
  }
  async function editUse(use: Use, recipe: Transformation | null) {
    const result = ok(await app.inject({ method: "PATCH", url: `/api/workspaces/ws/asset-uses/${use.id}`, headers,
      payload: { displayName: use.displayName, transformation: recipe, expectedRevision: use.revision } }));
    use.revision = result.revision;
  }
  async function snapshot(id: string) {
    return {
      record: (await admin.query("SELECT *,updated_at::text AS modification FROM vard WHERE id=$1", [id])).rows,
      items: (await admin.query("SELECT *,created_at::text AS creation,updated_at::text AS modification FROM vard_item WHERE vard_id=$1 ORDER BY id", [id])).rows,
      audit: (await admin.query("SELECT * FROM audit_event WHERE target_id=$1 ORDER BY id", [id])).rows,
    };
  }
  async function decode(url: string) {
    const response = await app.inject({ url, headers: readHeaders });
    assert.equal(response.statusCode, 200, response.body);
    return { bytes: response.rawPayload, metadata: await sharp(response.rawPayload).metadata(),
      pixels: await sharp(response.rawPayload).ensureAlpha().raw().toBuffer() };
  }
  async function waitForRelationWait(table: string, count = 1) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE relation=$1::regclass AND NOT granted", [table]);
      if (result.rows[0].n >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`expected PostgreSQL wait on ${table}`);
  }
  async function queued<A, B>(firstAction: () => PromiseLike<A>, secondAction: () => PromiseLike<B>) {
    const blocker = await admin.connect(), pending: Promise<unknown>[] = [];
    const wait = async (count: number) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const row = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=74122 AND objid=((hashtext('ws')::bigint & 4294967295)::oid) AND objsubid=2 AND NOT granted");
        if (row.rows[0].n >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`expected ${count} content-guard waiters`);
    };
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(74122,hashtext('ws'))");
      const first = Promise.resolve().then(firstAction); pending.push(first); void first.catch(() => {}); await wait(1);
      const second = Promise.resolve().then(secondAction); pending.push(second); void second.catch(() => {}); await wait(2);
      await blocker.query("COMMIT"); return await Promise.all([first, second]);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(pending); }
  }

  await t.test("live use dimensions and safe area change real Vard bytes while literal identity and revision stay stable", async () => {
    const source = await makeSource();
    const recipe: Transformation = { w: 40, h: 32, fit: "contain", format: "png", bg: "#ffffff", pad: 25 };
    const first = await makeUse(source, recipe), second = await makeUse(source, { w: 12, h: 12, fit: "contain", format: "png" });
    const initial = await makeVard();
    const saved = ok(await put(initial.id, initial.revision, [linked(first, "first.png"), linked(second, "second.png")])) as VardEditorDefinitionV2;
    assert.equal(saved.definitionSchema, 2); assert.equal(saved.storedDefinitionSchema, 2);
    const before = await snapshot(saved.id), old = await manifest(saved.id);
    const a = old.items.find((item: { outputPath: string }) => item.outputPath === "first.png"), b = old.items.find((item: { outputPath: string }) => item.outputPath === "second.png");
    assert.equal(a.assetId, source.id); assert.equal(a.key, source.key); assert.equal(a.writable, false); assert.equal(a.pinned, false);
    assert.match(a.downloadUrl, new RegExp(`/__v/${source.versionId}/`)); assert.doesNotMatch(a.downloadUrl, new RegExp(first.id));
    const decoded = await decode(a.downloadUrl);
    assert.equal(decoded.metadata.width, 40); assert.equal(decoded.metadata.height, 32);
    const bluePixels: Array<[number, number]> = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 40; x++) {
      const p = (y * 40 + x) * 4;
      if (decoded.pixels[p]! < 40 && decoded.pixels[p + 2]! > 200) bluePixels.push([x, y]);
    }
    assert.deepEqual([Math.min(...bluePixels.map(p => p[0])), Math.max(...bluePixels.map(p => p[0])),
      Math.min(...bluePixels.map(p => p[1])), Math.max(...bluePixels.map(p => p[1]))], [8, 31, 10, 21]);
    await editUse(first, { ...recipe, w: 64, h: 48, pad: 12.5 });
    const refreshed = await editor(saved.id), next = await manifest(saved.id);
    assert.equal(refreshed.revision, saved.revision); assert.deepEqual(refreshed.items.map(item => item.id), saved.items.map(item => item.id));
    const nextA = next.items.find((item: { id: string }) => item.id === a.id), nextB = next.items.find((item: { id: string }) => item.id === b.id);
    assert.deepEqual(nextB, b, "another use of the same source remains independent");
    assert.notEqual(nextA.fingerprint, a.fingerprint); assert.notEqual(nextA.downloadUrl, a.downloadUrl);
    const changed = await decode(nextA.downloadUrl);
    assert.equal(changed.metadata.width, 64); assert.equal(changed.metadata.height, 48); assert.notDeepEqual(changed.bytes, decoded.bytes);
    assert.deepEqual((await decode(a.downloadUrl)).bytes, decoded.bytes, "captured immutable recipe remains usable");
    ok(await put(saved.id, refreshed.revision, literal(refreshed).reverse()));
    assert.deepEqual(await snapshot(saved.id), before, "live recipe refresh and a reordered no-op do not mutate Vard configuration/audit");
    for (const row of before.items) {
      assert.equal(row.asset_id, source.id); assert.ok(row.asset_use_id); assert.equal(row.version_id, null);
      assert.equal(row.transformation, null); assert.equal(row.writable, false); assert.equal(row.definition_schema, 2);
    }
    const pending = await addVersion(source, green, "pending");
    assert.ok((await manifest(saved.id)).items.every((item: { versionId: string }) => item.versionId === source.versionId));
    await admin.query("UPDATE asset_version SET status='failed' WHERE id=$1", [pending]);
    assert.ok((await manifest(saved.id)).items.every((item: { versionId: string }) => item.versionId === source.versionId));
    const nextVersion = await addVersion(source, green);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [nextVersion, source.id]);
    assert.ok((await manifest(saved.id)).items.every((item: { versionId: string }) => item.versionId === nextVersion));
    assert.equal((await editor(saved.id)).revision, saved.revision);
    ok(await app.inject({ method: "POST", url: `/api/workspaces/ws/assets/${source.id}/versions/${source.versionId}/restore`, headers }));
    assert.ok((await manifest(saved.id)).items.every((item: { versionId: string }) => item.versionId === source.versionId));
  });

  await t.test("legacy and v1 definitions refuse marker2 before domain checks, without a token or partial write", async () => {
    const source = await makeSource(), use = await makeUse(source, null, ".svg"), initial = await makeVard();
    const old = ok(await app.inject({ url: `${base}/${initial.id}/editor`, headers: readHeaders }));
    const saved = ok(await put(initial.id, initial.revision, [linked(use, "linked.svg")])) as VardEditorDefinitionV2;
    const before = await snapshot(initial.id), sourceItem = { assetId: source.id, outputPath: "source.svg", versionId: null, transformation: null, writable: false };
    const requests = [
      { method: "GET" as const, url: `${base}/${initial.id}` },
      { method: "PATCH" as const, url: `${base}/${initial.id}`, payload: { name: "Legacy must not save" } },
      { method: "PUT" as const, url: `${base}/${initial.id}/items`, payload: { items: [sourceItem] } },
      { method: "PUT" as const, url: `${base}/${initial.id}/items`, payload: { items: [sourceItem, sourceItem] } },
      { method: "DELETE" as const, url: `${base}/${initial.id}` },
      { method: "GET" as const, url: `${base}/${initial.id}/editor` },
      { method: "PATCH" as const, url: `${base}/${initial.id}/editor`, payload: { expectedRevision: old.revision, name: "V1 must not save" } },
      { method: "PUT" as const, url: `${base}/${initial.id}/editor/items`, payload: { expectedRevision: old.revision, items: [{ id: null, ...sourceItem }] } },
      { method: "DELETE" as const, url: `${base}/${initial.id}/editor?expectedRevision=${old.revision}` },
    ];
    for (const request of requests) {
      const response = await app.inject({ ...request, headers });
      assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, "vard_definition_upgrade_required");
      assert.equal(response.json().requiredDefinitionSchema, 2); assert.equal(response.json().revision, undefined); assert.equal(response.json().currentRevision, undefined);
      assert.deepEqual(await snapshot(initial.id), before);
    }
    for (const stale of [await put(saved.id, initial.revision, []),
      await patch(saved.id, initial.revision, { name: "Stale v2 metadata" }),
      await app.inject({ method: "DELETE", url: `${base}/${saved.id}/editor?definitionSchema=2&expectedRevision=${initial.revision}`, headers })]) {
      assert.equal(stale.statusCode, 409, stale.body); assert.equal(stale.json().code, "vard_revision_conflict"); assert.equal(stale.json().currentRevision, saved.revision);
      assert.deepEqual(await snapshot(initial.id), before);
    }
  });

  await t.test("retained unavailable bindings remain repairable, while fresh and foreign bindings reject atomically", async () => {
    const source = await makeSource(), use = await makeUse(source, { format: "png", w: 16 }), initial = await makeVard();
    const saved = ok(await put(initial.id, initial.revision, [linked(use, "linked.png")])) as VardEditorDefinitionV2;
    await admin.query("UPDATE asset SET current_version_id=NULL WHERE id=$1", [source.id]);
    const unavailable = await editor(initial.id), output = (await manifest(initial.id)).items[0];
    assert.equal(unavailable.revision, saved.revision); assert.deepEqual(unavailable.items[0]!.binding, { kind: "use", assetUseId: use.id });
    assert.ok(unavailable.items[0]!.resolved.availabilityError);
    for (const key of ["versionId", "sourceChecksum", "fingerprint", "downloadUrl"]) assert.equal(output[key], null);
    const before = await snapshot(initial.id);
    ok(await put(initial.id, unavailable.revision, literal(unavailable)));
    assert.deepEqual(await snapshot(initial.id), before);
    const fresh = await makeVard(), freshBefore = await snapshot(fresh.id);
    const refused = await put(fresh.id, fresh.revision, [linked(use, "new.png")]);
    assert.equal(refused.statusCode, 409, refused.body); assert.equal(refused.json().code, "linked_use_unavailable");
    assert.deepEqual(await snapshot(fresh.id), freshBefore);
    const foreign = await makeUse(await makeSource("other-ws"), null, ".svg");
    assert.equal((await put(fresh.id, fresh.revision, [linked(foreign, "foreign.svg")])).statusCode, 400);
    assert.deepEqual(await snapshot(fresh.id), freshBefore);
    assert.equal((await get(initial.id, keyHeaders.other!)).statusCode, 401);
    assert.equal((await get(initial.id, readHeaders, "other-ws")).statusCode, 401);
    assert.equal((await get(randomUUID())).statusCode, 404);
    const repaired = ok(await patch(initial.id, unavailable.revision, { name: "Unavailable remains editable" })) as VardEditorDefinitionV2;
    assert.deepEqual(repaired.items[0]!.binding, unavailable.items[0]!.binding);
    const cleared = ok(await put(initial.id, repaired.revision, [])) as VardEditorDefinitionV2;
    assert.equal(cleared.storedDefinitionSchema, 2);
    assert.equal((await app.inject({ url: `${base}/${initial.id}/editor`, headers: readHeaders })).statusCode, 409);
    const safe = ok(await patch(initial.id, cleared.revision, { returnToSourceOnly: true })) as VardEditorDefinitionV2;
    assert.equal(safe.storedDefinitionSchema, 1); assert.match(ok(await app.inject({ url: `${base}/${initial.id}/editor`, headers: readHeaders })).revision, /^v1:/);
  });

  await t.test("path swaps preserve exact creation metadata, and unsafe downgrade rolls back metadata and audit", async () => {
    const source = await makeSource(), use = await makeUse(source, null, ".svg"), initial = await makeVard();
    const saved = ok(await put(initial.id, initial.revision, [linked(use, "a.svg"), direct(source, "b.svg")])) as VardEditorDefinitionV2;
    await capable(client => client.query("UPDATE vard_item SET created_at='2026-01-01 01:02:03.123456+00',created_by='original:v2' WHERE vard_id=$1", [saved.id]));
    const current = await editor(saved.id), before = await snapshot(saved.id), desired = literal(current);
    [desired[0]!.outputPath, desired[1]!.outputPath] = [desired[1]!.outputPath, desired[0]!.outputPath];
    const swapped = ok(await put(saved.id, current.revision, desired)) as VardEditorDefinitionV2;
    const after = await snapshot(saved.id);
    assert.deepEqual(new Set(swapped.items.map(item => item.id)), new Set(current.items.map(item => item.id)));
    for (const old of before.items) {
      const row = after.items.find(item => item.id === old.id)!;
      assert.equal(row.creation, old.creation); assert.equal(row.created_by, old.created_by);
    }
    const denied = await patch(saved.id, swapped.revision, { name: "Must roll back", returnToSourceOnly: true });
    assert.equal(denied.statusCode, 409, denied.body); assert.equal(denied.json().code, "vard_definition_has_bindings");
    assert.deepEqual(await snapshot(saved.id), after);
    const noUse = literal(swapped).filter(item => item.binding.kind === "source");
    const cleared = ok(await put(saved.id, swapped.revision, noUse)) as VardEditorDefinitionV2;
    assert.equal(cleared.storedDefinitionSchema, 2);
    const downgraded = ok(await patch(saved.id, cleared.revision, { returnToSourceOnly: true })) as VardEditorDefinitionV2;
    assert.equal(downgraded.storedDefinitionSchema, 1);
    assert.ok((await snapshot(saved.id)).items.every(row => row.definition_schema === 1));
  });

  await t.test("first binding and old whole-list writer serialize in both guarded orders", async () => {
    const source = await makeSource(), use = await makeUse(source, null, ".svg");
    for (const bindingFirst of [true, false]) {
      const initial = await makeVard(), before = await snapshot(initial.id);
      const bind = () => put(initial.id, initial.revision, [linked(use, "linked.svg")]);
      const oldWrite = () => app.inject({ method: "PUT", url: `${base}/${initial.id}/items`, headers,
        payload: { items: [{ assetId: source.id, outputPath: "source.svg" }] } });
      const result = bindingFirst ? await queued(bind, oldWrite) : await queued(oldWrite, bind);
      assert.deepEqual(result.map(response => response.statusCode), [200, 409], result.map(response => response.body).join("\n"));
      const state = await editor(initial.id), rows = await snapshot(initial.id);
      assert.equal(state.storedDefinitionSchema, bindingFirst ? 2 : 1);
      assert.equal(rows.items.length, 1); assert.equal(rows.items[0].asset_use_id, bindingFirst ? use.id : null);
      assert.equal(rows.audit.length, before.audit.length + 1, "only one mutation commits");
      assert.equal(result[1].json().code, bindingFirst ? "vard_definition_upgrade_required" : "vard_revision_conflict");
    }
  });

  await t.test("public discovery rechecks privacy after authorization and private sources reveal no output diagnostics", async () => {
    const source = await makeSource(), use = await makeUse(source, { format: "png", w: 16 }), initial = await makeVard(true);
    const saved = ok(await put(initial.id, initial.revision, [linked(use, "wrong.svg")])) as VardEditorDefinitionV2;
    const anonymous = await app.inject({ url: `/v/${initial.id}` });
    assert.equal(anonymous.statusCode, 404); assert.deepEqual(anonymous.json(), { error: "Vard not found" });
    assert.equal(saved.items[0]!.resolved.downloadUrl, null); assert.ok(saved.items[0]!.resolved.availabilityError);
    ok(await app.inject({ method: "PATCH", url: `/api/workspaces/ws/assets/${source.id}/visibility`, headers, payload: { isPublic: true } }));
    const fixed = literal(await editor(initial.id)); fixed[0]!.outputPath = "linked.png";
    const publicDefinition = ok(await put(initial.id, saved.revision, fixed)) as VardEditorDefinitionV2;
    const publicManifest = ok(await app.inject({ url: `/v/${initial.id}` }));
    assert.equal(publicManifest.schema, 1); assert.ok(publicManifest.items[0].downloadUrl);
    const blocker = await admin.connect(); let pending: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
    try {
      await blocker.query("BEGIN"); await blocker.query("LOCK TABLE apikey IN ACCESS EXCLUSIVE MODE");
      pending = Promise.resolve(app.inject({ url: `/v/${initial.id}`, headers: readHeaders })); void pending.catch(() => {});
      await waitForRelationWait("apikey");
      await capable(client => client.query("UPDATE vard SET is_public=false WHERE id=$1", [initial.id]));
      await blocker.query("COMMIT");
      const raced = await pending;
      assert.equal(raced.statusCode, 404, raced.body); assert.deepEqual(raced.json(), { error: "Vard not found" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
    ok(await app.inject({ method: "PATCH", url: `/api/workspaces/ws/assets/${source.id}/visibility`, headers, payload: { isPublic: false } }));
    assert.equal((await app.inject({ url: publicManifest.items[0].downloadUrl })).statusCode, 401);
    assert.equal(publicDefinition.storedDefinitionSchema, 2);
  });

  await t.test("old SQL clients stay baseline1 and rejected cascades roll back the entire transaction", async () => {
    const source = await makeSource(), directSource = await makeSource(), use = await makeUse(source, null, ".svg"), initial = await makeVard(true);
    ok(await put(initial.id, initial.revision, [linked(use, "use.svg"), direct(directSource, "source.svg")]));
    const old = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const client = await old.connect();
      try {
        assert.notEqual((await client.query("SELECT current_setting('vardum.vard_definition_schema',true) AS cap")).rows[0].cap, "2");
        await client.query("BEGIN"); await client.query("SELECT set_config('app.workspace_id','ws',true)");
        assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [initial.id])).rowCount, 0);
        assert.equal((await client.query("SELECT * FROM vard_item WHERE vard_id=$1", [initial.id])).rowCount, 0);
        const auditId = randomUUID();
        await client.query("INSERT INTO audit_event(id,workspace_id,actor_type,actor_id,action,target_type,target_id,request_id) VALUES($1,'ws','api_key','old-client','fixture.rollback','asset',$2,'v2-rollback-fixture')", [auditId, directSource.id]);
        await assert.rejects(client.query("DELETE FROM asset WHERE id=$1", [directSource.id]),
          (error: any) => error.code === "23514" && error.constraint === "vard_definition_capability_guard");
        await client.query("ROLLBACK");
        assert.equal((await admin.query("SELECT * FROM audit_event WHERE id=$1", [auditId])).rowCount, 0);
        assert.equal((await admin.query("SELECT * FROM asset WHERE id=$1", [directSource.id])).rowCount, 1);
        assert.equal((await snapshot(initial.id)).items.length, 2);
        assert.notEqual((await client.query("SELECT current_setting('vardum.vard_definition_schema',true) AS cap")).rows[0].cap, "2");
      } finally { await client.query("ROLLBACK"); client.release(); }
      const { pool } = await import("../src/db/index.js");
      const clients = await Promise.all(Array.from({ length: Math.max(2, pool.totalCount) }, () => pool.connect()));
      try { for (const client of clients)
        assert.notEqual((await client.query("SELECT current_setting('vardum.vard_definition_schema',true) AS cap")).rows[0].cap, "2");
      } finally { clients.forEach(client => client.release()); }
      assert.equal((await editor(initial.id)).storedDefinitionSchema, 2, "the new API continues to see the guarded definition");
    } finally { await old.end(); }
  });

  await t.test("real CLI schema2 frozen pull restores captured use output after use/current changes and Vard deletion", async () => {
    const source = await makeSource(), use = await makeUse(source, { w: 24, h: 24, fit: "contain", format: "png", pad: 25 }), initial = await makeVard();
    const saved = ok(await put(initial.id, initial.revision, [linked(use, "images/linked.png")])) as VardEditorDefinitionV2;
    const requests: string[] = [];
    const bridge = createServer(async (request, response) => {
      const injected = await app.inject({ method: request.method as "GET", url: request.url!, headers: request.headers });
      requests.push(request.url!); response.statusCode = injected.statusCode;
      for (const [name, value] of Object.entries(injected.headers)) if (value !== undefined && name !== "transfer-encoding") response.setHeader(name, value);
      response.end(injected.rawPayload);
    });
    await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
    try {
      const address = bridge.address(); assert.ok(address && typeof address !== "string");
      const home = join(fixture.root, `v2-cli-home-${initial.id}`), project = join(fixture.root, `v2-cli-${initial.id}`);
      await mkdir(join(home, "vardum"), { recursive: true }); await mkdir(project);
      await writeFile(join(home, "vardum/version-check.json"), JSON.stringify({ latest: "0.0.0", at: Date.now() }));
      await writeFile(join(project, "vardum.json"), JSON.stringify({ schema: 1, server: `http://127.0.0.1:${address.port}`, workspace: "ws", vard: initial.id }));
      const cli = fixture.cliPath ?? fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
      const run = (...args: string[]) => execFile(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args, "--json"], {
        cwd: project, timeout: 25_000, maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, VARDUM_API_KEY: headers["x-api-key"]! },
      });
      assert.equal(JSON.parse((await run("pull")).stdout).changed, 1);
      const lock = await readFile(join(project, ".vardum.lock"), "utf8"), captured = await readFile(join(project, "images/linked.png"));
      const parsed = JSON.parse(lock), entry = parsed.items[saved.items[0]!.id];
      assert.equal(parsed.schema, 2); assert.equal(entry.checksum, digest(captured)); assert.notEqual(entry.checksum, digest(source.bytes));
      await editUse(use, { w: 40, h: 32, fit: "contain", format: "png", pad: 10 });
      const nextVersion = await addVersion(source, green); await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [nextVersion, source.id]);
      assert.notEqual((await manifest(initial.id)).items[0].fingerprint, entry.fingerprint);
      const current = await editor(initial.id);
      ok(await app.inject({ method: "DELETE", url: `${base}/${initial.id}/editor?definitionSchema=2&expectedRevision=${current.revision}`, headers }), 204);
      await rm(join(project, "images"), { recursive: true }); const start = requests.length;
      assert.equal(JSON.parse((await run("pull", "--frozen")).stdout).changed, 1);
      assert.deepEqual(await readFile(join(project, "images/linked.png")), captured);
      assert.equal(await readFile(join(project, ".vardum.lock"), "utf8"), lock);
      assert.ok(requests.slice(start).every(path => !path.endsWith("/manifest")), "frozen restoration never resolves the deleted live Vard");
    } finally { await new Promise<void>(resolve => bridge.close(() => resolve())); }
  });
}
