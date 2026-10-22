import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { VardEditorDefinitionV2, VardEditorItemInputV2, VardFolderRuleV2, VardItem, VardManifest, Transformation } from "@vardum/shared";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import sharp from "sharp";

type Source = { id: string; key: string; versionId: string; bytes: Buffer; mimeType: string; checksum: string; size: number };
type Use = { id: string; key: string; revision: number; displayName: string };
type ImportFile = { assetId: string; key: string; outputPath: string; checksum: string; mimeType: string; size: number };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const expectedUseId = (id: string, path: string) => `folder:use:${createHash("sha256").update(JSON.stringify([id, path])).digest("hex")}`;

/** Runs only in private-delivery's disposable PG cluster and real runtime API. */
export async function checkVardFolderUses(t: TestContext, fixture: {
  admin: Pool; app: FastifyInstance; objects: Map<string, Buffer>;
  keyHeaders: Record<string, Record<string, string>>; cookies: Record<string, string>;
  root: string; cliPath?: string;
}) {
  const { admin, app, objects, keyHeaders } = fixture;
  const headers = keyHeaders.write!, readHeaders = keyHeaders.read!;
  const prefix = `folder-uses-${randomUUID()}/`, base = "/api/workspaces/ws/vards";
  const vardIds: string[] = [], sourceIds: string[] = [], useIds: string[] = [], versionIds: string[] = [], objectKeys: string[] = [];
  const blue = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#0044ff"/></svg>');
  const green = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#00bb44"/></svg>');
  const png = await sharp({ create: { width: 16, height: 8, channels: 4, background: "#0044ff" } }).png().toBuffer();
  const recipe: Transformation = { w: 40, h: 32, fit: "contain", format: "png", bg: "#ffffff", pad: 25 };
  async function capable<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('vardum.vard_definition_schema','3',true)");
      const result = await operation(client); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  t.after(async () => {
    await capable(async (client) => {
      await client.query("DELETE FROM vard WHERE id=ANY($1::uuid[])", [vardIds]);
      await client.query("DELETE FROM asset_use WHERE id=ANY($1::uuid[])", [useIds]);
      await client.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [sourceIds]);
      for (const [table, ids] of [["vard", vardIds], ["asset_use", useIds], ["asset", sourceIds]] as const)
        assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=ANY($1::uuid[])`, [ids])).rows[0].n, 0);
    });
    for (const key of objectKeys) objects.delete(key);
    const ownedVersions = new Set(versionIds);
    for (const key of objects.keys())
      if (key.startsWith("derived/v1/") && ownedVersions.has(key.split("/")[2]!)) objects.delete(key);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM vard_item WHERE vard_id=ANY($1::uuid[])", [vardIds])).rows[0].n, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM asset_version WHERE id=ANY($1::uuid[])", [versionIds])).rows[0].n, 0);
  });
  function ok<T>(response: Awaited<ReturnType<typeof app.inject>>, status = 200): T {
    assert.equal(response.statusCode, status, response.body);
    return status === 204 ? undefined as T : response.json<T>();
  }
  const message = (response: Awaited<ReturnType<typeof app.inject>>) => {
    const value = response.json<{ message?: string; error?: string }>();
    return value.message ?? value.error ?? "";
  };
  const get = (id: string) => app.inject({ url: `${base}/${id}/editor?definitionSchema=2`, headers: readHeaders });
  const editor = async (id: string) => ok<VardEditorDefinitionV2>(await get(id));
  const patch = (id: string, expectedRevision: string, fields: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `${base}/${id}/editor`, headers, payload: { definitionSchema: 2, expectedRevision, ...fields } });
  const put = (id: string, expectedRevision: string, items: VardEditorItemInputV2[]) =>
    app.inject({ method: "PUT", url: `${base}/${id}/editor/items`, headers, payload: { definitionSchema: 2, expectedRevision, items } });
  const manifestResponse = (id: string) => app.inject({ url: `${base}/${id}/manifest`, headers: readHeaders });
  const manifest = async (id: string) => ok<VardManifest>(await manifestResponse(id));
  const anonymous = (id: string) => app.inject({ url: `/v/${id}` });
  const plan = (id: string, files: ImportFile[]) => app.inject({ method: "POST", url: `${base}/${id}/items/import-plan`, headers, payload: { files } });
  const apply = (id: string, files: Array<ImportFile & { versionId: string }>) => app.inject({ method: "POST", url: `${base}/${id}/items/import`, headers, payload: { files } });
  const direct = (source: Source, outputPath: string): VardEditorItemInputV2 => ({ id: null, outputPath,
    binding: { kind: "source", assetId: source.id, versionId: null, transformation: null, writable: false } });
  const linked = (use: Use, outputPath: string): VardEditorItemInputV2 => ({ id: null, outputPath, binding: { kind: "use", assetUseId: use.id } });
  const input = (source: Source, outputPath: string): ImportFile => ({ assetId: source.id, key: source.key,
    outputPath, checksum: source.checksum, mimeType: source.mimeType, size: source.size });
  async function makeVard(rules: VardFolderRuleV2[] = [], isPublic = false) {
    const value = ok<{ id: string }>(await app.inject({ method: "POST", url: base, headers,
      payload: { name: `Folder uses ${randomUUID()}`, isPublic } }), 201);
    vardIds.push(value.id);
    const initial = await editor(value.id);
    return rules.length ? ok<VardEditorDefinitionV2>(await patch(value.id, initial.revision, { folderRules: rules })) : initial;
  }
  async function addVersion(source: Pick<Source, "id">, bytes: Buffer, mimeType = "image/svg+xml", current = true) {
    const id = randomUUID(), storageKey = `${prefix}objects/${id}`;
    versionIds.push(id);
    objectKeys.push(storageKey); objects.set(storageKey, bytes);
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,width,height,created_by,updated_by) SELECT $1,'ws',$2,coalesce(max(number),0)+1,'ready',$3,$4,$5,$6,$7,16,8,'fixture','fixture' FROM asset_version WHERE asset_id=$2",
      [id, source.id, storageKey, mimeType === "image/png" ? "source.png" : "source.svg", mimeType, bytes.length, digest(bytes)]);
    if (current) await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [id, source.id]);
    return id;
  }
  async function makeSource(suffix = `canonical/${randomUUID()}.svg`, bytes = blue, mimeType = "image/svg+xml", isPublic = true): Promise<Source> {
    const id = randomUUID(), key = `${prefix}${suffix}`; sourceIds.push(id);
    await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) VALUES($1,'ws',$2,'Folder source',$3,'fixture','fixture')", [id, key, isPublic]);
    const versionId = await addVersion({ id }, bytes, mimeType);
    return { id, key, versionId, bytes, mimeType, checksum: digest(bytes), size: bytes.length };
  }
  async function makeUse(source: Source, key: string, transformation: Transformation | null): Promise<Use> {
    const value = ok<{ id: string; revision: number }>(await app.inject({ method: "POST", url: "/api/workspaces/ws/asset-uses", headers,
      payload: { sourceAssetId: source.id, key: `${prefix}${key}`, displayName: "Folder linked use", transformation } }), 201);
    useIds.push(value.id); return { ...value, key: `${prefix}${key}`, displayName: "Folder linked use" };
  }
  async function editUse(use: Use, transformation: Transformation | null) {
    const value = ok<{ revision: number }>(await app.inject({ method: "PATCH", url: `/api/workspaces/ws/asset-uses/${use.id}`, headers,
      payload: { expectedRevision: use.revision, displayName: use.displayName, transformation } }));
    use.revision = value.revision;
  }
  async function setup() {
    const group = randomUUID(), folder = `${group}/members/`;
    const source = await makeSource(`${group}/canonical.svg`);
    const original = await makeSource(`${folder}original.png`, png, "image/png");
    const first = await makeUse(source, `${folder}first`, null);
    const second = await makeUse(source, `${folder}second`, recipe);
    const rule = { sourcePrefix: `${prefix}${folder}`, outputPrefix: "images/", includeUses: true };
    return { source, original, first, second, rule };
  }
  async function snapshot(id: string) {
    const targets = [id, ...sourceIds, ...useIds];
    return {
      vard: (await admin.query("SELECT to_jsonb(v) AS row FROM vard v WHERE id=$1", [id])).rows,
      items: (await admin.query("SELECT to_jsonb(i) AS row FROM vard_item i WHERE vard_id=$1 ORDER BY id", [id])).rows,
      sources: (await admin.query("SELECT to_jsonb(a) AS row FROM asset a WHERE id=ANY($1::uuid[]) ORDER BY id", [sourceIds])).rows,
      versions: (await admin.query("SELECT to_jsonb(v) AS row FROM asset_version v WHERE asset_id=ANY($1::uuid[]) ORDER BY id", [sourceIds])).rows,
      uses: (await admin.query("SELECT to_jsonb(u) AS row FROM asset_use u WHERE id=ANY($1::uuid[]) ORDER BY id", [useIds])).rows,
      audit: (await admin.query("SELECT to_jsonb(a) AS row FROM audit_event a WHERE target_id=ANY($1::text[]) ORDER BY id", [targets])).rows,
      queue: (await admin.query("SELECT to_jsonb(j) AS row FROM pgboss.job j WHERE data->>'assetId'=ANY($1::text[]) ORDER BY id", [sourceIds])).rows,
    };
  }
  async function decode(url: string) {
    const response = await app.inject({ url, headers: readHeaders }); assert.equal(response.statusCode, 200, response.body);
    return { bytes: response.rawPayload, metadata: await sharp(response.rawPayload).metadata(), pixels: await sharp(response.rawPayload).ensureAlpha().raw().toBuffer() };
  }
  function blueBounds(pixels: Buffer, width: number, height: number) {
    const points: Array<[number, number]> = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (pixels[p]! < 40 && pixels[p + 2]! > 200) points.push([x, y]);
    }
    assert.ok(points.length);
    return [Math.min(...points.map(p => p[0])), Math.max(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[1]))];
  }
  const output = (value: VardManifest, path: string): VardItem => {
    const item = value.items.find(item => item.outputPath === path); assert.ok(item, path); return item;
  };

  await t.test("false and absent rules retain originals-only membership and literal legacy input remains strict", async () => {
    const f = await setup(), initial = await makeVard();
    for (const includeUses of [undefined, false]) {
      const rule = { sourcePrefix: f.rule.sourcePrefix, outputPrefix: f.rule.outputPrefix, ...(includeUses === undefined ? {} : { includeUses }) };
      const saved = ok<VardEditorDefinitionV2>(await patch(initial.id, (await editor(initial.id)).revision, { folderRules: [rule] }));
      assert.equal(saved.storedDefinitionSchema, 1); assert.equal("includeUses" in saved.folderRules[0]!, false);
      const value = await manifest(saved.id); assert.deepEqual(value.items.map(item => item.assetId), [f.original.id]);
      assert.equal(value.items[0]!.outputPath, "images/original.png");
    }
    const before = await snapshot(initial.id);
    for (const request of [
      { method: "POST" as const, url: base, payload: { name: "Invalid legacy opt-in", folderRules: [f.rule] } },
      { method: "PATCH" as const, url: `${base}/${initial.id}`, payload: { folderRules: [f.rule] } },
      { method: "PATCH" as const, url: `${base}/${initial.id}/editor`, payload: { expectedRevision: "v1:" + "0".repeat(64), folderRules: [f.rule] } },
    ]) assert.equal((await app.inject({ ...request, headers })).statusCode, 400);
    assert.deepEqual(await snapshot(initial.id), before);
  });

  await t.test("explicit true promotes3 and resolves own use keys while retaining canonical source identity", async () => {
    const f = await setup(), saved = await makeVard([f.rule]);
    assert.equal(saved.definitionSchema, 2); assert.equal(saved.storedDefinitionSchema, 3); assert.deepEqual(saved.items, []);
    assert.equal(f.source.key.startsWith(f.rule.sourcePrefix), false);
    const value = await manifest(saved.id); assert.equal(value.schema, 1); assert.equal(value.items.length, 3);
    for (const [use, path, transformation] of [[f.first, "images/first.svg", null], [f.second, "images/second.png", recipe]] as const) {
      const item = output(value, path); assert.equal(item.id, expectedUseId(use.id, path));
      assert.equal(item.assetId, f.source.id); assert.equal(item.key, f.source.key); assert.deepEqual(item.transformation, transformation);
      assert.equal(item.pinned, false); assert.equal(item.writable, false); assert.match(item.downloadUrl!, new RegExp(`/__v/${f.source.versionId}/`));
      assert.equal(JSON.stringify(item).includes(use.id), false, "consumer identity does not reveal the internal use ID");
    }
    assert.equal(output(value, "images/original.png").assetId, f.original.id);
  });

  await t.test("live 40x32 to 64x48 settings change decoded safe area without changing literal revision or generated IDs", async () => {
    const f = await setup(), saved = await makeVard([f.rule]); const before = await manifest(saved.id);
    const first = output(before, "images/second.png"), decoded = await decode(first.downloadUrl!);
    assert.deepEqual([decoded.metadata.width, decoded.metadata.height], [40, 32]);
    assert.deepEqual(blueBounds(decoded.pixels, 40, 32), [8, 31, 10, 21]);
    const literal = await snapshot(saved.id);
    await editUse(f.second, { ...recipe, w: 64, h: 48, pad: 12.5 });
    const changed = output(await manifest(saved.id), "images/second.png"), next = await decode(changed.downloadUrl!);
    assert.deepEqual([next.metadata.width, next.metadata.height], [64, 48]);
    assert.deepEqual(blueBounds(next.pixels, 64, 48), [6, 57, 11, 36]);
    assert.equal(changed.id, first.id); assert.notEqual(changed.fingerprint, first.fingerprint); assert.notDeepEqual(next.bytes, decoded.bytes);
    assert.deepEqual((await decode(first.downloadUrl!)).bytes, decoded.bytes);
    assert.equal((await editor(saved.id)).revision, saved.revision);
    const after = await snapshot(saved.id); assert.deepEqual(after.vard, literal.vard); assert.deepEqual(after.items, literal.items);
  });

  await t.test("current source changes and ready restore keep generated IDs and literal revision stable", async () => {
    const f = await setup(), saved = await makeVard([f.rule]); const before = await manifest(saved.id);
    const nextId = await addVersion(f.source, green);
    const changed = await manifest(saved.id);
    for (const item of changed.items.filter(item => item.assetId === f.source.id)) {
      assert.equal(item.versionId, nextId); assert.equal(item.id, output(before, item.outputPath).id);
    }
    assert.equal((await editor(saved.id)).revision, saved.revision);
    ok(await app.inject({ method: "POST", url: `/api/workspaces/ws/assets/${f.source.id}/versions/${f.source.versionId}/restore`, headers }));
    assert.ok((await manifest(saved.id)).items.filter(item => item.assetId === f.source.id).every(item => item.versionId === f.source.versionId));
    assert.equal((await editor(saved.id)).revision, saved.revision);
  });

  await t.test("saved format changes extensionless membership and deleted/unready uses never fall back", async () => {
    const f = await setup(), saved = await makeVard([f.rule]); const before = output(await manifest(saved.id), "images/second.png");
    await editUse(f.second, { ...recipe, format: "webp" });
    const reformatted = await manifest(saved.id); assert.equal(reformatted.items.some(item => item.outputPath === before.outputPath), false);
    assert.notEqual(output(reformatted, "images/second.webp").id, before.id);
    ok(await app.inject({ method: "DELETE", url: `/api/workspaces/ws/asset-uses/${f.second.id}?expectedRevision=${f.second.revision}`, headers }), 204);
    assert.equal((await manifest(saved.id)).items.some(item => item.outputPath === "images/second.webp"), false);
    const original = output(await manifest(saved.id), "images/first.svg");
    await admin.query("UPDATE asset SET current_version_id=NULL WHERE id=$1", [f.source.id]);
    const unavailable = output(await manifest(saved.id), "images/first.svg"); assert.equal(unavailable.id, original.id);
    for (const value of [unavailable.versionId, unavailable.sourceChecksum, unavailable.fingerprint, unavailable.downloadUrl]) assert.equal(value, null);
    await addVersion(f.source, png, "image/png");
    const mismatched = output(await manifest(saved.id), "images/first.svg"); assert.equal(mismatched.id, original.id); assert.equal(mismatched.downloadUrl, null);
    assert.equal((await editor(saved.id)).revision, saved.revision); assert.equal((await editor(saved.id)).storedDefinitionSchema, 3);
  });

  await t.test("stored3 legacy gates and stale PATCH PUT DELETE refuse atomically", async () => {
    const f = await setup(), initial = await makeVard(), saved = ok<VardEditorDefinitionV2>(await patch(initial.id, initial.revision, { folderRules: [f.rule] }));
    const before = await snapshot(saved.id);
    for (const request of [
      { method: "GET" as const, url: `${base}/${saved.id}` },
      { method: "GET" as const, url: `${base}/${saved.id}/editor` },
      { method: "PATCH" as const, url: `${base}/${saved.id}`, payload: { name: "Legacy refusal" } },
      { method: "PUT" as const, url: `${base}/${saved.id}/items`, payload: { items: [] } },
      { method: "DELETE" as const, url: `${base}/${saved.id}` },
    ]) { const response = await app.inject({ ...request, headers }); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, "vard_definition_upgrade_required"); }
    for (const response of [await patch(saved.id, initial.revision, { name: "Stale" }), await put(saved.id, initial.revision, []),
      await app.inject({ method: "DELETE", url: `${base}/${saved.id}/editor?definitionSchema=2&expectedRevision=${initial.revision}`, headers })]) {
      assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, "vard_revision_conflict");
    }
    assert.deepEqual(await snapshot(saved.id), before);
  });

  await t.test("sticky3 propagates to inserts and historical false2 downgrade restores the legacy subset", async () => {
    const f = await setup(), initial = await makeVard([f.rule]);
    const withItems = ok<VardEditorDefinitionV2>(await put(initial.id, initial.revision, [direct(f.source, "manual.svg"), linked(f.first, "manual-use.svg")]));
    assert.ok((await admin.query("SELECT definition_schema FROM vard_item WHERE vard_id=$1", [initial.id])).rows.every(row => row.definition_schema === 3));
    const before = await snapshot(initial.id); assert.equal((await patch(initial.id, withItems.revision, { returnToSourceOnly: true, name: "Unsafe" })).statusCode, 409);
    assert.deepEqual(await snapshot(initial.id), before);
    const off = ok<VardEditorDefinitionV2>(await patch(initial.id, withItems.revision, { folderRules: [{ ...f.rule, includeUses: false }] })); assert.equal(off.storedDefinitionSchema, 3);
    const cleared = ok<VardEditorDefinitionV2>(await put(initial.id, off.revision, [])); assert.equal(cleared.storedDefinitionSchema, 3);
    assert.equal(ok<VardEditorDefinitionV2>(await patch(initial.id, cleared.revision, { returnToSourceOnly: true })).storedDefinitionSchema, 1);
    const historical = await makeVard(); const falseRule = { sourcePrefix: `${prefix}historical/`, outputPrefix: "legacy/", includeUses: false };
    await capable(client => client.query("UPDATE vard SET folder_rules=$2 WHERE id=$1", [historical.id, JSON.stringify([falseRule])]));
    const old = await editor(historical.id); assert.equal(old.folderRules[0]!.includeUses, false);
    const bound = ok<VardEditorDefinitionV2>(await put(old.id, old.revision, [linked(f.first, "historical.svg")])); assert.equal(bound.storedDefinitionSchema, 2);
    const removed = ok<VardEditorDefinitionV2>(await put(old.id, bound.revision, [])); assert.equal(removed.folderRules[0]!.includeUses, false);
    const returned = ok<VardEditorDefinitionV2>(await patch(old.id, removed.revision, { returnToSourceOnly: true }));
    assert.equal(returned.storedDefinitionSchema, 1); assert.equal("includeUses" in returned.folderRules[0]!, false);
    const legacy = ok<{ revision: string }>(await app.inject({ url: `${base}/${old.id}/editor`, headers }));
    ok(await app.inject({ method: "PATCH", url: `${base}/${old.id}/editor`, headers,
      payload: { expectedRevision: legacy.revision, folderRules: returned.folderRules } }));
  });

  await t.test("generated use import refuses before wrong source checksum/version with direct-source and new-opt-in controls", async () => {
    const f = await setup(), saved = await makeVard([f.rule]);
    for (const path of ["images/first.svg", "images/second.png"]) {
      const bad = { ...input(f.source, path), checksum: "f".repeat(64) }, before = await snapshot(saved.id);
      for (const response of [await plan(saved.id, [bad]), await apply(saved.id, [{ ...bad, versionId: randomUUID() }])]) {
        assert.equal(response.statusCode, 409, response.body); assert.match(message(response), /Linked uses are read-only/);
      }
      assert.deepEqual(await snapshot(saved.id), before);
    }
    const file = input(f.source, "direct-source.svg"); ok(await plan(saved.id, [file]));
    const accepted = ok<{ added: number }>(await apply(saved.id, [{ ...file, versionId: f.source.versionId }])); assert.equal(accepted.added, 1);
    assert.equal((await admin.query("SELECT definition_schema FROM vard_item WHERE vard_id=$1", [saved.id])).rows[0].definition_schema, 3);
    const beforeOptIn = await makeVard(), destined = input(f.source, "images/first.svg"); ok(await plan(beforeOptIn.id, [destined]));
    ok(await patch(beforeOptIn.id, beforeOptIn.revision, { folderRules: [f.rule] }));
    const before = await snapshot(beforeOptIn.id); const refused = await apply(beforeOptIn.id, [{ ...destined, versionId: f.source.versionId }]);
    assert.equal(refused.statusCode, 409, refused.body); assert.match(message(refused), /Linked uses are read-only/); assert.deepEqual(await snapshot(beforeOptIn.id), before);
  });

  await t.test("actual manifest and import share case NFC file-directory and all binding collision pairs", async () => {
    const f = await setup();
    const cases: Array<{ rules: VardFolderRuleV2[]; manual: VardEditorItemInputV2[] }> = [
      { rules: [f.rule], manual: [direct(f.source, "images/first.svg")] },
      { rules: [{ ...f.rule, includeUses: false }], manual: [direct(f.source, "images/original.png")] },
      { rules: [f.rule], manual: [direct(f.source, "IMAGES/first.svg")] },
      { rules: [f.rule], manual: [direct(f.source, "images")] },
      { rules: [{ ...f.rule, outputPrefix: "café/" }, { ...f.rule, outputPrefix: "cafe\u0301/" }], manual: [] },
      { rules: [f.rule, f.rule], manual: [] },
    ];
    const sameNameSource = await makeSource(`${randomUUID()}/first.svg`);
    cases.push({ rules: [f.rule, { sourcePrefix: sameNameSource.key.slice(0, sameNameSource.key.lastIndexOf("/") + 1), outputPrefix: "images/" }], manual: [] });
    const otherUse = await makeUse(f.source, `${randomUUID()}/first`, null);
    cases.push({ rules: [f.rule, { sourcePrefix: otherUse.key.slice(0, otherUse.key.lastIndexOf("/") + 1), outputPrefix: "images/", includeUses: true }], manual: [] });
    for (const value of cases) {
      const initial = await makeVard(), manual = value.manual.length ? ok<VardEditorDefinitionV2>(await put(initial.id, initial.revision, value.manual)) : initial;
      ok(await patch(initial.id, manual.revision, { folderRules: value.rules }));
      const response = await manifestResponse(initial.id); assert.equal(response.statusCode, 409, response.body); assert.match(message(response), /collide|overlap/);
      const refusal = await plan(initial.id, [input(f.source, "unrelated.svg")]); assert.equal(refusal.statusCode, 409, refusal.body);
      assert.equal(message(refusal), message(response));
    }
  });

  let bulk: { sources: Source[]; sourcePrefix: string; usePrefix: string; publicSource: Source; privateSource: Source; privateUseId: string; uses: Array<{ id: string; key: string; source: string }> } | undefined;
  async function bulkMembers() {
    if (bulk) return bulk;
    const sourcePrefix = `${prefix}bulk-source/`, usePrefix = `${prefix}bulk-use/`;
    const rows = Array.from({ length: 1001 }, (_, index) => ({ id: randomUUID(), version: randomUUID(), key: `${sourcePrefix}${String(index).padStart(4, "0")}.svg`, storage: `${prefix}bulk-objects/${index}` }));
    sourceIds.push(...rows.map(row => row.id)); versionIds.push(...rows.map(row => row.version)); objectKeys.push(...rows.map(row => row.storage)); for (const row of rows) objects.set(row.storage, blue);
    await capable(async client => {
      await client.query("INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) SELECT id::uuid,'ws',key,'Bulk folder source',true,'fixture','fixture' FROM jsonb_to_recordset($1) AS r(id text,key text)", [JSON.stringify(rows)]);
      await client.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,width,height,created_by,updated_by) SELECT version::uuid,'ws',id::uuid,1,'ready',storage,'source.svg','image/svg+xml',$2,$3,16,8,'fixture','fixture' FROM jsonb_to_recordset($1) AS r(id text,version text,storage text)", [JSON.stringify(rows), blue.length, digest(blue)]);
      await client.query("UPDATE asset a SET current_version_id=r.version::uuid FROM jsonb_to_recordset($1) AS r(id text,version text) WHERE a.id=r.id::uuid", [JSON.stringify(rows)]);
    });
    const publicSource = await makeSource("bulk-canonical/public.svg"), privateSource = await makeSource("bulk-canonical/private.svg", blue, "image/svg+xml", false);
    assert.equal(publicSource.key.startsWith(sourcePrefix) || publicSource.key.startsWith(usePrefix), false);
    assert.equal(privateSource.key.startsWith(sourcePrefix) || privateSource.key.startsWith(usePrefix), false);
    const uses = Array.from({ length: 1002 }, (_, index) => ({ id: randomUUID(), key: `${usePrefix}${String(index).padStart(4, "0")}.svg`, source: index === 1001 ? privateSource.id : publicSource.id }));
    useIds.push(...uses.map(row => row.id));
    await admin.query("INSERT INTO asset_use(id,workspace_id,source_asset_id,key,display_name,transformation,output_mime_type,created_by,updated_by) SELECT id::uuid,'ws',source::uuid,key,'Bulk folder use',NULL,'image/svg+xml','fixture','fixture' FROM jsonb_to_recordset($1) AS r(id text,source text,key text)", [JSON.stringify(uses)]);
    bulk = { sources: rows.map(row => ({ id: row.id, key: row.key, versionId: row.version, bytes: blue, mimeType: "image/svg+xml", checksum: digest(blue), size: blue.length })), sourcePrefix, usePrefix, publicSource, privateSource, privateUseId: uses[1001]!.id, uses };
    return bulk;
  }

  await t.test("actual 1000 and 1001 source/use unions and one-use 64-rule fan-out never truncate", async () => {
    // API admission is intentionally capped at1000 uses; create this control
    // before loading the larger raw/migrated-row fail-closed inventory.
    const fanoutSource = await makeSource(), fanoutUse = await makeUse(fanoutSource, `${randomUUID()}/card`, null);
    const f = await bulkMembers(); const saved = await makeVard([{ sourcePrefix: f.sourcePrefix, outputPrefix: "bulk/" }]);
    await admin.query("UPDATE asset SET current_version_id=NULL WHERE id=$1", [f.sources[1000]!.id]);
    assert.equal((await manifest(saved.id)).items.length, 1000);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [f.sources[1000]!.versionId, f.sources[1000]!.id]);
    const overflow = await manifestResponse(saved.id); assert.equal(overflow.statusCode, 409, overflow.body); assert.match(message(overflow), /more than 1000/);
    const withheld = f.uses.slice(1000);
    await admin.query("DELETE FROM asset_use WHERE id=ANY($1::uuid[])", [withheld.map(row => row.id)]);
    const useVard = await makeVard([{ sourcePrefix: f.usePrefix, outputPrefix: "use-limit/", includeUses: true }]);
    assert.equal((await manifest(useVard.id)).items.length, 1000);
    for (const row of withheld) {
      await admin.query("INSERT INTO asset_use(id,workspace_id,source_asset_id,key,display_name,transformation,output_mime_type,created_by,updated_by) VALUES($1,'ws',$2,$3,'Bulk folder use',NULL,'image/svg+xml','fixture','fixture')", [row.id, row.source, row.key]);
      const response = await manifestResponse(useVard.id); assert.equal(response.statusCode, 409, response.body); assert.match(message(response), /more than 1000/);
    }
    const use = fanoutUse;
    const rules = Array.from({ length: 64 }, (_, index) => ({ sourcePrefix: use.key.slice(0, use.key.lastIndexOf("/") + 1), outputPrefix: `fanout-${index}/`, includeUses: true }));
    const fanout = await makeVard(rules); const manual = Array.from({ length: 936 }, (_, index) => direct(f.publicSource, `manual/${index}.svg`));
    let state = ok<VardEditorDefinitionV2>(await put(fanout.id, fanout.revision, manual)); assert.equal((await manifest(state.id)).items.length, 1000);
    state = ok<VardEditorDefinitionV2>(await put(state.id, state.revision, [...state.items.map(({ id, outputPath, binding }) => ({ id, outputPath, binding })), direct(f.publicSource, "manual/extra.svg")]));
    assert.equal((await manifestResponse(state.id)).statusCode, 409);
  });

  await t.test("private canonical source behind use rank 1002 wins over source errors and unavailable details", async (privacyTest) => {
    const f = await bulkMembers();
    privacyTest.after(async () => {
      // Do not let intentionally oversized historical rows mask later API controls.
      await admin.query("DELETE FROM asset_use WHERE id=ANY($1::uuid[])", [f.uses.map(row => row.id)]);
    });
    const rank = (await admin.query("SELECT position FROM (SELECT id,row_number() OVER(ORDER BY key,id) AS position FROM asset_use WHERE workspace_id='ws' AND starts_with(key,$1)) r WHERE id=$2", [f.usePrefix, f.privateUseId])).rows[0].position;
    assert.equal(Number(rank), 1002);
    const window = (await admin.query("SELECT bool_or(not a.is_public) OVER() AS hidden FROM asset_use u JOIN asset a ON a.workspace_id=u.workspace_id AND a.id=u.source_asset_id WHERE u.workspace_id='ws' AND starts_with(u.key,$1) ORDER BY u.key,u.id LIMIT 1001", [f.usePrefix])).rows;
    assert.equal(window.length, 1001); assert.ok(window.every(row => row.hidden === true));
    const rules = [{ sourcePrefix: f.sourcePrefix, outputPrefix: "sources/" }, { sourcePrefix: f.usePrefix, outputPrefix: "uses/", includeUses: true }];
    const saved = await makeVard(rules, true);
    const allPublic = async () => { await admin.query("UPDATE asset SET is_public=true WHERE id=$1", [f.privateSource.id]);
      const response = await anonymous(saved.id); assert.equal(response.statusCode, 409, response.body); assert.match(message(response), /more than 1000/);
      await admin.query("UPDATE asset SET is_public=false WHERE id=$1", [f.privateSource.id]); };
    await allPublic();
    for (const mode of ["overflow", "collision", "unready"] as const) {
      if (mode === "collision") {
        const state = await editor(saved.id); ok(await put(saved.id, state.revision, [direct(f.publicSource, "sources/0000.svg")]));
      }
      if (mode === "unready") await admin.query("UPDATE asset SET current_version_id=NULL WHERE id=$1", [f.privateSource.id]);
      const denied = await anonymous(saved.id); assert.equal(denied.statusCode, 404, denied.body); assert.deepEqual(denied.json(), { error: "Vard not found" });
      const authenticated = await manifestResponse(saved.id); assert.equal(authenticated.statusCode, 409, authenticated.body); assert.match(message(authenticated), /more than 1000/);
    }
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [f.privateSource.versionId, f.privateSource.id]);
    await allPublic();
  });

  async function whileUseReadBlocked<T>(capture: () => Promise<T>, mutate: (client: PoolClient) => Promise<unknown>): Promise<T> {
    const blocker = await admin.connect(); let pending: Promise<T> | undefined;
    try {
      await blocker.query("BEGIN"); await blocker.query("LOCK TABLE asset_use IN ACCESS EXCLUSIVE MODE");
      pending = Promise.resolve().then(capture); void pending.catch(() => {});
      const deadline = Date.now() + 5_000; let observed = false;
      while (Date.now() < deadline) {
        observed = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.relation='asset_use'::regclass AND NOT l.granted AND a.usename='varda_app' AND a.xact_start IS NOT NULL AND a.wait_event_type='Lock' AND a.query LIKE '%bool_or%') AS waiting")).rows[0].waiting;
        if (observed) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(observed, true, "capture reached its use-membership SELECT after RR transaction setup");
      await mutate(blocker); await blocker.query("COMMIT"); return await pending;
    } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
  }

  await t.test("real RR lock barriers capture whole old use/source/privacy state and later member deletion", async () => {
    const f = await setup(), saved = await makeVard([f.rule], true), before = ok<VardManifest>(await anonymous(saved.id));
    const nextVersion = await addVersion(f.source, green, "image/svg+xml", false);
    const captured = await whileUseReadBlocked(() => anonymous(saved.id), async client => {
      await client.query("UPDATE asset_use SET transformation=$2,revision=revision+1 WHERE id=$1", [f.second.id, JSON.stringify({ ...recipe, w: 64, h: 48, pad: 12.5 })]);
      await client.query("UPDATE asset SET current_version_id=$2,is_public=false WHERE id=$1", [f.source.id, nextVersion]);
    });
    assert.deepEqual(ok<VardManifest>(captured), before, "privacy, recipe and current version are from the old snapshot together");
    assert.equal((await anonymous(saved.id)).statusCode, 404);
    const fresh = await manifest(saved.id); assert.equal(output(fresh, "images/second.png").versionId, nextVersion); assert.equal(output(fresh, "images/second.png").transformation!.w, 64);
    const withMember = await manifest(saved.id);
    const oldMember = await whileUseReadBlocked(() => manifest(saved.id), client => client.query("DELETE FROM asset_use WHERE id=$1", [f.second.id]));
    assert.deepEqual(oldMember, withMember); assert.equal((await manifest(saved.id)).items.some(item => item.outputPath === "images/second.png"), false);
    assert.equal((await editor(saved.id)).revision, saved.revision);
  });

  await t.test("selected-target capture uses the real runtime snapshot and refuses unrelated private generated URLs", async () => {
    const { inWorkspaceSnapshot } = await import("../src/db/tenant.js");
    const { buildVardPayloadInTransaction } = await import("../src/vard-payload.js");
    const f = await setup(), saved = await makeVard([f.rule], true);
    const selected = { assetId: f.original.id, outputPath: "images/original.png" };
    const captured = await inWorkspaceSnapshot("ws", tx => buildVardPayloadInTransaction(tx, "ws", saved.id, { anonymous: true, requirePublic: true, selectedTargets: [selected], includeBindingIdentity: true }));
    assert.equal(captured!.items.length, 1); assert.equal(captured!.items[0]!.assetId, f.original.id);
    await admin.query("UPDATE asset SET is_public=false,current_version_id=NULL WHERE id=$1", [f.source.id]);
    const denied = await inWorkspaceSnapshot("ws", tx => buildVardPayloadInTransaction(tx, "ws", saved.id, { anonymous: true, requirePublic: true, selectedTargets: [selected], includeBindingIdentity: true }));
    assert.equal(denied, null, "whole matching use privacy precedes selected-only version/URL hydration");
  });

  await t.test("actual serving pool keeps baseline1 across local3 helpers commit rollback reuse and reconnect", async () => {
    const { pool } = await import("../src/db/index.js");
    const { inWorkspace, inWorkspaceSnapshot } = await import("../src/db/tenant.js");
    const { sql } = await import("drizzle-orm");
    type State = { pid: number; role: string; cap: string | null; read_only: string; isolation: string };
    const statement = "SELECT pg_backend_pid() AS pid,current_user AS role,current_setting('vardum.vard_definition_schema',true) AS cap,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation";
    const held = new Set<PoolClient>();
    const acquire = async () => { const client = await pool.connect(); held.add(client); return client; };
    const release = (client: PoolClient, destroy = false) => { held.delete(client); client.release(destroy); };
    const state = async (client: PoolClient) => (await client.query<State>(statement)).rows[0]!;
    const baseline = async (client: PoolClient) => {
      const value = await state(client);
      assert.equal(value.role, "varda_app");
      assert.equal(value.cap === null || value.cap === "" ? "1" : value.cap, "1", "physical API client must have effective baseline1, never2/3");
      assert.equal(value.read_only, "off");
      return value;
    };
    try {
      const initial = await Promise.all(Array.from({ length: 3 }, acquire));
      const initialStates = await Promise.all(initial.map(baseline));
      const originalPids = initialStates.map(value => value.pid).sort((a, b) => a - b);
      assert.equal(new Set(originalPids).size, 3, "three simultaneously held runtime clients are distinct physical backends");
      // Park any other idle API clients so every helper must reuse the one
      // deliberately released backend, without relying on pool idle ordering.
      while (pool.idleCount > 0) await acquire();
      let active = initial[2]!;
      for (const mode of ["commit", "snapshot", "rollback", "sql-error"] as const) {
        const releasedPid = (await baseline(active)).pid;
        release(active);
        const helper = mode === "snapshot" ? inWorkspaceSnapshot : inWorkspace;
        const sentinel = new Error("folder fixture callback rollback");
        const operation = helper("ws", async tx => {
          const value = (await tx.execute(sql.raw(statement))).rows[0] as State;
          assert.equal(value.pid, releasedPid);
          assert.equal(value.role, "varda_app"); assert.equal(value.cap, "3");
          assert.equal(value.read_only, mode === "snapshot" ? "on" : "off");
          assert.equal(value.isolation, mode === "snapshot" ? "repeatable read" : "read committed");
          if (mode === "rollback") throw sentinel;
          if (mode === "sql-error") await tx.execute(sql`SELECT 1 / 0`);
          return value;
        });
        if (mode === "rollback") await assert.rejects(operation, error => error === sentinel);
        else if (mode === "sql-error") await assert.rejects(operation, error => {
          const failure = error as { code?: string; cause?: { code?: string } };
          return failure.code === "22012" || failure.cause?.code === "22012";
        });
        else await operation;
        active = await acquire();
        assert.equal((await baseline(active)).pid, releasedPid, `${mode} returns the same physical client to baseline1`);
      }
      for (const client of [initial[0]!, initial[1]!, active]) release(client);
      const reused = await Promise.all(Array.from({ length: 3 }, acquire));
      const reusedStates = await Promise.all(reused.map(baseline));
      assert.deepEqual(reusedStates.map(value => value.pid).sort((a, b) => a - b), originalPids);
      const retired = reusedStates[0]!.pid;
      release(reused[0]!, true);
      // All other existing API backends remain held, forcing a new connection.
      const reconnected = await acquire(), fresh = await baseline(reconnected);
      assert.notEqual(fresh.pid, retired);
      assert.equal(originalPids.includes(fresh.pid), false, "reconnect establishes a fresh physical runtime backend");
    } finally {
      for (const client of held) client.release();
      held.clear();
    }
  });
}
