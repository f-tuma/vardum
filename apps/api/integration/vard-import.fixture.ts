import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

type ImportFile = {
  assetId: string;
  key: string;
  outputPath: string;
  checksum: string;
  mimeType: string;
  size: number;
};
type ReadyFile = ImportFile & { versionId: string };
type Rule = { sourcePrefix: string; outputPrefix: string };

// Runs only inside private-delivery's disposable cluster, with its real auth and RLS role.
export async function checkVardImport(
  t: TestContext,
  fixture: {
    admin: Pool;
    app: FastifyInstance;
    objects: Map<string, Buffer>;
    keyHeaders: Record<string, Record<string, string>>;
    cookies: Record<string, string>;
    setReadHook: (hook: (key: string) => Promise<void>) => void;
  },
) {
  const { admin, app, objects, keyHeaders, cookies } = fixture;
  const prefix = `vard-import-${randomUUID()}/`;
  const assetIds: string[] = [];
  const vardIds: string[] = [];
  const useIds: string[] = [];
  const keyIds: string[] = [];
  const objectKeys: string[] = [];
  const content = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>',
  );
  const checksum = createHash("sha256").update(content).digest("hex");
  const headers = keyHeaders.write!;
  const base = "/api/workspaces/ws/vards";

  t.after(async () => {
    await capable(async (client) => {
      await client.query("DELETE FROM vard WHERE id=ANY($1::uuid[])", [vardIds]);
      await client.query("DELETE FROM asset_use WHERE id=ANY($1::uuid[])", [useIds]);
    });
    await admin.query("DELETE FROM asset WHERE id=ANY($1::uuid[])", [assetIds]);
    await admin.query("DELETE FROM apikey WHERE id=ANY($1::text[])", [keyIds]);
    for (const key of objectKeys) objects.delete(key);
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

  const plan = (vardId: string, files: ImportFile[], principal = headers, workspaceId = "ws") =>
    app.inject({
      method: "POST", url: `/api/workspaces/${workspaceId}/vards/${vardId}/items/import-plan`,
      headers: principal, payload: { files },
    });
  const apply = (vardId: string, files: ReadyFile[], principal = headers, workspaceId = "ws") =>
    app.inject({
      method: "POST", url: `/api/workspaces/${workspaceId}/vards/${vardId}/items/import`,
      headers: principal, payload: { files },
    });
  const manifest = (vardId: string) =>
    app.inject({ url: `${base}/${vardId}/manifest`, headers: keyHeaders.read! });
  const patchRules = (vardId: string, folderRules: Rule[]) =>
    app.inject({ method: "PATCH", url: `${base}/${vardId}`, headers, payload: { folderRules } });
  const editor = async (vardId: string) => successful(await app.inject({
    url: `${base}/${vardId}/editor?definitionSchema=2`, headers,
  }));
  const bind = (vardId: string, expectedRevision: string, useId: string, file: ReadyFile, id: string | null = null) =>
    app.inject({ method: "PUT", url: `${base}/${vardId}/editor/items`, headers,
      payload: { definitionSchema: 2, expectedRevision,
        items: [{ id, outputPath: file.outputPath, binding: { kind: "use", assetUseId: useId } }] } });
  const rows = async (vardId: string) =>
    (await admin.query("SELECT * FROM vard_item WHERE vard_id=$1 ORDER BY output_path", [vardId])).rows;
  const importedAudit = async (vardId: string) =>
    (await admin.query("SELECT * FROM audit_event WHERE target_id=$1 AND action='vard.items_imported' ORDER BY id", [vardId])).rows;
  const successful = (response: Awaited<ReturnType<typeof app.inject>>, status = 200) => {
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  function input(file: ReadyFile | ImportFile, changes: Partial<ImportFile> = {}): ImportFile {
    const { assetId, key, outputPath, checksum, mimeType, size } = file;
    return { assetId, key, outputPath, checksum, mimeType, size, ...changes };
  }
  function futureFile(key: string, outputPath: string): ImportFile {
    const assetId = randomUUID();
    assetIds.push(assetId);
    return { assetId, key: `${prefix}${key}`, outputPath, checksum, mimeType: "image/svg+xml", size: content.length };
  }
  async function makeVard(folderRules: Rule[] = []) {
    const body = successful(await app.inject({
      method: "POST", url: base, headers,
      payload: { name: `Import acceptance ${randomUUID()}`, folderRules },
    }), 201);
    vardIds.push(body.id);
    return body.id as string;
  }
  async function makeUse(file: ReadyFile) {
    const result = successful(await app.inject({ method: "POST", url: "/api/workspaces/ws/asset-uses", headers,
      payload: { sourceAssetId: file.assetId, key: `${prefix}linked/${randomUUID()}`,
        displayName: "Original import binding", transformation: null } }), 201);
    useIds.push(result.id);
    return result.id as string;
  }
  async function addVersion(
    file: ImportFile,
    options: { current?: boolean; status?: string; mimeType?: string; checksum?: string; size?: number } = {},
  ): Promise<ReadyFile> {
    const versionId = randomUUID();
    const storageKey = `${prefix}${versionId}`;
    objects.set(storageKey, content);
    objectKeys.push(storageKey);
    const number = (await admin.query(
      "SELECT coalesce(max(number),0)+1 AS number FROM asset_version WHERE asset_id=$1", [file.assetId],
    )).rows[0].number;
    const result = { ...file, versionId, mimeType: options.mimeType ?? file.mimeType,
      checksum: options.checksum ?? file.checksum, size: options.size ?? file.size };
    await admin.query(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) SELECT $1,workspace_id,id,$3,$4,$5,'import.svg',$6,$7,$8,'fixture','fixture' FROM asset WHERE id=$2",
      [versionId, file.assetId, number, options.status ?? "ready", storageKey, result.mimeType, result.size, result.checksum],
    );
    if (options.current !== false)
      await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, file.assetId]);
    return result;
  }
  async function makeAsset(
    key: string,
    outputPath = `${key}.svg`,
    options: { workspaceId?: string; status?: string; mimeType?: string } = {},
  ): Promise<ReadyFile> {
    const file = futureFile(key, outputPath);
    file.mimeType = options.mimeType ?? file.mimeType;
    await admin.query(
      "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,$2,$3,'VARD import fixture','fixture','fixture')",
      [file.assetId, options.workspaceId ?? "ws", file.key],
    );
    return addVersion(file, { status: options.status });
  }
  async function manual(
    vardId: string, file: ReadyFile, outputPath = file.outputPath,
    options: { versionId?: string | null; transformation?: Record<string, unknown> | null; writable?: boolean } = {},
  ) {
    const id = randomUUID();
    await admin.query(
      "INSERT INTO vard_item(id,workspace_id,vard_id,asset_id,version_id,output_path,transformation,writable,created_by,updated_by) VALUES($1,'ws',$2,$3,$4,$5,$6,$7,'fixture:original','fixture:original')",
      [id, vardId, file.assetId, options.versionId ?? null, outputPath,
        options.transformation ? JSON.stringify(options.transformation) : null, options.writable ?? false],
    );
    return id;
  }
  async function snapshot() {
    const [assets, versions, vards, items, uses] = await Promise.all([
      admin.query("SELECT * FROM asset WHERE id=ANY($1::uuid[]) ORDER BY id", [assetIds]),
      admin.query("SELECT * FROM asset_version WHERE asset_id=ANY($1::uuid[]) ORDER BY id", [assetIds]),
      admin.query("SELECT * FROM vard WHERE id=ANY($1::uuid[]) ORDER BY id", [vardIds]),
      admin.query("SELECT * FROM vard_item WHERE vard_id=ANY($1::uuid[]) ORDER BY id", [vardIds]),
      admin.query("SELECT * FROM asset_use WHERE id=ANY($1::uuid[]) ORDER BY id", [useIds]),
    ]);
    const targetIds = [...assetIds, ...vardIds, ...useIds, ...versions.rows.map(row => row.id), ...items.rows.map(row => row.id)];
    const audit = await admin.query("SELECT * FROM audit_event WHERE target_id=ANY($1::text[]) ORDER BY id", [targetIds]);
    return { assets: assets.rows, versions: versions.rows, vards: vards.rows, items: items.rows, uses: uses.rows, audit: audit.rows };
  }
  async function scopedKey(actions: string[]) {
    const result = successful(await app.inject({
      method: "POST", url: "/api/workspaces/ws/api-keys", headers: { cookie: cookies.owner! },
      payload: { name: `Import ${randomUUID().slice(0, 12)}`, access: "write" },
    }));
    keyIds.push(result.id);
    await admin.query("UPDATE apikey SET permissions=$1,rate_limit_enabled=false WHERE id=$2", [
      JSON.stringify({ asset: actions }), result.id,
    ]);
    return { "x-api-key": result.key as string };
  }

  await t.test("planning is read-only; seven additions preserve the old mapping and replay has no audit", async () => {
    const vardId = await makeVard();
    const original = await makeAsset("preserve/original", "manual/original.svg");
    const originalId = await manual(vardId, original, original.outputPath, {
      versionId: original.versionId, transformation: { w: 8, format: "png" },
    });
    const originalRow = (await rows(vardId))[0];
    const additions = await Promise.all(Array.from({ length: 7 }, (_, index) =>
      makeAsset(`preserve/new-${index}`, `new/${index}.svg`)));
    const files = [original, ...additions];
    const before = await snapshot();
    const preview = successful(await plan(vardId, files.map(file => input(file))));
    assert.equal(preview.files.length, 8);
    assert.deepEqual(preview.files.map((file: any) => file.libraryAction), Array(8).fill("skip"));
    assert.deepEqual(preview.files.map((file: any) => file.mappingAction), ["keep", ...Array(7).fill("add")]);
    assert.equal(preview.files[0].mappingId, originalId);
    for (let index = 1; index < files.length; index++) {
      assert.equal(preview.files[index].versionId, files[index]!.versionId);
      assert.equal(preview.files[index].mappingId, null);
    }
    assert.deepEqual(await snapshot(), before, "preflight cannot change domain rows or audit");
    const result = successful(await apply(vardId, files));
    assert.equal(result.added, 7);
    assert.equal(result.kept, 1);
    assert.deepEqual(result.files.map((file: any) => file.mappingAction), ["kept", ...Array(7).fill("added")]);
    const mappings = await rows(vardId);
    assert.equal(mappings.length, 8);
    assert.deepEqual(mappings.find(row => row.id === originalId), originalRow);
    for (const row of mappings.filter(row => row.id !== originalId)) {
      assert.equal(row.version_id, null, "additions follow the latest original");
      assert.equal(row.transformation, null);
      assert.equal(row.writable, false);
    }
    assert.equal((await importedAudit(vardId)).length, 1);
    const after = await snapshot();
    const replay = successful(await apply(vardId, files));
    assert.equal(replay.added, 0);
    assert.equal(replay.kept, 8);
    assert.deepEqual(replay.files.map((file: any) => file.mappingId), result.files.map((file: any) => file.mappingId));
    assert.deepEqual(await snapshot(), after, "natural retry leaves IDs, settings, timestamps and audit intact");
  });

  await t.test("Original live-use imports refuse identical source bytes while source additions preserve the literal binding", async () => {
    const file = await makeAsset("live/original", "linked/original.svg");
    const extra = await makeAsset("live/additional", "additional.svg");
    const vardId = await makeVard();
    const useId = await makeUse(file);
    const definition = await editor(vardId);
    successful(await bind(vardId, definition.revision, useId, file));
    const linked = (await rows(vardId))[0];
    assert.equal(linked.asset_id, file.assetId);
    assert.equal(linked.asset_use_id, useId);
    assert.equal(linked.definition_schema, 2);
    assert.equal(linked.version_id, null);
    assert.equal(linked.transformation, null);
    assert.equal(linked.writable, false);
    const output = successful(await manifest(vardId)).items[0];
    assert.equal(output.assetId, file.assetId);
    assert.equal(output.writable, false);
    assert.equal(output.pinned, false);
    const before = await snapshot();
    for (const result of [await plan(vardId, [input(extra), input(file)]), await apply(vardId, [extra, file])]) {
      assert.equal(result.statusCode, 409, result.body);
      assert.match(result.json().error, /Linked uses are read-only/);
    }
    assert.deepEqual(await snapshot(), before, "refused batches cannot append, change bindings or audit");
    assert.equal(successful(await plan(vardId, [input(extra)])).files[0].mappingAction, "add");
    assert.equal(successful(await apply(vardId, [extra])).added, 1);
    const after = await rows(vardId);
    assert.deepEqual(after.find(row => row.id === linked.id), linked);
    const addition = after.find(row => row.id !== linked.id);
    assert.equal(addition.definition_schema, 2, "source appends inherit the extended parent marker");
    assert.equal(addition.asset_use_id, null);
    assert.equal(addition.asset_id, extra.assetId);
    const replayBefore = await snapshot();
    assert.equal(successful(await apply(vardId, [extra])).kept, 1);
    assert.deepEqual(await snapshot(), replayBefore, "source retry never reserializes a linked row");
  });

  await t.test("exact generated membership is kept without creating a manual mapping", async () => {
    const file = await makeAsset("generated/logo", "images/logo.svg");
    const vardId = await makeVard([{ sourcePrefix: `${prefix}generated/`, outputPrefix: "images/" }]);
    const item = successful(await manifest(vardId)).items[0];
    assert.match(item.id, /^folder:/);
    const before = await snapshot();
    const preview = successful(await plan(vardId, [input(file)]));
    assert.equal(preview.files[0].mappingAction, "keep");
    assert.equal(preview.files[0].mappingId, item.id);
    const result = successful(await apply(vardId, [file]));
    assert.deepEqual(result, {
      files: [{ assetId: file.assetId, key: file.key, outputPath: file.outputPath, mappingId: item.id, mappingAction: "kept" }],
      added: 0, kept: 1,
    });
    assert.equal((await rows(vardId)).length, 0);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("library actions compare current checksum, MIME and size and never allocate on preflight", async () => {
    const file = await makeAsset("actions/existing", "existing.svg");
    const unready = await makeAsset("actions/unready", "unready.svg", { status: "pending" });
    const next = futureFile("actions/new", "new.svg");
    const vardId = await makeVard();
    const before = await snapshot();
    for (const change of [{ checksum: "b".repeat(64) }, { mimeType: "image/png" }, { size: file.size + 1 }]) {
      const preview = successful(await plan(vardId, [input(file, change)]));
      assert.equal(preview.files[0].libraryAction, "update");
      assert.equal(preview.files[0].versionId, file.versionId);
    }
    const preview = successful(await plan(vardId, [input(file), input(unready), next]));
    assert.deepEqual(preview.files.map((item: any) => item.libraryAction), ["skip", "update", "new"]);
    assert.equal(preview.files[2].versionId, null);
    assert.deepEqual(await snapshot(), before);
    for (const invalid of [input(file, { key: `${file.key}-wrong` }), { ...next, key: file.key }]) {
      const result = await plan(vardId, [invalid]);
      assert.equal(result.statusCode, 409, result.body);
      assert.deepEqual(await snapshot(), before);
    }
  });

  await t.test("projected MIME replaces old folder paths before computing new manual membership", async () => {
    const file = await makeAsset("mime/logo", "images/logo.svg");
    const vardId = await makeVard([{ sourcePrefix: `${prefix}mime/`, outputPrefix: "images/" }]);
    assert.deepEqual(successful(await manifest(vardId)).items.map((item: any) => item.outputPath), ["images/logo.svg"]);
    const projected = input(file, { mimeType: "image/png", checksum: "c".repeat(64) });
    const before = await snapshot();
    const preview = successful(await plan(vardId, [projected]));
    assert.equal(preview.files[0].libraryAction, "update");
    assert.equal(preview.files[0].mappingAction, "add", "the old generated SVG path disappears from the projected union");
    assert.equal(preview.files[0].mappingId, null);
    assert.deepEqual(await snapshot(), before);
    const ready = await addVersion(projected);
    const result = successful(await apply(vardId, [ready]));
    assert.equal(result.added, 1);
    assert.equal(result.kept, 0);
    assert.deepEqual(successful(await manifest(vardId)).items.map((item: any) => item.outputPath).sort(),
      ["images/logo.png", "images/logo.svg"]);
    assert.equal((await rows(vardId))[0].id, result.files[0].mappingId);
    const replay = successful(await plan(vardId, [input(ready)]));
    assert.equal(replay.files[0].libraryAction, "skip");
    assert.equal(replay.files[0].mappingAction, "keep");
  });

  await t.test("new and unready assets participate in folder collisions during preflight", async () => {
    const manualFile = await makeAsset("projected/manual", "images/logo.svg");
    const unready = await makeAsset("projected-pending/logo", "imports/logo.svg", { status: "pending" });
    const future = futureFile("projected-new/logo", "imports/logo.svg");
    for (const [source, file] of [["projected-pending/", input(unready)], ["projected-new/", future]] as const) {
      const vardId = await makeVard([{ sourcePrefix: `${prefix}${source}`, outputPrefix: "images/" }]);
      await manual(vardId, manualFile);
      const before = await snapshot();
      const result = await plan(vardId, [file]);
      assert.equal(result.statusCode, 409, result.body);
      assert.deepEqual(await snapshot(), before, "projected collision fails before an asset, version or mapping is written");
    }
    const current = await makeAsset("projected-mime/logo", "imports/logo.png");
    const manualPng = await makeAsset("projected-mime-manual/other", "images/logo.png");
    const changedMimeVard = await makeVard([{ sourcePrefix: `${prefix}projected-mime/`, outputPrefix: "images/" }]);
    await manual(changedMimeVard, manualPng);
    successful(await manifest(changedMimeVard));
    const before = await snapshot();
    assert.equal((await plan(changedMimeVard, [input(current, { mimeType: "image/png" })])).statusCode, 409,
      "a MIME change must project new generated paths across every existing manual mapping");
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("ready-current identity and metadata are atomic across a mixed batch", async () => {
    const valid = await makeAsset("atomic/valid", "valid.svg");
    const historical = await makeAsset("atomic/changed", "changed.svg");
    const current = await addVersion(historical);
    const pending = await makeAsset("atomic/pending", "pending.svg", { status: "pending" });
    const foreign = await makeAsset("atomic/foreign", "foreign.svg", { workspaceId: "other-ws" });
    const missing = { ...futureFile("atomic/missing", "missing.svg"), versionId: randomUUID() };
    const vardId = await makeVard();
    const before = await snapshot();
    const invalid: ReadyFile[] = [
      historical, pending, foreign, missing,
      { ...current, versionId: valid.versionId },
      { ...current, checksum: "d".repeat(64) },
      { ...current, mimeType: "image/png" },
      { ...current, size: current.size + 1 },
      { ...current, key: `${current.key}-moved` },
    ];
    for (const stale of invalid) {
      const result = await apply(vardId, [valid, stale]);
      assert.equal(result.statusCode, 409, result.body);
      assert.deepEqual(await snapshot(), before, "one stale member must roll back every proposed insertion and audit");
    }
    const missingVard = await apply(randomUUID(), [valid]);
    assert.equal(missingVard.statusCode, 404, missingVard.body);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("UUID spelling is case-insensitive and mixed-case duplicate identities cannot allocate", async () => {
    const file = await makeAsset("uuid-case/existing", "uuid.svg");
    const future = futureFile("uuid-case/future", "future.svg");
    const vardId = await makeVard();
    const before = await snapshot();
    const preview = successful(await plan(vardId, [input(file, { assetId: file.assetId.toUpperCase() })]));
    assert.equal(preview.files[0].libraryAction, "skip");
    assert.equal(preview.files[0].versionId, file.versionId);
    assert.deepEqual(await snapshot(), before);
    const result = successful(await apply(vardId, [{ ...file,
      assetId: file.assetId.toUpperCase(), versionId: file.versionId.toUpperCase(),
    }]));
    assert.equal(result.added, 1);
    assert.equal((await rows(vardId))[0].asset_id, file.assetId);
    const after = await snapshot();
    const duplicate = { ...future, assetId: future.assetId.toUpperCase(), key: `${future.key}-second`, outputPath: "second.svg" };
    const duplicatedPlan = await plan(vardId, [future, duplicate]);
    assert.ok([400, 409].includes(duplicatedPlan.statusCode), duplicatedPlan.body);
    assert.deepEqual(await snapshot(), after, "one UUID cannot be admitted twice through different spelling");
    const duplicatedApply = await apply(vardId, [file, { ...file,
      assetId: file.assetId.toUpperCase(), versionId: file.versionId.toUpperCase(), outputPath: "second.svg",
    }]);
    assert.ok([400, 409].includes(duplicatedApply.statusCode), duplicatedApply.body);
    assert.deepEqual(await snapshot(), after);
  });

  await t.test("strict request validation and unsafe paths cannot modify the VARD", async () => {
    const file = await makeAsset("validation/file", "safe.svg");
    const vardId = await makeVard();
    const before = await snapshot();
    const badInputs: unknown[] = [
      { files: [] },
      { files: Array.from({ length: 1001 }, () => input(file)) },
      { files: [input(file)], ignored: true },
      { files: [{ ...input(file), ignored: true }] },
      { files: [{ ...input(file), assetId: "invalid" }] },
      { files: [{ ...input(file), checksum: "g".repeat(64) }] },
      { files: [{ ...input(file), checksum: "a".repeat(63) }] },
      { files: [{ ...input(file), size: -1 }] },
      { files: [{ ...input(file), size: 0 }] },
      { files: [{ ...input(file), size: 1.5 }] },
      { files: [{ ...input(file), mimeType: "text/plain" }] },
    ];
    for (const field of ["assetId", "key", "outputPath", "checksum", "mimeType", "size"]) {
      const incomplete: Record<string, unknown> = { ...input(file) };
      delete incomplete[field];
      badInputs.push({ files: [incomplete] });
    }
    for (const outputPath of ["../escape.svg", "/absolute.svg", "a//b.svg", "a\\b.svg", ".git/config", "vardum.json", ".vardum.lock", "CON.svg", "a./b.svg"])
      badInputs.push({ files: [input(file, { outputPath })] });
    for (const payload of badInputs) {
      const result = await app.inject({ method: "POST", url: `${base}/${vardId}/items/import-plan`, headers, payload: payload as any });
      assert.equal(result.statusCode, 400, result.body);
    }
    for (const payload of [{ files: [input(file)] }, { files: [{ ...file, versionId: null }] }, { files: [{ ...file, versionId: "invalid" }] }]) {
      const result = await app.inject({ method: "POST", url: `${base}/${vardId}/items/import`, headers, payload });
      assert.equal(result.statusCode, 400, result.body);
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("case, NFC, file-directory and different-asset collisions reject the complete union", async () => {
    const owner = await makeAsset("conflicts/owner", "original.svg");
    const incoming = await makeAsset("conflicts/incoming", "incoming.svg");
    const cases = [
      ["same.svg", "same.svg"], ["Logo.svg", "logo.svg"], ["caf\u00e9.svg", "cafe\u0301.svg"],
      ["directory", "directory/child.svg"], ["directory/child.svg", "directory"],
    ];
    for (const [existingPath, proposedPath] of cases) {
      const vardId = await makeVard();
      await manual(vardId, owner, existingPath!);
      const request = { ...incoming, outputPath: proposedPath! };
      const before = await snapshot();
      for (const result of [await plan(vardId, [input(request)]), await apply(vardId, [request])])
        assert.equal(result.statusCode, 409, result.body);
      assert.deepEqual(await snapshot(), before);
    }
    const vardId = await makeVard();
    const before = await snapshot();
    for (const files of [
      [{ ...owner, outputPath: "same.svg" }, { ...incoming, outputPath: "same.svg" }],
      [{ ...owner, outputPath: "A.svg" }, { ...incoming, outputPath: "a.svg" }],
      [{ ...owner, outputPath: "file" }, { ...incoming, outputPath: "file/child.svg" }],
    ]) {
      assert.equal((await plan(vardId, files.map(file => input(file)))).statusCode, 409);
      assert.equal((await apply(vardId, files)).statusCode, 409);
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("invalid legacy paths and duplicate folder rules block imports but remain repairable by legacy PUT", async () => {
    const file = await makeAsset("legacy/file", "valid.svg");
    const generated = await makeAsset("legacy-rule/logo", "new.svg");
    const unsafeVard = await makeVard();
    await manual(unsafeVard, file, ".git/config");
    const rule = { sourcePrefix: `${prefix}legacy-rule/`, outputPrefix: "images/" };
    const duplicateVard = await makeVard([rule, rule]);
    const samePairVard = await makeVard([rule]);
    await manual(samePairVard, generated, "images/logo.svg");
    assert.equal((await manifest(samePairVard)).statusCode, 409, "existing exact manual/generated overlap remains invalid");
    for (const vardId of [unsafeVard, duplicateVard, samePairVard]) {
      const before = await snapshot();
      assert.equal((await plan(vardId, [input(file)])).statusCode, 409);
      assert.equal((await apply(vardId, [file])).statusCode, 409);
      assert.deepEqual(await snapshot(), before);
      successful(await app.inject({ method: "PUT", url: `${base}/${vardId}/items`, headers, payload: { items: [] } }));
      assert.equal((await rows(vardId)).length, 0, "legacy replacement can clear broken manual definitions");
    }
    assert.equal((await plan(unsafeVard, [input(file)])).statusCode, 200);
    assert.equal((await plan(samePairVard, [input(generated)])).statusCode, 200);
    assert.equal((await plan(duplicateVard, [input(generated)])).statusCode, 409,
      "PUT does not silently rewrite the folder rules");
    successful(await patchRules(duplicateVard, [rule]));
    assert.equal((await plan(duplicateVard, [input(generated)])).statusCode, 200);
  });

  await t.test("the 1000-output limit counts existing manual and generated membership", async () => {
    const file = await makeAsset("limit/existing", "old/1.svg");
    const extra = await makeAsset("limit/extra", "extra.svg");
    const generated = await makeAsset("limit-rule/logo", "generated/logo.svg");
    const vardId = await makeVard([{ sourcePrefix: `${prefix}limit-rule/`, outputPrefix: "generated/" }]);
    await admin.query(
      "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) SELECT 'ws',$1,$2,'old/'||n||'.svg','fixture','fixture' FROM generate_series(1,999) n",
      [vardId, file.assetId],
    );
    assert.equal(successful(await manifest(vardId)).items.length, 1000);
    const before = await snapshot();
    assert.equal(successful(await plan(vardId, [input(file)])).files[0].mappingAction, "keep");
    assert.equal(successful(await plan(vardId, [input(generated)])).files[0].mappingAction, "keep");
    const noop = successful(await apply(vardId, [file, generated]));
    assert.equal(noop.added, 0);
    assert.equal(noop.kept, 2);
    assert.equal((await plan(vardId, [input(extra)])).statusCode, 409);
    assert.equal((await apply(vardId, [extra])).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("real sessions, tenant-scoped keys and action-specific preflight authorization", async () => {
    const file = await makeAsset("auth/existing", "existing.svg");
    const next = futureFile("auth/new", "new.svg");
    const vardId = await makeVard();
    await manual(vardId, file);
    const foreignVardId = randomUUID();
    vardIds.push(foreignVardId);
    await admin.query(
      "INSERT INTO vard(id,workspace_id,name,created_by,updated_by) VALUES($1,'other-ws',$2,'fixture','fixture')",
      [foreignVardId, `Foreign import ${randomUUID()}`],
    );
    const principals: Array<[Record<string, string>, number]> = [
      [{}, 401], [{ cookie: cookies.viewer! }, 403], [{ cookie: cookies.outsider! }, 403],
      [keyHeaders.read!, 401], [keyHeaders.other!, 401], [keyHeaders.revoked!, 401], [keyHeaders.insufficient!, 401],
    ];
    const before = await snapshot();
    for (const [principal, status] of principals) {
      for (const result of [await plan(vardId, [input(file)], principal), await apply(vardId, [file], principal)])
        assert.equal(result.statusCode, status, result.body);
    }
    assert.equal((await plan(vardId, [input(file)], headers, "other-ws")).statusCode, 401);
    assert.equal((await apply(vardId, [file], headers, "other-ws")).statusCode, 401);
    assert.equal((await plan(foreignVardId, [input(file)])).statusCode, 404);
    assert.equal((await apply(foreignVardId, [file])).statusCode, 404);
    successful(await plan(vardId, [input(file)], { cookie: cookies.owner! }));
    successful(await apply(vardId, [file], { cookie: cookies.owner! }));
    const readUpdate = await scopedKey(["read", "update"]);
    const readUpdatePublish = await scopedKey(["read", "update", "publish"]);
    const readUpdateCreate = await scopedKey(["read", "update", "create"]);
    const allRequired = await scopedKey(["read", "update", "create", "publish"]);
    successful(await plan(vardId, [input(file)], readUpdate));
    successful(await apply(vardId, [file], readUpdate));
    assert.equal((await plan(vardId, [input(file, { checksum: "e".repeat(64) })], readUpdate)).statusCode, 401);
    successful(await plan(vardId, [input(file, { checksum: "e".repeat(64) })], readUpdatePublish));
    assert.equal((await plan(vardId, [next], readUpdatePublish)).statusCode, 401, "a new asset requires create");
    assert.equal((await plan(vardId, [next], readUpdateCreate)).statusCode, 401, "every upload requires publish");
    successful(await plan(vardId, [next], allRequired));
    assert.equal((await plan(randomUUID(), [input(file)])).statusCode, 404);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("concurrent additions converge and conflicting writers get a domain conflict", async () => {
    const first = await makeAsset("concurrent/first", "first.svg");
    const second = await makeAsset("concurrent/second", "second.svg");
    const vardId = await makeVard();
    const additions = await Promise.all([apply(vardId, [first]), apply(vardId, [second])]);
    for (const response of additions) assert.equal(successful(response).added, 1);
    assert.equal((await rows(vardId)).length, 2);
    assert.equal((await importedAudit(vardId)).length, 2);
    const retryVard = await makeVard();
    const retries = (await Promise.all([apply(retryVard, [first]), apply(retryVard, [first]), apply(retryVard, [first])])).map(response => successful(response));
    assert.equal(retries.reduce((sum, result) => sum + result.added, 0), 1);
    assert.equal(new Set(retries.map(result => result.files[0].mappingId)).size, 1);
    assert.equal((await rows(retryVard)).length, 1);
    assert.equal((await importedAudit(retryVard)).length, 1);
    const conflictVard = await makeVard();
    const conflict = await Promise.all([
      apply(conflictVard, [{ ...first, outputPath: "occupied.svg" }]),
      apply(conflictVard, [{ ...second, outputPath: "occupied.svg" }]),
    ]);
    assert.deepEqual(conflict.map(response => response.statusCode).sort(), [200, 409]);
    assert.equal((await rows(conflictVard)).length, 1);
    assert.equal((await importedAudit(conflictVard)).length, 1);
  });

  // Observe real PostgreSQL lock waiters rather than timing the JavaScript requests.
  async function waitForContentWaiters(count: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await admin.query(
        "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND classid=74122 AND objid=((hashtext('ws')::bigint & 4294967295)::oid) AND objsubid=2 AND NOT granted",
      );
      if (result.rows[0].count >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`expected ${count} real PostgreSQL waiters on the workspace content guard`);
  }
  async function queued<A, B>(firstAction: () => PromiseLike<A>, secondAction: () => PromiseLike<B>): Promise<[A, B]> {
    const blocker = await admin.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(74122,hashtext('ws'))");
      const first = Promise.resolve().then(firstAction);
      pending.push(first);
      void first.catch(() => {});
      await waitForContentWaiters(1);
      const second = Promise.resolve().then(secondAction);
      pending.push(second);
      void second.catch(() => {});
      await waitForContentWaiters(2);
      await blocker.query("COMMIT");
      return await Promise.all([first, second]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled(pending);
    }
  }

  await t.test("a source-to-use rebind after preflight is rechecked by guarded import commit", async () => {
    const file = await makeAsset("races/live-rebind", "live-rebind.svg");
    const vardId = await makeVard();
    const mappingId = await manual(vardId, file);
    const useId = await makeUse(file);
    assert.equal(successful(await plan(vardId, [input(file)])).files[0].mappingAction, "keep");
    const definition = await editor(vardId);
    const [rebound, refused] = await queued(
      () => bind(vardId, definition.revision, useId, file, mappingId),
      () => apply(vardId, [file]),
    );
    const saved = successful(rebound);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.json().error, /Linked uses are read-only/);
    const mappings = await rows(vardId);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].id, mappingId);
    assert.equal(mappings[0].asset_use_id, useId);
    assert.equal(mappings[0].asset_id, file.assetId);
    assert.equal((await importedAudit(vardId)).length, 0);
    assert.equal((await editor(vardId)).revision, saved.revision,
      "refused import cannot mutate the editor configuration after the rebind");
    const after = await snapshot();
    assert.equal((await apply(vardId, [file])).statusCode, 409);
    assert.deepEqual(await snapshot(), after);
  });

  await t.test("a queued restore or namespace edit invalidates stale apply atomically", async () => {
    const file = await makeAsset("races/restore", "restore.svg");
    const restored = await addVersion(file, { current: false, checksum: "f".repeat(64) });
    const vardId = await makeVard();
    const [restore, stale] = await queued(
      () => app.inject({ method: "POST", url: `/api/workspaces/ws/assets/${file.assetId}/versions/${restored.versionId}/restore`, headers }),
      () => apply(vardId, [file]),
    );
    successful(restore);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal((await rows(vardId)).length, 0);
    assert.equal((await importedAudit(vardId)).length, 0);
    const proposed = futureFile("races/namespace", "namespace.svg");
    const competingId = randomUUID();
    assetIds.push(competingId);
    const [created, staleKey] = await queued(
      () => app.inject({ method: "POST", url: "/api/workspaces/ws/assets", headers,
        payload: { id: competingId, key: proposed.key, displayName: "Competing namespace writer" } }),
      () => plan(vardId, [proposed]),
    );
    successful(created, 201);
    assert.equal(staleKey.statusCode, 409, staleKey.body);
    assert.equal((await rows(vardId)).length, 0);
  });

  await t.test("queued asset and VARD deletions cannot leave orphan or partial mappings", async () => {
    const file = await makeAsset("races/delete", "delete.svg");
    const other = await makeAsset("races/survivor", "survivor.svg");
    const vardId = await makeVard();
    const [removed, failed] = await queued(
      () => app.inject({ method: "DELETE", url: `/api/workspaces/ws/assets/${file.assetId}`, headers }),
      () => apply(vardId, [other, file]),
    );
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal(failed.statusCode, 409, failed.body);
    assert.equal((await rows(vardId)).length, 0);
    assert.equal((await importedAudit(vardId)).length, 0);
    const [removedVard, missing] = await queued(
      () => app.inject({ method: "DELETE", url: `${base}/${vardId}`, headers }),
      () => apply(vardId, [other]),
    );
    assert.equal(removedVard.statusCode, 204, removedVard.body);
    assert.equal(missing.statusCode, 404, missing.body);
    assert.equal((await rows(vardId)).length, 0);
  });

  await t.test("queued rule and manual writers are visible to preflight and apply", async () => {
    const member = await makeAsset("races-rule/logo", "unused.svg");
    const incoming = await makeAsset("races-rule-import/other", "images/logo.svg");
    const vardId = await makeVard();
    const [changedRules, collision] = await queued(
      () => patchRules(vardId, [{ sourcePrefix: `${prefix}races-rule/`, outputPrefix: "images/" }]),
      () => plan(vardId, [input(incoming)]),
    );
    successful(changedRules);
    assert.equal(collision.statusCode, 409, collision.body);
    assert.equal((await rows(vardId)).length, 0);
    const manualVard = await makeVard();
    const [changedManual, failed] = await queued(
      () => app.inject({ method: "PUT", url: `${base}/${manualVard}/items`, headers,
        payload: { items: [{ assetId: member.assetId, outputPath: incoming.outputPath }] } }),
      () => apply(manualVard, [incoming]),
    );
    successful(changedManual);
    assert.equal(failed.statusCode, 409, failed.body);
    assert.equal((await rows(manualVard)).length, 1);
    assert.equal((await rows(manualVard))[0].asset_id, member.assetId);
    assert.equal((await importedAudit(manualVard)).length, 0);
  });

  await t.test("worker current changes share the guard, including an unrelated rule member without deadlock", async () => {
    const { processAsset } = await import("../src/asset-processor.js");
    async function publishBeforeImport(pending: ReadyFile, vardId: string, incoming: ReadyFile, requestId: string) {
      let entered!: () => void;
      let release!: () => void;
      const atObjectRead = new Promise<void>(resolve => { entered = resolve; });
      const objectGate = new Promise<void>(resolve => { release = resolve; });
      const storageKey = (await admin.query("SELECT storage_key FROM asset_version WHERE id=$1", [pending.versionId])).rows[0].storage_key;
      fixture.setReadHook(async key => {
        if (key !== storageKey) return;
        entered();
        await objectGate;
      });
      // Allow the claim transaction to commit before blocking the later ready publication.
      const processing = processAsset({ workspaceId: "ws", assetId: pending.assetId, versionId: pending.versionId, requestId });
      void processing.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([atObjectRead, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("worker did not reach fixture object read")), 5_000);
        })]);
        if (timer) clearTimeout(timer);
        return await queued(
          () => { release(); return processing; },
          () => apply(vardId, [incoming]),
        );
      } finally {
        if (timer) clearTimeout(timer);
        release();
        fixture.setReadHook(async () => {});
        await processing;
      }
    }
    const first = await makeAsset("races-worker/current", "worker.svg");
    const pending = await addVersion(first, { current: false, status: "pending" });
    const vardId = await makeVard();
    const [processed, stale] = await publishBeforeImport(pending, vardId, first, "vard-import-worker-race");
    assert.equal(processed, undefined);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal((await admin.query("SELECT status FROM asset_version WHERE id=$1", [pending.versionId])).rows[0].status, "ready");
    assert.equal((await rows(vardId)).length, 0);
    const unrelated = await makeAsset("races-worker-rule/logo", "unused.svg", { mimeType: "image/png" });
    const next = await addVersion(input(unrelated, { mimeType: "image/svg+xml" }), { current: false, status: "pending" });
    const incoming = await makeAsset("races-worker-import/other", "images/logo.svg");
    const ruleVard = await makeVard([{ sourcePrefix: `${prefix}races-worker-rule/`, outputPrefix: "images/" }]);
    assert.equal(successful(await plan(ruleVard, [input(incoming)])).files[0].mappingAction, "add");
    const [unrelatedProcessed, collision] = await publishBeforeImport(next, ruleVard, incoming, "vard-import-unrelated-worker-race");
    assert.equal(unrelatedProcessed, undefined);
    assert.equal(collision.statusCode, 409, collision.body);
    assert.equal((await admin.query("SELECT current_version_id FROM asset WHERE id=$1", [unrelated.assetId])).rows[0].current_version_id, next.versionId);
    assert.equal((await rows(ruleVard)).length, 0);
    assert.equal((await importedAudit(ruleVard)).length, 0);
  });
}
