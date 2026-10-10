import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { folderItemId } from "./vard-folder-rules.js";
import { assertImportIdentities, importMappings, resolveImportOutputs, vardImportBody, vardImportPlanBody } from "./vard-import.js";

const file = {
  assetId: randomUUID(), key: "brand/logo", outputPath: "assets/logo.png",
  checksum: "a".repeat(64), mimeType: "image/png" as const, size: 100,
};
const rules = [{ sourcePrefix: "brand/", outputPrefix: "assets/" }];

test("import UUID identities normalize before lookup and mixed-case duplicate checks", () => {
  const assetId = "abcdef12-3456-4789-abcd-ef1234567890";
  const versionId = "fedcba12-3456-4789-abcd-ef1234567890";
  const plan = vardImportPlanBody.parse({ files: [{ ...file, assetId: assetId.toUpperCase() }] });
  assert.equal(plan.files[0]!.assetId, assetId);
  const apply = vardImportBody.parse({ files: [{
    ...file, assetId: assetId.toUpperCase(), versionId: versionId.toUpperCase(),
  }] });
  assert.equal(apply.files[0]!.assetId, assetId);
  assert.equal(apply.files[0]!.versionId, versionId);
  const repeated = vardImportPlanBody.parse({ files: [
    { ...file, assetId },
    { ...file, assetId: assetId.toUpperCase(), key: "brand/other", outputPath: "assets/other.png" },
  ] });
  assert.throws(() => assertImportIdentities(repeated.files), /distinct asset identities/);
  assert.deepEqual(importMappings([{
    id: "original-mapping", assetId, outputPath: file.outputPath,
  }], [], [], plan.files), [{ mappingAction: "keep", mappingId: "original-mapping" }]);
});

test("folder import requests are strict, bounded source declarations", () => {
  assert.equal(vardImportPlanBody.safeParse({ files: [file] }).success, true);
  assert.equal(vardImportBody.safeParse({ files: [{ ...file, versionId: randomUUID() }] }).success, true);
  for (const body of [
    { files: [] },
    { files: Array.from({ length: 1001 }, () => file) },
    { files: [file], force: true },
    { files: [{ ...file, versionId: randomUUID() }] },
    { files: [{ ...file, size: 0 }] },
    { files: [{ ...file, size: 100.5 }] },
    { files: [{ ...file, size: Number.MAX_SAFE_INTEGER }] },
    { files: [{ ...file, checksum: "A".repeat(64) }] },
    { files: [{ ...file, mimeType: "application/octet-stream" }] },
    { files: [{ ...file, key: "Brand/logo" }] },
    { files: [{ ...file, outputPath: "../escape.png" }] },
  ]) assert.equal(vardImportPlanBody.safeParse(body).success, false, JSON.stringify(body).slice(0, 150));
  assert.equal(vardImportBody.safeParse({ files: [file] }).success, false);
  assert.equal(vardImportBody.safeParse({ files: [{ ...file, versionId: null }] }).success, false);
});

test("new rule members keep generated IDs and changed source MIME projects every output", () => {
  assert.deepEqual(importMappings([], [file], rules, [file]), [{
    mappingAction: "keep", mappingId: folderItemId(file.assetId, "assets/logo.png"),
  }]);
  const changed = { ...file, mimeType: "image/webp" as const, outputPath: "assets/logo.webp" };
  const union = resolveImportOutputs([], [changed], [
    ...rules, { sourcePrefix: "", outputPrefix: "archive/" },
  ]);
  assert.deepEqual([...union.keys()], ["assets/logo.webp", "archive/brand/logo.webp"]);
  assert.deepEqual(importMappings([], [changed], rules, [changed]), [{
    mappingAction: "keep", mappingId: folderItemId(file.assetId, "assets/logo.webp"),
  }]);
  assert.deepEqual(importMappings([], [file], rules, [{ ...file, outputPath: "other/logo.png" }]), [{
    mappingAction: "add", mappingId: null,
  }]);
});

test("an incoming exact manual equivalent preserves the complete original record", () => {
  const original = { id: randomUUID(), assetId: file.assetId, outputPath: file.outputPath,
    versionId: randomUUID(), transformation: { width: 24 }, writable: false };
  const union = resolveImportOutputs([original], [], []);
  assert.equal(union.size, 1);
  assert.equal(union.get(file.outputPath), original);
  assert.deepEqual(importMappings([original], [], [], [file]), [{ mappingAction: "keep", mappingId: original.id }]);
  const writable = { ...original, versionId: null, transformation: null, writable: true };
  assert.equal(resolveImportOutputs([writable], [], []).get(file.outputPath), writable);
  assert.throws(() => resolveImportOutputs([original], [file], rules), /collide/);
  assert.throws(() => resolveImportOutputs([], [file], [...rules, ...rules]), /collide/);
});

test("prospective union rejects identity, spelling, file/directory and hidden generated conflicts", () => {
  const other = { id: randomUUID(), assetId: randomUUID(), outputPath: file.outputPath };
  assert.throws(() => importMappings([other], [], [], [file]), /another asset/);
  for (const outputPath of ["assets/LOGO.png", "assets", "assets/logo.png/nested.png"])
    assert.throws(() => importMappings([{ ...other, outputPath }], [], [], [file]), /Vard/);
  const unicode = { ...file, outputPath: "café.png" };
  assert.throws(() => importMappings([{ ...other, outputPath: "cafe\u0301.png" }], [], [], [unicode]), /Vard/);
  assert.throws(() => resolveImportOutputs([{ ...other, outputPath: "archive/brand/logo.png" }], [file], [
    ...rules, { sourcePrefix: "", outputPrefix: "archive/" },
  ]), /collide/);
  assert.throws(() => resolveImportOutputs([{ ...other, outputPath: "vardum.json" }], [], []), /unsafe/);
});

test("full union accepts exactly 1000 outputs and never truncates generated or manual additions", () => {
  const manual = Array.from({ length: 999 }, (_, index) => ({
    id: randomUUID(), assetId: randomUUID(), outputPath: `existing/${index}.png`,
  }));
  assert.equal(resolveImportOutputs(manual, [file], rules).size, 1000);
  assert.throws(() => importMappings(manual, [file], rules, [{ ...file, outputPath: "extra.png" }]), /more than 1000/);
  assert.throws(() => resolveImportOutputs(manual, [file], [
    ...rules, { sourcePrefix: "", outputPrefix: "archive/" },
  ]), /more than 1000/);
  const sources = Array.from({ length: 1001 }, (_, index) => ({
    assetId: randomUUID(), key: `brand/${index}`, mimeType: "image/png",
  }));
  assert.throws(() => resolveImportOutputs([], sources, rules), /more than 1000/);
});
