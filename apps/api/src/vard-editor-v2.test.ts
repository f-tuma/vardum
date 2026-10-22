import assert from "node:assert/strict";
import type { VardFolderRuleV2 } from "@vardum/shared";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildApp } from "./app.js";
import { asset, assetUse, assetVersion, auditEvent, vard, vardItem,
  type VardTransformation } from "./db/app-schema.js";
import type { Transaction } from "./db/tenant.js";
import { folderRulesSchema } from "./vard-folder-rules.js";
import {
  editableStateV2, editorGetQuery, editorPayloadV2, patchEditorV2,
  replaceEditorItemsV2, v2DeleteQuery, v2ItemInput, v2ItemsBody, v2PatchBody,
  VardEditorV2Error, type V2ItemInput,
} from "./vard-editor-v2.js";

const principal = { actorType: "api_key" as const, actorId: "editor-key",
  reference: "api_key:editor-key", organizationId: "org" };
const validRevision = `v2:${"a".repeat(64)}`;
const timestamp = "2026-10-22T10:20:30.123456Z";
type SourceRow = { id: string; key: string; displayName: string; isPublic: boolean; currentVersionId: string | null };
type VersionRow = { id: string; assetId: string; status: string; mimeType: string;
  checksum: string; size: number; width: number; height: number };
type ItemRow = { id: string; assetId: string; assetUseId: string | null; versionId: string | null;
  outputPath: string; transformation: VardTransformation | null; writable: boolean;
  definitionSchema: 1 | 2 | 3; createdBy: string; updatedBy: string;
  createdAtText: string; updatedAtText: string };
type UseRow = { id: string; sourceAssetId: string; key: string; displayName: string;
  transformation: VardTransformation | null; outputMimeType: string; revision: number };
type Write = { action: "update" | "insert" | "delete"; table: unknown; values?: Record<string, unknown>[] };

// This fixture exercises the exported orchestration with literal and hydrated
// projections kept separate. Real PostgreSQL constraints/races belong to the
// integration fixtures; this intentionally does not simulate their guarantees.
function fixture(marker: 1 | 2 | 3 = 1) {
  const record = {
    id: randomUUID(), workspaceId: "ws", name: "Literal definition", isPublic: true,
    folderRules: [] as VardFolderRuleV2[],
    definitionSchema: marker, updatedAt: new Date(timestamp), createdBy: "original",
    updatedBy: "original", createdAtText: timestamp, updatedAtText: timestamp,
  };
  const items: ItemRow[] = [], sources: SourceRow[] = [], versions: VersionRow[] = [], uses: UseRow[] = [];
  const writes: Write[] = [], audits: Record<string, unknown>[] = [];
  const dialect = new PgDialect();
  const params = (condition?: SQL) => condition ? dialect.sqlToQuery(condition).params : [];
  const textTime = (value: unknown) => value instanceof Date
    ? value.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z")
    : value && typeof value === "object" ? String(dialect.sqlToQuery(value as SQL).params[0]) : timestamp;
  function addSource(key = "source.png") {
    const source = { id: randomUUID(), key, displayName: "Source", isPublic: true, currentVersionId: randomUUID() };
    sources.push(source);
    versions.push({ id: source.currentVersionId, assetId: source.id, status: "ready", mimeType: "image/png",
      checksum: "b".repeat(64), size: 24, width: 32, height: 16 });
    return source;
  }
  function addItem(source: SourceRow, outputPath = source.key, extra: Partial<ItemRow> = {}) {
    const row: ItemRow = { id: randomUUID(), assetId: source.id, assetUseId: null, versionId: null,
      outputPath, transformation: null, writable: false, definitionSchema: record.definitionSchema,
      createdBy: "original", updatedBy: "original", createdAtText: timestamp, updatedAtText: timestamp, ...extra };
    items.push(row); return row;
  }
  function addUse(source: SourceRow, extra: Partial<UseRow> = {}) {
    const row: UseRow = { id: randomUUID(), sourceAssetId: source.id, key: "linked.png",
      displayName: "Linked use", transformation: null, outputMimeType: "image/png", revision: 1, ...extra };
    uses.push(row); return row;
  }
  function joinedUse(use: UseRow) {
    const source = sources.find((row) => row.id === use.sourceAssetId)!;
    const current = versions.find((row) => row.id === source.currentVersionId && row.status === "ready");
    return { ...use, updatedAt: new Date(timestamp), sourceKey: source.key,
      sourceDisplayName: source.displayName, isPublic: source.isPublic, currentVersionId: source.currentVersionId,
      sourceMimeType: current?.mimeType ?? null, sourceWidth: current?.width ?? null,
      sourceHeight: current?.height ?? null, sourceProcessing: false };
  }
  function projected(fields: Record<string, unknown>, row: Record<string, unknown>) {
    return Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));
  }
  function queryResult(run: () => unknown[]) {
    return { then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve().then(run).then(resolve, reject);
    } };
  }
  const tx = {
    select(fields: Record<string, unknown>) {
      let table: unknown, condition: SQL | undefined;
      const query = {
        from(value: unknown) { table = value; return query; },
        innerJoin() { return query; }, leftJoin() { return query; },
        where(value: SQL) { condition = value; return query; },
        orderBy() { return query; }, limit() { return query; }, $dynamic() { return query; },
        then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => {
            const ids = params(condition);
            let rows: Record<string, unknown>[];
            if (table === vard) rows = [{ ...record, workspaceSlug: "workspace" }];
            else if (table === vardItem) rows = items.map((row) => {
              const source = sources.find((candidate) => candidate.id === row.assetId)!;
              return { ...row, key: source.key, isPublic: source.isPublic,
                pinnedVersionId: row.versionId, currentVersionId: source.currentVersionId };
            });
            else if (table === asset) rows = sources.filter((row) => ids.includes(row.id));
            else if (table === assetUse) rows = uses.filter((row) => ids.includes(row.id)).map(joinedUse);
            else if (table === assetVersion) rows = versions.filter((row) => ids.includes(row.id));
            else throw new Error("Unexpected editor query table");
            return rows.map((row) => projected(fields, row));
          }).then(resolve, reject);
        },
      };
      return query;
    },
    update(table: unknown) {
      return { set(values: Record<string, unknown>) { return { where(condition: SQL) {
        return queryResult(() => {
          writes.push({ action: "update", table, values: [values] });
          if (table === vard) {
            Object.assign(record, values);
            if (values.updatedAt) record.updatedAtText = textTime(values.updatedAt);
            if (values.definitionSchema) for (const item of items) item.definitionSchema = values.definitionSchema as 1 | 2 | 3;
          } else if (table === vardItem) {
            for (const row of items.filter((item) => params(condition).includes(item.id))) {
              Object.assign(row, values);
              if (values.updatedAt) row.updatedAtText = textTime(values.updatedAt);
            }
          } else throw new Error("Unexpected editor update table");
          return [];
        });
      } }; } };
    },
    insert(table: unknown) {
      return { values(input: Record<string, unknown> | Record<string, unknown>[]) {
        const values = Array.isArray(input) ? input : [input];
        return queryResult(() => {
          writes.push({ action: "insert", table, values });
          if (table === auditEvent) audits.push(...values);
          else if (table === vardItem) for (const value of values) {
            const createdAtText = value.createdAt ? textTime(value.createdAt) : timestamp;
            items.push({ ...value, createdAtText, updatedAtText: textTime(value.updatedAt) } as ItemRow);
          } else throw new Error("Unexpected editor insert table");
          return [];
        });
      } };
    },
    delete(table: unknown) {
      return { where(condition: SQL) { return queryResult(() => {
        writes.push({ action: "delete", table });
        if (table !== vardItem) throw new Error("Unexpected editor delete table");
        const ids = params(condition);
        for (let index = items.length - 1; index >= 0; index--)
          if (ids.includes(items[index]!.id)) items.splice(index, 1);
        return [];
      }); } };
    },
  } as unknown as Transaction;
  const state = () => editableStateV2(tx, "ws", record.id);
  const save = async (desired: V2ItemInput[], expectedRevision?: string) => replaceEditorItemsV2(
    tx, "ws", record.id, { definitionSchema: 2, expectedRevision: expectedRevision ?? (await state()).revision,
      items: desired }, principal, "request");
  return { record, items, sources, versions, uses, writes, audits, tx, addSource, addItem, addUse, state, save };
}
function sourceInput(row: ItemRow): V2ItemInput {
  return { id: row.id, outputPath: row.outputPath, binding: { kind: "source", assetId: row.assetId,
    versionId: row.versionId, transformation: row.transformation, writable: row.writable } };
}
function useInput(row: ItemRow, assetUseId = row.assetUseId!): V2ItemInput {
  return { id: row.id, outputPath: row.outputPath, binding: { kind: "use", assetUseId } };
}
const errorCode = (code: string) => (error: unknown) => error instanceof VardEditorV2Error && error.code === code;

test("wire2 admits explicit folder use intent while opt-out restores the legacy rule shape", () => {
  const rule = { sourcePrefix: "brand/", outputPrefix: "public/" };
  const patch = (extra: Record<string, unknown>) => ({ definitionSchema: 2,
    expectedRevision: validRevision, folderRules: [{ ...rule, ...extra }] });
  assert.deepEqual(v2PatchBody.parse(patch({ includeUses: true })).folderRules,
    [{ ...rule, includeUses: true }]);
  assert.deepEqual(v2PatchBody.parse(patch({ includeUses: false })).folderRules, [rule]);
  assert.deepEqual(v2PatchBody.parse(patch({})).folderRules, [rule]);
  assert.equal(folderRulesSchema.safeParse([{ ...rule, includeUses: true }]).success, false);
  for (const extra of [{ includeUses: "true" }, { includeUses: null }, { includeUses: 1 },
    { includeUses: true, copiedRecipe: {} }])
    assert.equal(v2PatchBody.safeParse(patch(extra)).success, false);
});

test("first folder opt-in promotes source/direct-use definitions to3 and later item writes preserve3", async () => {
  for (const marker of [1, 2] as const) {
    const f = fixture(marker), source = f.addSource(), use = f.addUse(source);
    const item = f.addItem(source);
    const before = (await f.state()).revision;
    const promoted = await patchEditorV2(f.tx, "ws", f.record.id,
      { definitionSchema: 2, expectedRevision: before,
        folderRules: [{ sourcePrefix: "brand/", outputPrefix: "public/", includeUses: true }] }, principal, "request");
    assert.equal(promoted.storedDefinitionSchema, 3);
    assert.equal(item.definitionSchema, 3);
    assert.notEqual(promoted.revision, before);
    const added = await f.save([sourceInput(item), { id: null, outputPath: "linked.png",
      binding: { kind: "use", assetUseId: use.id } }]);
    assert.equal(added.storedDefinitionSchema, 3);
    assert.ok(f.items.every(row => row.definitionSchema === 3));
    const disabled = await patchEditorV2(f.tx, "ws", f.record.id,
      v2PatchBody.parse({ definitionSchema: 2, expectedRevision: added.revision,
        folderRules: [{ sourcePrefix: "brand/", outputPrefix: "public/", includeUses: false }] }), principal, "request");
    assert.equal(disabled.storedDefinitionSchema, 3, "opting out never silently reopens older writers");
    assert.deepEqual(disabled.folderRules, [{ sourcePrefix: "brand/", outputPrefix: "public/" }]);
  }
});

test("stored3 unsafe downgrade refuses atomically and historical false is removed even without folderRules in PATCH", async () => {
  const f = fixture(3), source = f.addSource(), item = f.addItem(source);
  f.record.folderRules = [{ sourcePrefix: "brand/", outputPrefix: "public/", includeUses: true }];
  await assert.rejects(patchEditorV2(f.tx, "ws", f.record.id,
    { definitionSchema: 2, expectedRevision: (await f.state()).revision,
      name: "Must not persist", returnToSourceOnly: true }, principal, "request"),
  errorCode("vard_definition_has_bindings"));
  assert.equal(f.writes.length, 0);
  assert.equal(f.record.name, "Literal definition");
  // This literal already existed under A; the new request intentionally omits rules.
  f.record.folderRules = [{ sourcePrefix: "brand/", outputPrefix: "public/", includeUses: false }];
  const result = await patchEditorV2(f.tx, "ws", f.record.id,
    { definitionSchema: 2, expectedRevision: (await f.state()).revision,
      returnToSourceOnly: true }, principal, "request");
  assert.equal(result.storedDefinitionSchema, 1);
  assert.equal(item.definitionSchema, 1);
  assert.deepEqual(result.folderRules, [{ sourcePrefix: "brand/", outputPrefix: "public/" }]);
  assert.deepEqual(folderRulesSchema.parse(result.folderRules), result.folderRules,
    "the explicit downgrade is a real legacy round-trip subset");
  assert.equal(result.items[0]!.id, item.id);
  assert.equal(result.items[0]!.outputPath, source.key);
  assert.equal(item.createdAtText, timestamp);
});

test("folder-use live membership and recipe state never enter the literal editor revision", async () => {
  const f = fixture(3);
  f.record.folderRules = [{ sourcePrefix: "brand/", outputPrefix: "public/", includeUses: true }];
  const revision = (await f.state()).revision;
  const source = f.addSource("outside/logo.png"), use = f.addUse(source);
  use.key = "brand/linked.png";
  use.transformation = { w: 64, h: 48, fit: "contain", format: "png", pad: 12.5 };
  use.revision++;
  source.currentVersionId = randomUUID();
  assert.equal((await f.state()).revision, revision);
  f.uses.pop();
  assert.equal((await f.state()).revision, revision, "live member removal changes the manifest, not configuration");
});

test("editor HTTP routes reject malformed protocol shapes before authorization", async () => {
  const app = await buildApp();
  const base = `/api/workspaces/ws/vards/${randomUUID()}/editor`;
  const oldRevision = `v1:${"a".repeat(64)}`;
  try {
    const invalid = [
      ...["1", "02", "2.0"].map((value) => ({ method: "GET" as const, url: `${base}?definitionSchema=${value}` })),
      { method: "DELETE" as const, url: `${base}?expectedRevision=${validRevision}` },
      { method: "DELETE" as const, url: `${base}?definitionSchema=2&expectedRevision=${oldRevision}` },
      { method: "DELETE" as const, url: `${base}?definitionSchema=2` },
      { method: "PATCH" as const, url: base, payload: {
        definitionSchema: 2, expectedRevision: validRevision, name: "Copied resolution", transformation: null,
      } },
      { method: "PATCH" as const, url: base, payload: {
        definitionSchema: 2, expectedRevision: validRevision, returnToSourceOnly: false,
      } },
      { method: "PUT" as const, url: `${base}/items`, payload: {
        definitionSchema: 2, expectedRevision: validRevision,
        items: [{ id: null, outputPath: "icon.png", binding: { kind: "use", assetUseId: randomUUID(), writable: false } }],
      } },
    ];
    for (const request of invalid) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 400, `${request.method} ${request.url}: ${response.body}`);
    }
    // No cookie is a complete authorization refusal and does not look up a
    // workspace. These exercise both valid dispatch shapes without a database.
    for (const url of [base, `${base}?definitionSchema=2`]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 401, response.body);
      assert.deepEqual(response.json(), { error: "Unauthorized" });
    }
  } finally { await app.close(); }
});

test("schema2 input preserves literal bindings and rejects mixed protocols or copied effective fields", () => {
  const source = { kind: "source", assetId: randomUUID(), versionId: null, transformation: null, writable: false };
  const use = { kind: "use", assetUseId: randomUUID() };
  const item = { id: null, outputPath: "icon.png", binding: use };
  assert.equal(v2ItemInput.safeParse(item).success, true);
  assert.equal(v2ItemInput.safeParse({ ...item, binding: source }).success, true);
  for (const field of ["assetId", "versionId", "transformation", "writable"])
    assert.equal(v2ItemInput.safeParse({ ...item, binding: { ...use, [field]: source[field as keyof typeof source] } }).success, false, field);
  for (const field of ["versionId", "transformation", "writable"]) {
    const binding = { ...source }; delete binding[field as keyof typeof binding];
    assert.equal(v2ItemInput.safeParse({ ...item, binding }).success, false, `missing ${field}`);
  }
  for (const body of [
    { expectedRevision: validRevision, items: [item] },
    { definitionSchema: 1, expectedRevision: validRevision, items: [item] },
    { definitionSchema: 2, expectedRevision: `v1:${"a".repeat(64)}`, items: [item] },
    { definitionSchema: 2, expectedRevision: validRevision, items: [item], returnToSourceOnly: true },
    { definitionSchema: 2, expectedRevision: validRevision, items: [{ ...item, transformation: null }] },
  ]) assert.equal(v2ItemsBody.safeParse(body).success, false);
  assert.equal(v2PatchBody.safeParse({ definitionSchema: 2, expectedRevision: validRevision, returnToSourceOnly: true }).success, true);
  for (const fields of [{}, { returnToSourceOnly: false }, { returnToSourceOnly: true, items: [] }])
    assert.equal(v2PatchBody.safeParse({ definitionSchema: 2, expectedRevision: validRevision, ...fields }).success, false);
  assert.deepEqual(editorGetQuery.parse({}), {});
  assert.deepEqual(editorGetQuery.parse({ definitionSchema: "2" }), { definitionSchema: 2 });
  for (const discriminator of ["1", "02", "2.0", " 2", "2 ", 2, true]) {
    assert.equal(editorGetQuery.safeParse({ definitionSchema: discriminator }).success, false);
    assert.equal(v2DeleteQuery.safeParse({ definitionSchema: discriminator, expectedRevision: validRevision }).success, false);
  }
  assert.equal(v2DeleteQuery.safeParse({ definitionSchema: "2", expectedRevision: validRevision }).success, true);
  assert.equal(v2DeleteQuery.safeParse({ definitionSchema: "2", expectedRevision: validRevision, force: true }).success, false);
});

test("revision uses literal use identity and PostgreSQL microseconds, excluding live settings and source state", async () => {
  const f = fixture(2), source = f.addSource(), use = f.addUse(source), item = f.addItem(source, "icon.png", { assetUseId: use.id });
  const revision = (await f.state()).revision;
  use.transformation = { w: 20, h: 20, fit: "contain", format: "png", pad: 12.5, render: "v2", bg: "#abcdef" };
  use.revision++; use.key = "renamed.png"; use.displayName = "New label";
  source.currentVersionId = randomUUID(); source.isPublic = false;
  assert.equal((await f.state()).revision, revision);
  item.assetUseId = randomUUID();
  assert.notEqual((await f.state()).revision, revision, "a same-source rebind changes literal identity");
  item.assetUseId = use.id;
  item.createdAtText = "2026-10-22T10:20:30.123457Z";
  assert.notEqual((await f.state()).revision, revision, "one PostgreSQL microsecond is retained");
  item.createdAtText = timestamp;
  f.record.updatedAtText = "2026-10-22T10:20:30.123457Z";
  assert.notEqual((await f.state()).revision, revision);
});

test("editor separates a literal use binding from its full effective recipe and canonical source", async () => {
  const f = fixture(2), source = f.addSource();
  const recipe: VardTransformation = { w: 24, h: 24, fit: "contain", format: "png", pad: 12.5, bg: "#abcdef" };
  const use = f.addUse(source, { transformation: recipe });
  const item = f.addItem(source, "icon.png", { assetUseId: use.id });
  const payload = await editorPayloadV2(f.tx, "ws", f.record.id);
  assert.deepEqual(payload.items[0]!.binding, { kind: "use", assetUseId: use.id });
  assert.deepEqual(payload.items[0]!.resolved.transformation, recipe);
  assert.equal(payload.items[0]!.resolved.assetId, source.id);
  assert.equal(payload.items[0]!.resolved.key, source.key);
  assert.equal(payload.items[0]!.id, item.id);
  assert.equal(payload.items[0]!.resolved.writable, false);
  assert.match(payload.items[0]!.resolved.downloadUrl!, /\/__v\//);
  assert.doesNotMatch(payload.items[0]!.resolved.downloadUrl!, new RegExp(use.id));
  assert.equal(item.transformation, null, "resolution must not persist the live recipe");
});

test("stale and unsafe explicit downgrade refuse before mutation; safe downgrade cascades the literal markers", async () => {
  const f = fixture(2), source = f.addSource(), use = f.addUse(source);
  f.addItem(source, "icon.png", { assetUseId: use.id });
  const current = (await f.state()).revision;
  await assert.rejects(patchEditorV2(f.tx, "ws", f.record.id,
    { definitionSchema: 2, expectedRevision: validRevision, returnToSourceOnly: true }, principal, "request"),
  errorCode("vard_revision_conflict"));
  await assert.rejects(patchEditorV2(f.tx, "ws", f.record.id,
    { definitionSchema: 2, expectedRevision: current, returnToSourceOnly: true, name: "Must not persist" }, principal, "request"),
  errorCode("vard_definition_has_bindings"));
  assert.equal(f.writes.length, 0);
  assert.equal(f.record.name, "Literal definition");
  f.items[0]!.assetUseId = null;
  const result = await patchEditorV2(f.tx, "ws", f.record.id,
    { definitionSchema: 2, expectedRevision: (await f.state()).revision, returnToSourceOnly: true }, principal, "request");
  assert.equal(result.storedDefinitionSchema, 1);
  assert.equal(f.items[0]!.definitionSchema, 1);
  assert.equal(f.audits.length, 1);
  f.writes.length = 0;
  await patchEditorV2(f.tx, "ws", f.record.id,
    { definitionSchema: 2, expectedRevision: result.revision, returnToSourceOnly: true }, principal, "request");
  assert.equal(f.writes.length, 0, "already source-only intent is a no-op");
});

test("retained unavailable use round-trips without writes while a new use binding is refused", async () => {
  const f = fixture(2), source = f.addSource(), use = f.addUse(source);
  const item = f.addItem(source, "icon.png", { assetUseId: use.id });
  f.versions[0]!.status = "failed";
  const before = structuredClone(item), revision = (await f.state()).revision;
  const result = await f.save([useInput(item)], revision);
  assert.equal(result.revision, revision);
  assert.deepEqual(item, before);
  assert.equal(f.writes.length, 0);
  assert.equal(result.items[0]!.resolved.versionId, null);
  assert.equal(result.items[0]!.resolved.downloadUrl, null);
  await assert.rejects(f.save([{ id: null, outputPath: "new.png", binding: { kind: "use", assetUseId: use.id } }]),
    errorCode("linked_use_unavailable"));
  assert.equal(f.writes.length, 0);
});

test("a retained unavailable literal source pin remains repairable but a newly assigned failed pin is refused", async () => {
  const f = fixture(), source = f.addSource();
  const item = f.addItem(source, "icon.png", { versionId: f.versions[0]!.id });
  f.versions[0]!.status = "failed";
  await f.save([sourceInput(item)]);
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.save([{ ...sourceInput(item), id: null }]),
    (error: unknown) => error instanceof VardEditorV2Error && error.status === 400);
  assert.equal(f.writes.length, 0);
});

test("stale replacement, foreign manual IDs and duplicate paths leave every literal row unchanged", async () => {
  const f = fixture(2), source = f.addSource(), use = f.addUse(source);
  const item = f.addItem(source, "icon.png", { assetUseId: use.id });
  const before = structuredClone(f.items);
  await assert.rejects(f.save([], validRevision), errorCode("vard_revision_conflict"));
  for (const desired of [
    [{ ...useInput(item), id: randomUUID() }],
    [useInput(item), { ...useInput(item), outputPath: "other.png" }],
    [useInput(item), { id: null, outputPath: "ICON.png", binding: { kind: "use" as const, assetUseId: use.id } }],
    [{ ...useInput(item), binding: { kind: "use" as const, assetUseId: randomUUID() } }],
  ]) await assert.rejects(f.save(desired),
    (error: unknown) => error instanceof VardEditorV2Error && error.status === 400);
  assert.deepEqual(f.items, before);
  assert.equal(f.writes.length, 0);
});

test("rebind validates the new use and records a different literal identity even with equal effective recipe", async () => {
  const f = fixture(2), source = f.addSource(), use = f.addUse(source);
  const item = f.addItem(source, "icon.png", { assetUseId: use.id });
  const otherSource = f.addSource("failed.png"), unavailable = f.addUse(otherSource, { key: "failed-use.png" });
  f.versions.find((version) => version.assetId === otherSource.id)!.status = "failed";
  await assert.rejects(f.save([useInput(item, unavailable.id)]), errorCode("linked_use_unavailable"));
  assert.equal(f.writes.length, 0);
  const alternative = f.addUse(source, { key: "same-source.png" });
  const before = (await f.state()).revision;
  const payload = await f.save([useInput(item, alternative.id)], before);
  assert.notEqual(payload.revision, before);
  assert.equal(f.items[0]!.assetUseId, alternative.id);
  assert.equal(f.items[0]!.assetId, source.id);
  assert.equal(f.items[0]!.transformation, null);
  assert.equal(f.items[0]!.createdAtText, timestamp);
  assert.equal(f.audits.length, 1);
});

test("first binding upgrades before insertion and every new child uses the parent marker", async () => {
  const f = fixture(), source = f.addSource(), use = f.addUse(source);
  const retained = f.addItem(source, "retained.png");
  const creation = retained.createdAtText;
  await f.save([sourceInput(retained),
    { id: null, outputPath: "linked.png", binding: { kind: "use", assetUseId: use.id } },
    { id: null, outputPath: "source.png", binding: { kind: "source", assetId: source.id, versionId: null, transformation: null, writable: false } },
  ]);
  assert.equal(f.record.definitionSchema, 2);
  assert.ok(f.items.every((item) => item.definitionSchema === 2));
  assert.equal(f.items.find((item) => item.id === retained.id)!.createdAtText, creation);
  const bound = f.items.find((item) => item.assetUseId === use.id)!;
  assert.equal(bound.assetId, source.id);
  assert.equal(bound.versionId, null);
  assert.equal(bound.transformation, null);
  assert.equal(bound.writable, false);
  const upgrade = f.writes.findIndex((write) => write.table === vard && write.values?.some((value) => value.definitionSchema === 2));
  const insert = f.writes.findIndex((write) => write.action === "insert" && write.table === vardItem);
  assert.ok(upgrade >= 0 && upgrade < insert, "parent marker must change before the first child insert");
});

test("path swaps retain manual identities and exact creation metadata; final removal stays marker2", async () => {
  const f = fixture(2), source = f.addSource(), use = f.addUse(source);
  const a = f.addItem(source, "a.png", { assetUseId: use.id }), b = f.addItem(source, "b.png");
  const original = new Map(f.items.map((item) => [item.id, { createdAtText: item.createdAtText, createdBy: item.createdBy }]));
  await f.save([{ ...useInput(a), outputPath: "b.png" }, { ...sourceInput(b), outputPath: "a.png" }]);
  assert.deepEqual(new Set(f.items.map((item) => item.id)), new Set([a.id, b.id]));
  for (const item of f.items) assert.deepEqual({ createdAtText: item.createdAtText, createdBy: item.createdBy }, original.get(item.id));
  const sourceRow = f.items.find((item) => item.id === b.id)!;
  await f.save([sourceInput(sourceRow)]);
  assert.equal(f.items.length, 1);
  assert.equal(f.record.definitionSchema, 2, "removing the final use must not silently downgrade");
  assert.equal(f.items[0]!.definitionSchema, 2);
});
