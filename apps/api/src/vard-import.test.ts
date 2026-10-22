import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { folderItemId, folderUseItemId, resolveFolderMembership } from "./vard-folder-rules.js";
import { assertImportIdentities, importMappings, resolveImportOutputs, vardImportBody, vardImportPlanBody } from "./vard-import.js";

const file = {
  assetId: randomUUID(), key: "brand/logo", outputPath: "assets/logo.png",
  checksum: "a".repeat(64), mimeType: "image/png" as const, size: 100,
};
const rules = [{ sourcePrefix: "brand/", outputPrefix: "assets/" }];
const sourceBinding = { bindingKind: "source" as const, assetUseId: null };

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
    id: "original-mapping", assetId, outputPath: file.outputPath, ...sourceBinding,
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
  assert.ok([...union.values()].every((item) => item.bindingKind === "source" && item.assetUseId === null));
  assert.deepEqual(importMappings([], [changed], rules, [changed]), [{
    mappingAction: "keep", mappingId: folderItemId(file.assetId, "assets/logo.webp"),
  }]);
  assert.deepEqual(importMappings([], [file], rules, [{ ...file, outputPath: "other/logo.png" }]), [{
    mappingAction: "add", mappingId: null,
  }]);
});

test("an incoming exact manual equivalent preserves the complete original record", () => {
  const original = { id: randomUUID(), assetId: file.assetId, outputPath: file.outputPath,
    ...sourceBinding,
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

test("a live-use destination is read-only even for the identical Original source import", () => {
  for (const transformation of [null, { width: 24 }]) {
    const linked = { id: randomUUID(), assetId: file.assetId, outputPath: file.outputPath,
      bindingKind: "use" as const, assetUseId: randomUUID(),
      versionId: null, transformation, writable: false };
    assert.equal(resolveImportOutputs([linked], [], []).get(file.outputPath), linked);
    assert.throws(() => importMappings([linked], [], [], [file]), /Linked uses are read-only/);
    assert.throws(() => importMappings([linked], [], [], [{ ...file, assetId: randomUUID() }]),
      /Linked uses are read-only/, "binding refusal takes precedence over source equality");
    assert.throws(() => importMappings([linked], [], [], [
      { ...file, outputPath: "additional.png" }, file,
    ]), /Linked uses are read-only/, "one linked destination refuses the whole batch");
    assert.deepEqual(importMappings([linked], [], [], [{ ...file, outputPath: "additional.png" }]),
      [{ mappingAction: "add", mappingId: null }]);
    assert.equal(resolveImportOutputs([linked], [], []).get(file.outputPath), linked,
      "source additions leave the existing literal binding intact");
  }
});

test("prospective union rejects identity, spelling, file/directory and hidden generated conflicts", () => {
  const other = { id: randomUUID(), assetId: randomUUID(), outputPath: file.outputPath, ...sourceBinding };
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
    id: randomUUID(), assetId: randomUUID(), outputPath: `existing/${index}.png`, ...sourceBinding,
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

test("generated Original and transformed use destinations refuse before canonical source equality", () => {
  const optIn = [{ sourcePrefix: "derived/", outputPrefix: "assets/", includeUses: true }];
  for (const outputMimeType of ["image/png", "image/webp"]) {
    const extension = outputMimeType === "image/png" ? "png" : "webp";
    const use = { assetUseId: randomUUID(), assetId: file.assetId, key: "derived/logo", outputMimeType };
    const incoming = { ...file, key: "outside/logo", outputPath: `assets/logo.${extension}` };
    const membership = resolveFolderMembership([], [], [use], optIn);
    const outputs = resolveImportOutputs([], [], optIn, [use]);
    assert.deepEqual([...outputs.values()], membership, "manifest and import use the same member identities and paths");
    assert.equal(outputs.get(incoming.outputPath)!.id, folderUseItemId(use.assetUseId, incoming.outputPath));
    assert.throws(() => importMappings([], [], optIn, [incoming], [use]), /Linked uses are read-only/);
    assert.throws(() => importMappings([], [], optIn, [{ ...incoming, assetId: randomUUID(), checksum: "b".repeat(64) }], [use]),
      /Linked uses are read-only/, "refusal precedes even mismatched source identity/checksum");
    assert.deepEqual(importMappings([], [], optIn, [{ ...incoming, outputPath: "direct.png" }], [use]),
      [{ mappingAction: "add", mappingId: null }]);
  }
  const plain = [{ sourcePrefix: "derived/", outputPrefix: "assets/" }];
  const use = { assetUseId: randomUUID(), assetId: file.assetId, key: "derived/logo", outputMimeType: "image/png" };
  assert.deepEqual(importMappings([], [], plain, [file], [use]), [{ mappingAction: "add", mappingId: null }],
    "uses do not become destinations without explicit opt-in");
  assert.throws(() => importMappings([], [], optIn, [file], [use]), /Linked uses are read-only/,
    "a true rule added after preflight is re-evaluated at commit");
});
