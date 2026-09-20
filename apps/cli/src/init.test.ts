import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./index.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
const values = [
  "--server",
  "https://example.com/",
  "--workspace",
  " workspace ",
  "--vard",
  "vard",
];
const config = {
  schema: 1,
  server: "https://example.com",
  workspace: "workspace",
  vard: "vard",
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vardum-init-"));
  const configHome = join(root, "config");
  await mkdir(join(configHome, "vardum"), { recursive: true });
  await writeFile(
    join(configHome, "vardum/version-check.json"),
    JSON.stringify({ latest: "0.0.0", at: Date.now() }),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "vardum.json");
  const run = (...args: string[]) =>
    new Promise<{ code: number; data: any }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", tsx, cli, "init", ...args, "--json"],
        {
          cwd: root,
          env: { PATH: process.env.PATH, VARDUM_CONFIG_HOME: configHome },
          timeout: 5000,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number(error.code) : 0,
            data: JSON.parse(error ? stderr : stdout),
          }),
      );
    });
  return { path, run };
}

test("init creates normalized configuration and repeated setup preserves it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(...values)).data.changed, 1);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), config);
  const existing = JSON.stringify({ ...config, note: "keep custom fields" });
  await writeFile(f.path, existing);
  const again = await f.run(...values);
  assert.equal(again.code, 0);
  assert.equal(again.data.changed, 0);
  assert.equal(await readFile(f.path, "utf8"), existing);
});

test("init dry-run never creates or replaces configuration", async (t) => {
  const f = await fixture(t);
  const result = await f.run(...values, "--dry-run");
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, {
    dryRun: true,
    changed: 1,
    actions: [{ action: "create", path: "vardum.json", applied: false }],
  });
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  await writeFile(f.path, "existing");
  assert.equal((await f.run(...values, "--dry-run", "--force")).code, 0);
  assert.equal(await readFile(f.path, "utf8"), "existing");
});

test("non-interactive init fails with actionable missing options instead of prompting", async (t) => {
  const f = await fixture(t);
  const result = await f.run("--server", "https://example.com");
  assert.equal(result.code, 1);
  assert.match(result.data.error, /requires --workspace, --vard/);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("init protects differing, invalid and empty configurations unless forced", async (t) => {
  const f = await fixture(t);
  for (const existing of [
    JSON.stringify({ ...config, vard: "other" }),
    "invalid",
    "",
  ]) {
    await writeFile(f.path, existing);
    const result = await f.run(...values);
    assert.equal(result.code, 1);
    assert.match(result.data.error, /--force/);
    assert.equal(await readFile(f.path, "utf8"), existing);
  }
  assert.equal((await f.run(...values, "--force")).code, 0);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), config);
});

test("init rejects invalid URLs and unsupported arguments without writing", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    ["--server", "https://user:secret@example.com"],
    ["--delete"],
    ["unexpected"],
  ]) {
    assert.equal((await f.run(...values, ...extra)).code, 1);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
});
