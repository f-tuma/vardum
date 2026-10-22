import assert from "node:assert/strict";
import { mutateLegacyVersion } from "./legacy-version.fixture.js";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

type EditorItem = {
  id: string | null; assetId: string; versionId: string | null;
  outputPath: string; transformation: Record<string, unknown> | null; writable: boolean;
};
type ReadyFile = { assetId: string; versionId: string; key: string; outputPath: string;
  checksum: string; mimeType: string; size: number };
type Definition = { id: string; name: string; isPublic: boolean; revision: string;
  folderRules: { sourcePrefix: string; outputPrefix: string }[];
  items: (EditorItem & { pinnedVersionId: string | null; key: string; downloadUrl: string | null })[] };

// Runs in private-delivery's disposable PostgreSQL with its production RLS role.
export async function checkVardEditor(t: TestContext, fixture: {
  admin: Pool; app: FastifyInstance; objects: Map<string, Buffer>;
  keyHeaders: Record<string, Record<string, string>>; cookies: Record<string, string>;
  setCopyHook: (hook: (key: string) => Promise<boolean>) => void;
}) {
  const { admin, app, objects, keyHeaders, cookies } = fixture;
  const prefix = `editor-${randomUUID()}/`;
  const vardIds: string[] = [], assetIds: string[] = [], keyIds: string[] = [], objectKeys: string[] = [];
  const headers = keyHeaders.write!;
  const base = "/api/workspaces/ws/vards";
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8"/></svg>');
  const checksum = createHash("sha256").update(bytes).digest("hex");
  t.after(async () => {
    fixture.setCopyHook(async () => false);
    await admin.query("DELETE FROM vard WHERE id=ANY($1::uuid[])", [vardIds]);
    await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [assetIds]);
    await admin.query("DELETE FROM apikey WHERE id=ANY($1::text[])", [keyIds]);
    for (const key of objectKeys) objects.delete(key);
  });
  function ok(response: Awaited<ReturnType<typeof app.inject>>, status = 200) {
    assert.equal(response.statusCode, status, response.body);
    return status === 204 ? undefined : response.json();
  }
  const get = (id: string, principal = keyHeaders.read!, workspaceId = "ws") =>
    app.inject({ url: `/api/workspaces/${workspaceId}/vards/${id}/editor`, headers: principal });
  const editor = async (id: string) => ok(await get(id)) as Definition;
  const put = (id: string, expectedRevision: string, items: EditorItem[], principal = headers) =>
    app.inject({ method: "PUT", url: `${base}/${id}/editor/items`, headers: principal, payload: { expectedRevision, items } });
  const patch = (id: string, expectedRevision: string, fields: Record<string, unknown>, principal = headers) =>
    app.inject({ method: "PATCH", url: `${base}/${id}/editor`, headers: principal, payload: { expectedRevision, ...fields } });
  const remove = (id: string, expectedRevision: string, principal = headers) =>
    app.inject({ method: "DELETE", url: `${base}/${id}/editor?expectedRevision=${encodeURIComponent(expectedRevision)}`, headers: principal });
  const apply = (id: string, files: ReadyFile[]) => app.inject({
    method: "POST", url: `${base}/${id}/items/import`, headers, payload: { files },
  });
  const input = (item: Definition["items"][number]): EditorItem => ({
    id: item.id, assetId: item.assetId, versionId: item.pinnedVersionId,
    outputPath: item.outputPath, transformation: item.transformation, writable: item.writable,
  });
  const add = (file: ReadyFile, options: Partial<EditorItem> = {}): EditorItem => ({
    id: null, assetId: file.assetId, versionId: null, outputPath: file.outputPath,
    transformation: null, writable: false, ...options,
  });
  async function makeVard() {
    const created = ok(await app.inject({ method: "POST", url: base, headers, payload: { name: `Editor ${randomUUID()}` } }), 201);
    vardIds.push(created.id);
    return created.id as string;
  }
  async function makeAsset(key: string, workspaceId = "ws"): Promise<ReadyFile> {
    const assetId = randomUUID(), versionId = randomUUID(), storageKey = `${prefix}${versionId}`;
    assetIds.push(assetId); objectKeys.push(storageKey); objects.set(storageKey, bytes);
    await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,$2,$3,'Editor fixture','fixture','fixture')", [assetId, workspaceId, `${prefix}${key}`]);
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES($1,$2,$3,1,'ready',$4,'editor.svg','image/svg+xml',$5,$6,'fixture','fixture')", [versionId, workspaceId, assetId, storageKey, bytes.length, checksum]);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, assetId]);
    return { assetId, versionId, key: `${prefix}${key}`, outputPath: key, checksum, mimeType: "image/svg+xml", size: bytes.length };
  }
  const rows = async (id: string) => (await admin.query("SELECT *,created_at::text AS creation,updated_at::text AS modification FROM vard_item WHERE vard_id=$1 ORDER BY id", [id])).rows;
  async function snapshot(id: string) {
    const [record, items, audit] = await Promise.all([
      admin.query("SELECT *,updated_at::text AS modification FROM vard WHERE id=$1", [id]),
      rows(id), admin.query("SELECT * FROM audit_event WHERE target_id=$1 ORDER BY id", [id]),
    ]);
    return { record: record.rows, items, audit: audit.rows };
  }
  async function scopedKey(actions: string[]) {
    const result = ok(await app.inject({ method: "POST", url: "/api/workspaces/ws/api-keys",
      headers: { cookie: cookies.owner! }, payload: { name: `Editor ${randomUUID().slice(0, 12)}`, access: "write" } }));
    keyIds.push(result.id);
    await admin.query("UPDATE apikey SET permissions=$1,rate_limit_enabled=false WHERE id=$2", [JSON.stringify({ asset: actions }), result.id]);
    return { "x-api-key": result.key as string };
  }
  function conflict(response: Awaited<ReturnType<typeof app.inject>>, currentRevision: string) {
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), { code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision });
  }
  async function waitForWaiters(count: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await admin.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND classid=74122 AND objid=((hashtext('ws')::bigint & 4294967295)::oid) AND objsubid=2 AND NOT granted");
      if (result.rows[0].count >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`expected ${count} PostgreSQL waiters on the workspace content guard`);
  }
  async function queued<A, B>(firstAction: () => PromiseLike<A>, secondAction: () => PromiseLike<B>): Promise<[A, B]> {
    const blocker = await admin.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(74122,hashtext('ws'))");
      const first = Promise.resolve().then(firstAction); pending.push(first); void first.catch(() => {});
      await waitForWaiters(1);
      const second = Promise.resolve().then(secondAction); pending.push(second); void second.catch(() => {});
      await waitForWaiters(2);
      await blocker.query("COMMIT");
      return await Promise.all([first, second]);
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      await Promise.allSettled(pending);
    }
  }

  await t.test("editor is manual-only; literal pin and revision remain separate from current source data", async () => {
    const id = await makeVard(), file = await makeAsset("source/a.svg");
    const initial = await editor(id);
    assert.match(initial.revision, /^v1:[a-f0-9]{64}$/);
    const saved = ok(await put(id, initial.revision, [add(file, { versionId: file.versionId })])) as Definition;
    assert.equal(saved.items[0]!.pinnedVersionId, file.versionId);
    const rules = [{ sourcePrefix: `${prefix}source/`, outputPrefix: "generated/" }];
    const withRules = ok(await patch(id, saved.revision, { folderRules: rules })) as Definition;
    assert.equal(withRules.items.length, 1);
    assert.deepEqual(withRules.folderRules, rules);
    await admin.query("UPDATE asset SET display_name='Source metadata only',is_public=true,key=$1,current_version_id=null WHERE id=$2", [`${prefix}source/renamed.svg`, file.assetId]);
    await mutateLegacyVersion(admin, "UPDATE asset_version SET mime_type='image/png',checksum=$1,size=size+1 WHERE id=$2", ["b".repeat(64), file.versionId]);
    const changedSource = await editor(id);
    assert.equal(changedSource.revision, withRules.revision);
    assert.equal(changedSource.items[0]!.key, `${prefix}source/renamed.svg`);
    assert.equal(changedSource.items[0]!.pinnedVersionId, file.versionId);
    const legacy = ok(await app.inject({ url: `${base}/${id}`, headers: keyHeaders.read! }));
    assert.equal(legacy.revision, undefined);
    assert.equal(legacy.items[0].pinnedVersionId, undefined);
  });

  await t.test("editor can inspect and repair a definition whose expanded folder outputs collide", async () => {
    const id = await makeVard(), file = await makeAsset("repair/a.svg");
    const manual = ok(await put(id, (await editor(id)).revision, [add(file, { outputPath: "images/a.svg" })])) as Definition;
    const rules = [{ sourcePrefix: `${prefix}repair/`, outputPrefix: "images/" }];
    const colliding = ok(await patch(id, manual.revision, { folderRules: rules })) as Definition;
    assert.equal((await app.inject({ url: `${base}/${id}/manifest`, headers: keyHeaders.read! })).statusCode, 409);
    assert.deepEqual(await editor(id), colliding);
    const renamed = ok(await patch(id, colliding.revision, { name: "Repairable editor" })) as Definition;
    assert.deepEqual(renamed.folderRules, rules);
    const repaired = ok(await put(id, renamed.revision, [])) as Definition;
    assert.equal(repaired.items.length, 0);
    const manifest = ok(await app.inject({ url: `${base}/${id}/manifest`, headers: keyHeaders.read! }));
    assert.equal(manifest.items.length, 1);
    assert.match(manifest.items[0].id, /^folder:/);
  });

  await t.test("fresh no-op PUT/PATCH preserve token, rows, timestamps and audit", async () => {
    const id = await makeVard(), first = await makeAsset("noop/a.svg"), second = await makeAsset("noop/b.svg");
    const initial = await editor(id);
    const saved = ok(await put(id, initial.revision, [add(first, { transformation: { w: 8, format: "png" } }), add(second)])) as Definition;
    const before = await snapshot(id);
    const desired = saved.items.map(input).reverse();
    desired[1]!.transformation = { format: "png", w: 8 };
    const unchanged = ok(await put(id, saved.revision, desired)) as Definition;
    assert.equal(unchanged.revision, saved.revision);
    const sameFields = ok(await patch(id, saved.revision, { name: ` ${saved.name} `, isPublic: saved.isPublic, folderRules: saved.folderRules })) as Definition;
    assert.equal(sameFields.revision, saved.revision);
    assert.deepEqual(await snapshot(id), before);
    const replay = ok(await apply(id, [{ ...first, outputPath: first.outputPath }, second]));
    assert.equal(replay.added, 0);
    assert.equal((await editor(id)).revision, saved.revision);
    assert.deepEqual(await snapshot(id), before);
  });

  await t.test("stable-ID diff preserves settings, pins and exact creation metadata; untouched rows stay untouched", async () => {
    const id = await makeVard(), a = await makeAsset("stable/a.svg"), b = await makeAsset("stable/b.svg"), c = await makeAsset("stable/c.svg");
    const saved = ok(await put(id, (await editor(id)).revision, [add(a, { versionId: a.versionId, transformation: { w: 9 } }), add(b, { writable: true })])) as Definition;
    await admin.query("UPDATE vard_item SET created_at='2026-01-01 01:02:03.123456+00',created_by='original:creator' WHERE vard_id=$1", [id]);
    const current = await editor(id), before = await rows(id);
    const desired = current.items.map(input);
    desired[0]!.transformation = { w: 12, h: 12, fit: "contain", format: "webp", bg: "#Ab12Ef", pad: 25 };
    desired.push(add(c));
    const changed = ok(await put(id, current.revision, desired)) as Definition;
    assert.notEqual(changed.revision, current.revision);
    assert.equal(changed.items[0]!.id, saved.items[0]!.id);
    assert.equal(changed.items[0]!.pinnedVersionId, a.versionId);
    assert.deepEqual(changed.items[0]!.transformation, { w: 12, h: 12, fit: "contain", format: "webp", bg: "#ab12ef", pad: 25 });
    assert.match(changed.items[0]!.downloadUrl!, /&pad=25&sig=/);
    const after = await rows(id);
    for (const old of before) {
      const next = after.find(row => row.id === old.id);
      assert.equal(next.creation, old.creation); assert.equal(next.created_by, old.created_by);
    }
    assert.deepEqual(after.find(row => row.id === saved.items[1]!.id), before.find(row => row.id === saved.items[1]!.id));
    assert.deepEqual(await editor(id), changed, "write returns the exact next editable state");
  });

  await t.test("existing unavailable literal pins round-trip while new, changed and reassigned pins require ready ownership", async () => {
    const id = await makeVard(), pinnedFile = await makeAsset("unavailable/a.svg"), other = await makeAsset("unavailable/b.svg");
    const saved = ok(await put(id, (await editor(id)).revision, [
      add(pinnedFile, { versionId: pinnedFile.versionId }), add(other),
    ])) as Definition;
    const pinnedId = saved.items.find(item => item.assetId === pinnedFile.assetId)!.id;
    await mutateLegacyVersion(admin, "UPDATE asset_version SET status='failed',error='Fixture unavailable source' WHERE id=$1", [pinnedFile.versionId]);
    const unavailable = await editor(id);
    const retained = unavailable.items.find(item => item.id === pinnedId)!;
    assert.equal(unavailable.revision, saved.revision);
    assert.equal(retained.versionId, null);
    assert.equal(retained.pinnedVersionId, pinnedFile.versionId);
    const before = await snapshot(id);
    const unchanged = ok(await put(id, unavailable.revision, unavailable.items.map(input))) as Definition;
    assert.equal(unchanged.revision, unavailable.revision);
    assert.deepEqual(await snapshot(id), before, "unavailable pin no-op leaves domain rows and audit intact");
    const omittedPin = unavailable.items.map(input).map(item => item.id === pinnedId ? { ...item, versionId: undefined } : item);
    const omission = await put(id, unavailable.revision, omittedPin as EditorItem[]);
    assert.equal(omission.statusCode, 400, omission.body);
    assert.deepEqual(await snapshot(id), before, "missing literal pin cannot silently unpin an existing item");
    const desired = unavailable.items.map(input);
    desired.find(item => item.assetId === other.assetId)!.writable = true;
    const changed = ok(await put(id, unavailable.revision, desired)) as Definition;
    assert.notEqual(changed.revision, unavailable.revision);
    assert.equal(changed.items.find(item => item.id === pinnedId)!.pinnedVersionId, pinnedFile.versionId);
    assert.deepEqual((await rows(id)).find(row => row.id === pinnedId), before.items.find(row => row.id === pinnedId));
    const replacementPin = randomUUID();
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES($1::uuid,'ws',$2,2,'failed',$1::text,'unavailable.svg','image/svg+xml',$3,$4,'fixture','fixture')", [replacementPin, pinnedFile.assetId, bytes.length, checksum]);
    const after = await snapshot(id);
    const current = changed.items.map(input);
    for (const items of [
      [...current, add(pinnedFile, { outputPath: "unavailable/new.svg", versionId: pinnedFile.versionId })],
      current.map(item => item.id === pinnedId ? { ...item, versionId: replacementPin } : item),
      current.map(item => item.id === pinnedId ? { ...item, assetId: other.assetId } : item),
      current.map(item => item.id === pinnedId ? { ...item, versionId: randomUUID() } : item),
    ]) {
      const response = await put(id, changed.revision, items);
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(await snapshot(id), after);
    }
  });

  await t.test("path swaps and three-way cycles preserve mapping IDs and microsecond creation values", async () => {
    const id = await makeVard(), files = await Promise.all(["swap/a.svg", "swap/b.svg", "swap/c.svg"].map(key => makeAsset(key)));
    ok(await put(id, (await editor(id)).revision, files.map(file => add(file))));
    await admin.query("UPDATE vard_item SET created_at='2026-01-01 01:02:03.987654+00',created_by='original:path' WHERE vard_id=$1", [id]);
    const before = await rows(id);
    let current = await editor(id), desired = current.items.map(input);
    [desired[0]!.outputPath, desired[1]!.outputPath] = [desired[1]!.outputPath, desired[0]!.outputPath];
    current = ok(await put(id, current.revision, desired)) as Definition;
    for (const old of before) {
      const next = (await rows(id)).find(row => row.id === old.id);
      assert.equal(next.creation, old.creation); assert.equal(next.created_by, old.created_by);
    }
    desired = current.items.map(input);
    const paths = desired.map(item => item.outputPath);
    desired.forEach((item, index) => { item.outputPath = paths[(index + 1) % paths.length]!; });
    const cycled = ok(await put(id, current.revision, desired)) as Definition;
    assert.deepEqual(new Set(cycled.items.map(item => item.id)), new Set(before.map(row => row.id)));
    for (const old of before) assert.equal((await rows(id)).find(row => row.id === old.id).creation, old.creation);
  });

  await t.test("invalid item identities and domain inputs reject atomically; stale token precedes domain validation", async () => {
    const id = await makeVard(), other = await makeVard(), a = await makeAsset("invalid/a.svg"), b = await makeAsset("invalid/b.svg"), foreign = await makeAsset("invalid/foreign.svg", "other-ws");
    const saved = ok(await put(id, (await editor(id)).revision, [add(a)])) as Definition;
    const cross = ok(await put(other, (await editor(other)).revision, [add(b)])) as Definition;
    const row = input(saved.items[0]!);
    const before = await snapshot(id);
    for (const items of [
      [{ ...row, id: randomUUID() }], [{ ...row, id: cross.items[0]!.id }],
      [row, { ...row, outputPath: "invalid/second.svg" }],
      [{ ...row, assetId: foreign.assetId }], [{ ...row, versionId: b.versionId }],
      [row, add(b, { outputPath: row.outputPath.toUpperCase() })],
      [{ ...row, id: `folder:${"a".repeat(64)}` }], [{ ...row, id: undefined }],
    ]) {
      const response = await put(id, saved.revision, items as EditorItem[]);
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(await snapshot(id), before);
    }
    const current = ok(await patch(id, saved.revision, { isPublic: true })) as Definition;
    const after = await snapshot(id);
    conflict(await put(id, saved.revision, [{ ...row, id: randomUUID(), assetId: foreign.assetId }]), current.revision);
    conflict(await put(id, saved.revision, current.items.map(input)), current.revision);
    conflict(await patch(id, saved.revision, { isPublic: true }), current.revision);
    conflict(await remove(id, saved.revision), current.revision);
    assert.deepEqual(await snapshot(id), after);
  });

  await t.test("missing/invalid guards and strict schemas cannot silently use legacy behavior", async () => {
    const id = await makeVard(), initial = await editor(id), before = await snapshot(id);
    for (const payload of [{ name: "missing" }, { expectedRevision: "invalid", name: "invalid" },
      { expectedRevision: initial.revision }, { expectedRevision: initial.revision, unrecognized: "field" }]) {
      const response = await app.inject({ method: "PATCH", url: `${base}/${id}/editor`, headers, payload });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal((await app.inject({ method: "PUT", url: `${base}/${id}/editor/items`, headers, payload: { items: [] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: `${base}/${id}/editor`, headers })).statusCode, 400);
    assert.deepEqual(await snapshot(id), before);
  });

  await t.test("import queued before editor invalidates stale desired list; editor queued before import preserves both edits", async () => {
    const a = await makeAsset("order/a.svg"), b = await makeAsset("order/b.svg");
    const first = await makeVard(), old = await editor(first);
    const [imported, stale] = await queued(() => apply(first, [a]), () => put(first, old.revision, [add(b)]));
    ok(imported); conflict(stale, (await editor(first)).revision);
    assert.deepEqual((await editor(first)).items.map(item => item.assetId), [a.assetId]);
    const second = await makeVard(), current = await editor(second);
    const [saved, followingImport] = await queued(() => put(second, current.revision, [add(b)]), () => apply(second, [a]));
    ok(saved); ok(followingImport);
    assert.deepEqual(new Set((await editor(second)).items.map(item => item.assetId)), new Set([a.assetId, b.assetId]));
    assert.notEqual((await editor(second)).revision, saved.json().revision);
  });

  await t.test("two queued editors permit one save and return a coherent response before the later conflict", async () => {
    const id = await makeVard(), a = await makeAsset("two/a.svg"), before = await editor(id);
    const [saved, stale] = await queued(() => put(id, before.revision, [add(a)]), () => patch(id, before.revision, { name: "Two editors" }));
    const definition = ok(saved) as Definition;
    conflict(stale, definition.revision);
    assert.deepEqual(await editor(id), definition);
    assert.equal((await snapshot(id)).audit.filter(row => row.action === "vard.items_updated").length, 1);
  });

  await t.test("editor GET keeps its complete repeatable-read snapshot while later configuration and source changes commit", async () => {
    const id = await makeVard(), file = await makeAsset("snapshot/a.svg");
    const definition = ok(await put(id, (await editor(id)).revision, [add(file)])) as Definition;
    const nextVersion = randomUUID();
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) SELECT $1,workspace_id,asset_id,2,'ready',$2,filename,mime_type,size,checksum,created_by,updated_by FROM asset_version WHERE id=$3", [nextVersion, `${prefix}${nextVersion}`, file.versionId]);
    objects.set(`${prefix}${nextVersion}`, bytes); objectKeys.push(`${prefix}${nextVersion}`);
    const blocker = await admin.connect();
    let pending: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE vard_item IN ACCESS EXCLUSIVE MODE");
      pending = Promise.resolve(get(id)); void pending.catch(() => {});
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='vard_item'::regclass AND NOT granted) AS waiting")).rows[0].waiting;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, "GET must reach its item SELECT before the concurrent commit");
      await admin.query("UPDATE vard SET name='Committed after GET snapshot',updated_at=now() WHERE id=$1", [id]);
      await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [nextVersion, file.assetId]);
      await blocker.query("COMMIT");
      assert.deepEqual(ok(await pending), definition, "response definition and revision both come from the earlier snapshot");
      const next = await editor(id);
      assert.equal(next.name, "Committed after GET snapshot");
      assert.notEqual(next.revision, definition.revision);
      assert.equal(next.items[0]!.versionId, nextVersion);
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      if (pending) await pending;
    }
  });

  await t.test("folder-rule editors and import observe the same serialized membership in both orders", async () => {
    const file = await makeAsset("rules/logo.svg");
    const rules = [{ sourcePrefix: `${prefix}rules/`, outputPrefix: "images/" }];
    const desired = { ...file, outputPath: "images/logo.svg" };
    const first = await makeVard(), before = await editor(first);
    const [imported, staleRules] = await queued(() => apply(first, [desired]), () => patch(first, before.revision, { folderRules: rules }));
    ok(imported); conflict(staleRules, (await editor(first)).revision);
    const second = await makeVard(), original = await editor(second);
    const [savedRules, generatedImport] = await queued(() => patch(second, original.revision, { folderRules: rules }), () => apply(second, [desired]));
    ok(savedRules); assert.equal(ok(generatedImport).added, 0);
    assert.equal((await editor(second)).revision, savedRules.json().revision);
    assert.equal((await editor(second)).items.length, 0);
    const dynamic = ok(await app.inject({ url: `${base}/${second}/manifest`, headers: keyHeaders.read! }));
    assert.match(dynamic.items[0].id, /^folder:/);
  });

  await t.test("legacy PATCH and regenerating PUT invalidate an editor token", async () => {
    const id = await makeVard(), a = await makeAsset("legacy/a.svg"), before = await editor(id);
    ok(await app.inject({ method: "PATCH", url: `${base}/${id}`, headers, payload: { name: "Legacy changed name" } }));
    const renamed = await editor(id);
    assert.notEqual(renamed.revision, before.revision);
    conflict(await patch(id, before.revision, { isPublic: true }), renamed.revision);
    const payload = { items: [add(a)] };
    ok(await app.inject({ method: "PUT", url: `${base}/${id}/items`, headers, payload }));
    const legacy = await editor(id);
    const oldId = legacy.items[0]!.id;
    ok(await app.inject({ method: "PUT", url: `${base}/${id}/items`, headers, payload }));
    const regenerated = await editor(id);
    assert.notEqual(regenerated.items[0]!.id, oldId);
    assert.notEqual(regenerated.revision, legacy.revision);
    conflict(await put(id, legacy.revision, legacy.items.map(input)), regenerated.revision);
  });

  await t.test("asset deletion cascades invalidate editor revisions even without touching the Vard timestamp", async () => {
    const id = await makeVard(), a = await makeAsset("cascade/a.svg");
    const saved = ok(await put(id, (await editor(id)).revision, [add(a)])) as Definition;
    const vardBefore = (await snapshot(id)).record;
    ok(await app.inject({ method: "DELETE", url: `/api/workspaces/ws/assets/${a.assetId}`, headers }), 204);
    const next = await editor(id);
    assert.notEqual(next.revision, saved.revision); assert.equal(next.items.length, 0);
    assert.deepEqual((await snapshot(id)).record, vardBefore);
    conflict(await put(id, saved.revision, saved.items.map(input)), next.revision);
  });

  await t.test("S3 copy failure cleanup invalidates a manual mapping made during object storage work", async () => {
    const id = await makeVard();
    let saved: Definition | undefined;
    fixture.setCopyHook(async () => {
      const created = (await admin.query("SELECT id FROM asset WHERE workspace_id='ws' AND key=$1", [`${prefix}copy/import.png`])).rows[0];
      assert.ok(created);
      assetIds.push(created.id);
      const before = await editor(id);
      saved = ok(await put(id, before.revision, [{ id: null, assetId: created.id, versionId: null,
        outputPath: "copy.png", transformation: null, writable: false }])) as Definition;
      return true;
    });
    try {
      const imported = ok(await app.inject({ method: "POST", url: "/api/workspaces/ws/imports", headers,
        payload: { source: "incoming/", prefix: `${prefix}copy/` } }));
      assert.equal(imported.imported, 0); assert.equal(imported.skipped, 1);
      assert.ok(saved);
      const next = await editor(id);
      assert.equal(next.items.length, 0); assert.notEqual(next.revision, saved.revision);
      conflict(await put(id, saved.revision, saved.items.map(input)), next.revision);
    } finally { fixture.setCopyHook(async () => false); }
  });

  await t.test("exact database microseconds and ordered folder rules participate in revisions", async () => {
    const id = await makeVard();
    await admin.query("UPDATE vard SET updated_at='2026-01-01 00:00:00.000001+00' WHERE id=$1", [id]);
    const first = await editor(id);
    await admin.query("UPDATE vard SET updated_at='2026-01-01 00:00:00.000002+00' WHERE id=$1", [id]);
    const second = await editor(id);
    assert.notEqual(second.revision, first.revision);
    const rules = [{ sourcePrefix: "a/", outputPrefix: "a/" }, { sourcePrefix: "b/", outputPrefix: "b/" }];
    const ordered = ok(await patch(id, second.revision, { folderRules: rules })) as Definition;
    const reordered = ok(await patch(id, ordered.revision, { folderRules: [...rules].reverse() })) as Definition;
    assert.notEqual(reordered.revision, ordered.revision);
    const nameOnly = ok(await patch(id, reordered.revision, { name: "Omission preserves rules" }));
    assert.deepEqual(nameOnly.folderRules, reordered.folderRules); assert.equal(nameOnly.isPublic, reordered.isPublic);
  });

  await t.test("authorization and workspace isolation precede missing/stale revision disclosure", async () => {
    const id = await makeVard(), before = await editor(id);
    const onlyUpdate = await scopedKey(["update"]), onlyDelete = await scopedKey(["delete"]);
    for (const principal of [{}, keyHeaders.other!, keyHeaders.revoked!, keyHeaders.insufficient!]) {
      const response = await get(id, principal);
      assert.equal(response.statusCode, 401, response.body); assert.equal(response.json().currentRevision, undefined);
      const save = await patch(id, before.revision, { isPublic: true }, principal);
      assert.equal(save.statusCode, 401, save.body); assert.equal(save.json().currentRevision, undefined);
    }
    assert.equal((await patch(id, before.revision, { isPublic: true }, keyHeaders.read!)).statusCode, 401);
    assert.equal((await put(id, before.revision, [], onlyUpdate)).statusCode, 401);
    assert.equal((await patch(id, before.revision, { isPublic: true }, onlyUpdate)).statusCode, 401);
    assert.equal((await get(id, headers, "other-ws")).statusCode, 401);
    const foreignId = randomUUID();
    vardIds.push(foreignId);
    await admin.query("INSERT INTO vard(id,workspace_id,name,created_by,updated_by) VALUES($1,'other-ws','Foreign editor','fixture','fixture')", [foreignId]);
    assert.equal((await get(foreignId)).statusCode, 404);
    assert.equal((await patch(foreignId, before.revision, { isPublic: true })).statusCode, 404);
    assert.equal((await put(foreignId, before.revision, [])).statusCode, 404);
    assert.equal((await remove(foreignId, before.revision)).statusCode, 404);
    assert.equal((await get(randomUUID())).statusCode, 404);
    ok(await remove(id, before.revision, onlyDelete), 204);
    assert.equal((await get(id)).statusCode, 404);
  });
}
