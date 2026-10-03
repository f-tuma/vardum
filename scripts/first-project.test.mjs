import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtures, verifyFirstProject } from "../examples/first-project/verify.mjs";

const example = fileURLToPath(new URL("../examples/first-project/", import.meta.url));

test("first-project verifier checks exact bytes, paths and independent schema 2 input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vardum-example-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(example, "sample"), join(root, "sample"), { recursive: true });
  const config = { schema: 1, server: "https://example.invalid", workspace: "test-workspace", vard: "test-vard" };
  const snapshot = { schema: 2, server: config.server, workspace: config.workspace, vard: config.vard, items: {} };
  const versionId = "00000000-0000-0000-0000-000000000001";
  for (const [source, path] of fixtures) {
    const bytes = await readFile(join(root, source));
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    snapshot.items[path] = {
      path, versionId, fingerprint: `${versionId}:`,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      downloadUrl: `${config.server}/w/test/__v/${versionId}/${source}`,
    };
  }
  const save = (value) => writeFile(join(root, ".vardum.lock"), JSON.stringify(value));
  await writeFile(join(root, "vardum.json"), JSON.stringify(config));
  await save(snapshot);
  assert.match(await verifyFirstProject(root), /Verified 3 exact fixture files/);

  await t.test("changed output bytes fail even if a checksum is also changed", async () => {
    await writeFile(join(root, "public/logo.svg"), "different bytes");
    const changed = structuredClone(snapshot);
    changed.items["public/logo.svg"].checksum = createHash("sha256").update("different bytes").digest("hex");
    await save(changed);
    await assert.rejects(verifyFirstProject(root), /differs from its uploaded fixture/);
    await cp(join(root, "sample/logo.svg"), join(root, "public/logo.svg"));
    await save(snapshot);
  });
  await t.test("snapshot checksums fail independently of correct local bytes", async () => {
    const changed = structuredClone(snapshot);
    changed.items["public/logo.svg"].checksum = "0".repeat(64);
    await save(changed);
    await assert.rejects(verifyFirstProject(root), /Incorrect SHA-256/);
    await save(snapshot);
  });
  await t.test("extra generated output fails", async () => {
    const extra = join(root, "public/brand/new.svg");
    await writeFile(extra, "extra");
    await assert.rejects(verifyFirstProject(root), /Output membership differs/);
    await rm(extra);
  });
  await t.test("missing snapshot membership and legacy schema fail", async () => {
    const changed = structuredClone(snapshot);
    delete changed.items["public/brand/icons/check.svg"];
    await save(changed);
    await assert.rejects(verifyFirstProject(root), /Snapshot membership differs/);
    await save({ ...snapshot, schema: 1 });
    await assert.rejects(verifyFirstProject(root), /schema 2 snapshot/);
    await save(snapshot);
  });
  await t.test("different snapshot context and source URL fail", async () => {
    await save({ ...snapshot, workspace: "another-workspace" });
    await assert.rejects(verifyFirstProject(root), /Snapshot workspace differs/);
    const changed = structuredClone(snapshot);
    changed.items["public/logo.svg"].downloadUrl += "?key=unexpected";
    await save(changed);
    await assert.rejects(verifyFirstProject(root), /no signed transformation query/);
    await save(snapshot);
  });
});
