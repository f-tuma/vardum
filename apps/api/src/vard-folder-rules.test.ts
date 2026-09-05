import assert from "node:assert/strict";
import test from "node:test";
import {
  folderItemId,
  folderRulesSchema,
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
