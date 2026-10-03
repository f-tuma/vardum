import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtures = [
  ["sample/logo.svg", "public/logo.svg"],
  ["sample/brand/badge.svg", "public/brand/badge.svg"],
  ["sample/brand/icons/check.svg", "public/brand/icons/check.svg"],
];
const sampleRoot = fileURLToPath(new URL("./", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function outputFiles(root, prefix = "public") {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `Unexpected output symlink: ${path}`);
    if (entry.isDirectory()) paths.push(...await outputFiles(root, path));
    else {
      assert.ok(entry.isFile(), `Unexpected output type: ${path}`);
      paths.push(path);
    }
  }
  return paths.sort();
}

// Independent of CLI code: the fixture bytes and expected paths are the oracle.
export async function verifyFirstProject(root = sampleRoot) {
  const config = JSON.parse(await readFile(join(root, "vardum.json"), "utf8"));
  const snapshot = JSON.parse(await readFile(join(root, ".vardum.lock"), "utf8"));
  assert.equal(config.schema, 1, "Expected CLI project configuration");
  assert.equal(snapshot.schema, 2, "Run normal pull to create a schema 2 snapshot");
  for (const key of ["server", "workspace", "vard"]) {
    assert.ok(typeof config[key] === "string" && config[key].length > 0);
    assert.equal(snapshot[key], config[key], `Snapshot ${key} differs from config`);
  }
  assert.ok(snapshot.items && typeof snapshot.items === "object" && !Array.isArray(snapshot.items));
  const expectedPaths = fixtures.map(([, path]) => path).sort();
  const items = Object.values(snapshot.items);
  assert.deepEqual(items.map((item) => item.path).sort(), expectedPaths, "Snapshot membership differs");
  assert.deepEqual(await outputFiles(root), expectedPaths, "Output membership differs");
  for (const [source, path] of fixtures) {
    const fixture = await readFile(join(root, source));
    const output = await readFile(join(root, path));
    assert.deepEqual(output, fixture, `${path} differs from its uploaded fixture`);
    const item = items.find((entry) => entry.path === path);
    assert.equal(item.checksum, sha256(fixture), `Incorrect SHA-256 for ${path}`);
    assert.match(item.versionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.ok(typeof item.fingerprint === "string" && item.fingerprint.length > 0);
    const url = new URL(item.downloadUrl);
    assert.equal(url.origin, new URL(config.server).origin);
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.hash, "");
    assert.equal(url.search, "", "These originals need no signed transformation query");
    const parts = url.pathname.split("/");
    assert.equal(parts[1], "w");
    assert.ok(parts[2]);
    assert.equal(parts[3], "__v");
    assert.equal(parts[4], item.versionId);
    assert.equal(parts.slice(5).join("/"), source, `Incorrect source URL for ${path}`);
  }
  return "Verified 3 exact fixture files, output paths and schema 2 snapshot checksums";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyFirstProject().then(console.log).catch((error) => {
    console.error(`Verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
