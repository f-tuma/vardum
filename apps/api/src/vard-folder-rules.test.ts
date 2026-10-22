import assert from "node:assert/strict";
import test from "node:test";
import {
  folderItemId,
  folderRulesSchema,
  folderRulesV2Schema,
  folderUseItemId,
  resolveFolderMembership,
  validateResolvedOutputs,
} from "./vard-folder-rules.js";

test("folder rule prefixes are literal safe directories, root and empty folders are allowed", () => {
  for (const sourcePrefix of [
    "",
    "brand/",
    "brand/nested/",
    "brand_one/",
    "not-yet-created/",
  ])
    assert.equal(
      folderRulesSchema.safeParse([{ sourcePrefix, outputPrefix: "" }]).success,
      true,
    );
  for (const prefix of [
    "brand",
    "/brand/",
    "../",
    "a//",
    "a/../",
    "a\\b/",
    "a\u0000/",
    "a\u007f/",
    "*/",
  ])
    assert.equal(
      folderRulesSchema.safeParse([{ sourcePrefix: prefix, outputPrefix: "" }])
        .success,
      false,
      prefix,
    );
  for (const outputPrefix of [
    ".git/",
    ".vardum/",
    "vardum.json/",
    "con/",
    "bad./",
  ])
    assert.equal(
      folderRulesSchema.safeParse([{ sourcePrefix: "", outputPrefix }]).success,
      false,
    );
  assert.equal(
    folderRulesSchema.safeParse([
      { sourcePrefix: "", outputPrefix: "", excludes: [] },
    ]).success,
    false,
  );
  assert.equal(
    folderRulesSchema.safeParse(
      Array.from({ length: 64 }, () => ({
        sourcePrefix: "",
        outputPrefix: "",
      })),
    ).success,
    true,
  );
  assert.equal(
    folderRulesSchema.safeParse(
      Array.from({ length: 65 }, () => ({
        sourcePrefix: "",
        outputPrefix: "",
      })),
    ).success,
    false,
  );
});

test("resolved outputs reject portable collisions, ancestors, control files and overflow without truncation", () => {
  for (const paths of [
    ["a.png", "A.png"],
    ["café.png", "cafe\u0301.png"],
    ["a", "a/b.png"],
    ["a/b.png", "A"],
    [".git/config"],
    ["assets/.vardum.lock"],
    ["vardum.json"],
    ["con.png"],
    ["a./file"],
    ["a\u007f.png"],
    ["../escape"],
    ["a?.png"],
  ])
    assert.throws(() => validateResolvedOutputs(paths), /Vard/);
  const thousand = Array.from({ length: 1000 }, (_, i) => `a/${i}.png`);
  assert.doesNotThrow(() => validateResolvedOutputs(thousand));
  assert.throws(
    () => validateResolvedOutputs([...thousand, "extra.png"]),
    /more than 1000/,
  );
});

test("generated IDs are stable, destination-sensitive and separate from UUID/manual namespaces", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  assert.match(folderItemId(id, "a.png"), /^folder:[a-f0-9]{64}$/);
  assert.equal(folderItemId(id, "a.png"), folderItemId(id, "a.png"));
  assert.notEqual(folderItemId(id, "a.png"), folderItemId(id, "b.png"));
  assert.notEqual(folderItemId(id, "a.png"), folderItemId("other", "a.png"));
});

test("only strict wire2 folder rules admit opt-in and false normalizes to absence", () => {
  const base = { sourcePrefix: "linked/", outputPrefix: "public/" };
  for (const includeUses of [true, false])
    assert.equal(folderRulesSchema.safeParse([{ ...base, includeUses }]).success, false);
  assert.deepEqual(folderRulesV2Schema.parse([base, { ...base, includeUses: false }]), [base, base]);
  assert.deepEqual(folderRulesV2Schema.parse([{ ...base, includeUses: true }]), [{ ...base, includeUses: true }]);
  for (const includeUses of [null, 0, 1, "true", [], {}])
    assert.equal(folderRulesV2Schema.safeParse([{ ...base, includeUses }]).success, false);
  assert.equal(folderRulesV2Schema.safeParse([{ ...base, includeUses: true, excludes: [] }]).success, false);
});

test("folder use membership matches its own key and saved MIME with stable separate identity", () => {
  const source = { assetId: "source", key: "linked/original.png", mimeType: "image/png" };
  const use = { assetUseId: "use-a", assetId: "outside-source", key: "linked/card", outputMimeType: "image/webp" };
  const rule = { sourcePrefix: "linked/", outputPrefix: "public/", includeUses: true };
  const resolved = resolveFolderMembership([], [source], [use], [rule]);
  assert.deepEqual(resolved, [
    { id: folderItemId("source", "public/original.png"), assetId: "source", outputPath: "public/original.png", bindingKind: "source", assetUseId: null },
    { id: folderUseItemId("use-a", "public/card.webp"), assetId: "outside-source", outputPath: "public/card.webp", bindingKind: "use", assetUseId: "use-a" },
  ]);
  assert.match(resolved[1]!.id, /^folder:use:[a-f0-9]{64}$/);
  assert.notEqual(folderItemId("use-a", "public/card.webp"), resolved[1]!.id);
  const sameIdentity = resolveFolderMembership([], [], [{ ...use, assetId: "different-canonical-source" }], [rule])[0]!;
  assert.equal(sameIdentity.id, resolved[1]!.id, "source state does not define use membership identity");
  assert.notEqual(folderUseItemId("use-b", "public/card.webp"), resolved[1]!.id);
  assert.notEqual(folderUseItemId("use-a", "public/card.png"), resolved[1]!.id);
  for (const includeUses of [false, undefined])
    assert.deepEqual(resolveFolderMembership([], [source], [use], [{ ...rule, includeUses }]), [resolved[0]]);
  assert.equal(resolveFolderMembership([], [], [use, { ...use, assetUseId: "use-b", key: "linked/other" }], [rule]).length, 2,
    "different uses of one canonical source remain distinct");
});

test("all manual/source/use collision pairs share one portable output namespace", () => {
  const rule = { sourcePrefix: "", outputPrefix: "", includeUses: true };
  const manual = { id: "manual", assetId: "source", outputPath: "same.png", bindingKind: "source" as const, assetUseId: null };
  const source = { assetId: "source", key: "same.png", mimeType: "image/png" };
  const use = { assetUseId: "use", assetId: "source", key: "same.png", outputMimeType: "image/png" };
  for (const [manuals, sources, uses] of [
    [[manual], [source], []], [[manual], [], [use]], [[], [source], [use]],
    [[], [], [use, { ...use, assetUseId: "another" }]],
  ] as const) assert.throws(() => resolveFolderMembership(manuals, sources, uses, [rule]), /collide/);
  assert.throws(() => resolveFolderMembership([], [], [use], [rule, rule]), /collide/);
  for (const key of ["SAME.png", "same.png/nested.png"])
    assert.throws(() => resolveFolderMembership([manual], [], [{ ...use, key }], [rule]), /Vard/);
  assert.throws(() => resolveFolderMembership([{ ...manual, outputPath: "café.png" }], [], [
    { ...use, key: "cafe\u0301.png" },
  ], [rule]), /collide/);
});

test("use fan-out and manual/original members count toward one exact1000 limit", () => {
  const manual = Array.from({ length: 999 }, (_, index) => ({
    id: `manual-${index}`, assetId: "source", outputPath: `manual/${index}.png`,
    bindingKind: "source" as const, assetUseId: null,
  }));
  const use = { assetUseId: "use", assetId: "source", key: "linked/card", outputMimeType: "image/png" };
  const rule = { sourcePrefix: "linked/", outputPrefix: "public/", includeUses: true };
  assert.equal(resolveFolderMembership(manual, [], [use], [rule]).length, 1000);
  assert.throws(() => resolveFolderMembership([...manual, { ...manual[0]!, id: "extra", outputPath: "extra.png" }], [], [use], [rule]), /more than 1000/);
  const fanout = Array.from({ length: 64 }, (_, index) => ({ ...rule, outputPrefix: `out-${index}/` }));
  assert.equal(resolveFolderMembership(manual.slice(0, 936), [], [use], fanout).length, 1000);
  assert.throws(() => resolveFolderMembership(manual.slice(0, 937), [], [use], fanout), /more than 1000/);
});
