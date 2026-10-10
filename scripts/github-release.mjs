import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubClient } from "./github-release-api.mjs";
import { validateRelease } from "./release-packages.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function ensureTag(client, repository, tag, sourceCommit, { create = false } = {}) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const prefix = `/repos/${repository}`;
  let reference = await client.request(`${prefix}/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true });
  if (!reference) {
    assert.ok(create, "Release tag is missing");
    // Use the workflow's built-in GITHUB_TOKEN. Its tag write does not trigger
    // the historical candidate's push workflow. Never use a PAT to create it.
    reference = await client.request(`${prefix}/git/refs`, { method: "POST", body: { ref: `refs/tags/${tag}`, sha: sourceCommit } });
  }
  assert.equal(reference.ref, `refs/tags/${tag}`);
  let object = reference.object;
  const seen = new Set();
  while (object?.type === "tag") {
    assert.ok(seen.size < 5 && !seen.has(object.sha), "Cyclic or deep annotated tag");
    seen.add(object.sha);
    const annotated = await client.request(`${prefix}/git/tags/${object.sha}`);
    assert.equal(annotated.sha, object.sha);
    object = annotated.object;
  }
  assert.equal(object?.type, "commit");
  assert.equal(object.sha, sourceCommit, "Release tag points to a different source commit");
  return reference;
}

export async function verifyReleaseAssets(client, repository, existing, files) {
  const assets = await client.request(`/repos/${repository}/releases/${existing.id}/assets?per_page=100`);
  assert.ok(Array.isArray(assets) && assets.length <= files.size, "Unexpected existing release assets");
  const found = new Set();
  for (const asset of assets) {
    assert.ok(files.has(asset.name) && !found.has(asset.name), "Unexpected or duplicate existing release asset");
    found.add(asset.name);
    const expected = files.get(asset.name);
    assert.equal(asset.state, "uploaded");
    assert.equal(asset.size, expected.length, "Existing release asset size differs");
    if (asset.digest) assert.equal(asset.digest, `sha256:${digest(expected)}`, "Existing release asset digest differs");
    const bytes = await client.download(`/repos/${repository}/releases/assets/${asset.id}`, expected.length, "release");
    assert.equal(bytes.length, expected.length);
    assert.equal(digest(bytes), digest(expected), "Existing release asset bytes differ");
  }
  return found;
}

export async function ensureGitHubRelease(client, repository, tag, sourceCommit, directory, release) {
  await ensureTag(client, repository, tag, sourceCommit);
  const files = new Map();
  for (const name of ["release.json", ...release.packages.map(pkg => pkg.file)]) {
    assert.match(name, /^[A-Za-z0-9.-]+$/);
    assert.ok((await lstat(join(directory, name))).isFile());
    files.set(name, await readFile(join(directory, name)));
  }
  const prefix = `/repos/${repository}`;
  let existing = await client.request(`${prefix}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
  let found = new Set();
  if (existing) {
    assert.equal(existing.tag_name, tag);
    assert.equal(existing.draft, false); assert.equal(existing.prerelease, false);
    // Preflight every existing asset before uploading any missing one. A retry
    // must never hide conflicts behind "release already exists".
    found = await verifyReleaseAssets(client, repository, existing, files);
  } else {
    existing = await client.request(`${prefix}/releases`, { method: "POST", body: {
      tag_name: tag, target_commitish: sourceCommit, name: tag, draft: false,
      prerelease: false, generate_release_notes: true,
    } });
    assert.equal(existing.tag_name, tag);
  }
  for (const [name, bytes] of files) if (!found.has(name)) await client.upload(repository, existing.id, name, bytes);
  const verified = await verifyReleaseAssets(client, repository, existing, files);
  assert.equal(verified.size, files.size, "Release is missing archives");
}

async function main() {
  const [directory, ...extra] = process.argv.slice(2);
  assert.ok(directory && extra.length === 0, "Usage: github-release.mjs DIRECTORY");
  assert.match(process.env.GITHUB_REPOSITORY ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  const path = resolve(directory), release = await validateRelease(path);
  const tag = `v${release.packages.find(pkg => pkg.name === "@vardum/cli").version}`;
  assert.equal(process.env.GITHUB_REF, `refs/tags/${tag}`);
  return ensureGitHubRelease(githubClient(), process.env.GITHUB_REPOSITORY, tag, process.env.GITHUB_SHA, path, release);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
