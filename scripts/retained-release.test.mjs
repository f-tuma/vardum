import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { boundedBytes, downloadGitHubBytes } from "./github-release-api.mjs";
import { ensureGitHubRelease, ensureTag, preflightGitHubRelease } from "./github-release.mjs";
import { registryState, publishRelease, validateRelease } from "./release-packages.mjs";
import { expectedContract, retainedRelease as candidate, selectRetainedRelease } from "./retained-release-contract.mjs";
import { crc32, inspectRetainedZip, retainedPolicy, retainedPublicationPolicy, validateOrigin, writeRetainedEvidence, writeRetainedPublicationEvidence } from "./retained-release.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const now = Date.parse("2026-10-10T18:00:00Z");

function origin() {
  const run = { id: candidate.runId, run_attempt: 1, workflow_id: candidate.workflowId,
    path: candidate.workflowPath, head_sha: candidate.commit, head_branch: candidate.branch,
    repository: { id: candidate.repositoryId }, head_repository: { id: candidate.repositoryId },
    event: "workflow_dispatch", status: "completed", conclusion: "success" };
  const artifact = { id: candidate.artifactId, name: candidate.artifactName, expired: false,
    size_in_bytes: candidate.archiveBytes, digest: `sha256:${candidate.archiveSha256}`,
    created_at: candidate.createdAt, updated_at: candidate.createdAt, expires_at: candidate.expiresAt,
    workflow_run: { id: candidate.runId, repository_id: candidate.repositoryId,
      head_repository_id: candidate.repositoryId, head_sha: candidate.commit, head_branch: candidate.branch } };
  return { repository: { id: candidate.repositoryId, owner: { id: candidate.ownerId }, full_name: candidate.repository },
    workflow: { id: candidate.workflowId, path: candidate.workflowPath }, run,
    attempt: structuredClone(run), commit: { sha: candidate.commit, tree: { sha: candidate.tree } },
    jobs: { total_count: 3, jobs: candidate.jobs.map(job => ({ ...job, run_id: candidate.runId, run_attempt: 1,
      head_sha: candidate.commit, status: "completed", started_at: "2026-10-10T16:01:34Z",
      completed_at: "2026-10-10T16:16:27Z" })) }, artifact,
    artifacts: { total_count: 1, artifacts: [structuredClone(artifact)] } };
}

test("reviewed origin includes attempt-specific success, run membership and exact content descriptor", () => {
  const data = origin();
  // No invented artifact attempt field; skipped job timestamps are not ordered.
  assert.equal(data.artifact.run_attempt, undefined);
  data.jobs.jobs[2].started_at = "2026-10-10T16:16:28Z";
  validateOrigin(data, candidate, now);
});
const invalidOrigin = [
  ["repository ID", data => data.repository.id++],
  ["owner ID", data => data.repository.owner.id++],
  ["repository rename", data => data.repository.full_name = "someone/vardum"],
  ["workflow path", data => data.workflow.path = ".github/workflows/other.yml"],
  ["workflow ID", data => data.attempt.workflow_id++],
  ["current origin rerun", data => data.run.run_attempt++],
  ["attempt rerun", data => data.attempt.run_attempt++],
  ["attempt SHA", data => data.attempt.head_sha = "a".repeat(40)],
  ["fork origin", data => data.attempt.head_repository.id++],
  ["wrong tree", data => data.commit.tree.sha = "a".repeat(40)],
  ["failed origin", data => data.attempt.conclusion = "failure"],
  ["published origin", data => data.jobs.jobs[2].conclusion = "success"],
  ["wrong install job", data => data.jobs.jobs[1].name = "install-artifacts"],
  ["job from other attempt", data => data.jobs.jobs[1].run_attempt = 2],
  ["missing job", data => data.jobs.jobs.pop()],
  ["duplicate job", data => data.jobs.jobs[1] = data.jobs.jobs[0]],
  ["expired artifact", data => data.artifact.expired = true],
  ["artifact size", data => data.artifact.size_in_bytes++],
  ["artifact digest", data => data.artifact.digest = "sha256:" + "a".repeat(64)],
  ["artifact from fork", data => data.artifact.workflow_run.head_repository_id++],
  ["artifact outside validate interval", data => data.jobs.jobs[0].completed_at = "2026-10-10T16:16:23Z"],
  ["incomplete membership", data => data.artifacts.total_count++],
  ["duplicate artifact name", data => { data.artifacts.artifacts.push({ ...data.artifact, id: 123 }); data.artifacts.total_count++; }],
  ["mismatching membership metadata", data => data.artifacts.artifacts[0].expired = true],
];
for (const [name, mutate] of invalidOrigin) test(`origin rejects ${name}`, () => {
  const data = origin(); mutate(data); assert.throws(() => validateOrigin(data, candidate, now));
});
test("expiry is checked against time even when API says unexpired", () => {
  assert.throws(() => validateOrigin(origin(), candidate, Date.parse(candidate.expiresAt)), /expired/);
});

function makeZip(entries, { mode = 0o100644, compress = false, extra = false } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content, declaredSize = content.length] of entries) {
    const filename = Buffer.from(name), bytes = compress ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compress ? 8 : 0, 10); central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(extra ? 1 : 0, 30); central.writeUInt32LE((mode * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); centrals.push(central, filename); offset += local.length + filename.length + bytes.length;
  }
  const centralBytes = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
function fixture() {
  const contents = candidate.packages.map((pkg, index) => [pkg.file, Buffer.from(`candidate-${index}`)]);
  const packages = candidate.packages.map((pkg, index) => ({ ...pkg, bytes: contents[index][1].length, integrity: integrity(contents[index][1]) }));
  const manifest = Buffer.from(JSON.stringify({ schema: 1, packages: packages.map(({ bytes, ...pkg }) => pkg) }));
  return { contents: [["release.json", manifest], ...contents], candidate: { ...candidate, packages,
    manifestBytes: manifest.length, manifestSha256: hash(manifest) } };
}
function inspectFixture(contents, contract, options) {
  const zip = makeZip(contents, options);
  return inspectRetainedZip(zip, { ...contract, archiveBytes: zip.length, archiveSha256: hash(zip) });
}
test("ZIP validates all four regular files in memory", () => {
  const data = fixture(); assert.equal(inspectFixture(data.contents, data.candidate).size, 4);
  assert.equal(inspectFixture(data.contents, data.candidate, { compress: true }).size, 4);
});
for (const name of ["../release.json", "/release.json", "folder/release.json", "release.json\\", "release.json\0"]) test(`ZIP rejects non-basename ${JSON.stringify(name)}`, () => {
  const data = fixture(); data.contents[0][0] = name; assert.throws(() => inspectFixture(data.contents, data.candidate), /basename/);
});
for (const mode of [0o120777, 0o040755, 0o010644, 0]) test(`ZIP rejects non-regular mode ${mode.toString(8)}`, () => {
  const data = fixture(); assert.throws(() => inspectFixture(data.contents, data.candidate, { mode }), /regular/);
});
test("ZIP rejects duplicate, extra, incomplete and malformed entries", () => {
  const data = fixture();
  assert.throws(() => inspectFixture([data.contents[0], data.contents[0], ...data.contents.slice(2)], data.candidate), /Duplicate/);
  assert.throws(() => inspectFixture([...data.contents, ["extra", Buffer.from("extra")]], data.candidate));
  assert.throws(() => inspectFixture(data.contents.slice(1), data.candidate));
  assert.throws(() => inspectFixture(data.contents, data.candidate, { extra: true }));
});
test("ZIP bounds inflation and rejects content, digest and trailing-data changes", () => {
  const data = fixture();
  const bomb = structuredClone(data.contents); bomb[1][1] = Buffer.alloc(10000, 65); bomb[1][2] = data.candidate.packages[0].bytes;
  assert.throws(() => inspectFixture(bomb, data.candidate, { compress: true }));
  const changed = structuredClone(data.contents); changed[1][1][0] ^= 1;
  assert.throws(() => inspectFixture(changed, data.candidate), /Archive differs/);
  const zip = makeZip(data.contents);
  assert.throws(() => inspectRetainedZip(zip, { ...data.candidate, archiveBytes: zip.length, archiveSha256: "a".repeat(64) }), /digest/);
  const trailing = Buffer.concat([zip, Buffer.from("x")]);
  assert.throws(() => inspectRetainedZip(trailing, { ...data.candidate, archiveBytes: trailing.length, archiveSha256: hash(trailing) }));
});
test("self-declared manifest hashes cannot replace the independently reviewed integrity", () => {
  const data = fixture(); const manifest = JSON.parse(data.contents[0][1]);
  data.contents[1][1][0] ^= 1; manifest.packages[0].integrity = integrity(data.contents[1][1]);
  data.contents[0][1] = Buffer.from(JSON.stringify(manifest));
  assert.throws(() => inspectFixture(data.contents, data.candidate), /Manifest differs/);
  // Even updating the manifest pin alone cannot change the reviewed package SHA512.
  const forged = { ...data.candidate, manifestSha256: hash(data.contents[0][1]) };
  assert.throws(() => inspectFixture(data.contents, forged), /self-declared/);
});
test("source checker and retained contract cannot be confused", async () => {
  const data = fixture(), root = await mkdtemp(join(tmpdir(), "vard75-source-confusion-"));
  try {
    for (const [name, bytes] of data.contents) await writeFile(join(root, name), bytes);
    await assert.rejects(validateRelease(root), /0\.3\.0|0\.2\.0/);
    await assert.rejects(validateRelease(root, expectedContract()), /reviewed origin/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitHub token is not forwarded to signed blob download", async () => {
  const requests = [];
  const bytes = await downloadGitHubBytes(`/repos/${candidate.repository}/actions/artifacts/1/zip`, 3, {
    token: "secret", fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1 ? new Response(null, { status: 302, headers: { location: "https://storage.blob.core.windows.net/a?signature=secret" } }) : new Response("zip");
    },
  });
  assert.equal(bytes.toString(), "zip"); assert.equal(requests[0].options.headers.authorization, "Bearer secret");
  assert.equal(requests[0].options.headers.accept, "application/vnd.github+json");
  assert.equal(requests[1].options.headers, undefined); assert.equal(requests[1].options.redirect, "manual");
});
test("download rejects untrusted redirects, errors and bounded overflow", async () => {
  for (const location of ["https://evil.example/", "http://a.blob.core.windows.net/", "https://user:pass@a.blob.core.windows.net/", "https://a.blob.core.windows.net.evil.example/", "https://a.blob.core.windows.net/#fragment", "https://a.blob.core.windows.net:8443/"]) {
    await assert.rejects(downloadGitHubBytes(`/repos/${candidate.repository}/actions/artifacts/1/zip`, 3, {
      token: "secret", fetchImpl: async () => new Response(null, { status: 302, headers: { location } }),
    }), /redirect/);
  }
  await assert.rejects(downloadGitHubBytes(`/repos/${candidate.repository}/actions/artifacts/1/zip`, 3, {
    token: "secret", fetchImpl: async () => new Response("denied", { status: 403 }),
  }), /403/);
  await assert.rejects(boundedBytes(new Response("oversized"), 3), /byte limit/);
  await assert.rejects(boundedBytes(new Response("x", { headers: { "content-length": "4" } }), 3), /byte limit/);
});

test("retained policy keeps safe mode readonly and limits explicit publication to reviewed main", () => {
  const policy = { eventName: "workflow_dispatch", ref: "refs/heads/main", repository: candidate.repository,
    controllerCommit: "a".repeat(40), validationOnly: true };
  assert.equal(retainedPolicy(policy).publicationAllowed, false);
  assert.equal(retainedPolicy({ ...policy, validationOnly: false }).publicationAllowed, true);
  assert.throws(() => retainedPolicy({ ...policy, ref: "refs/tags/v0.7.0", validationOnly: false }), /reviewed main/);
  assert.throws(() => retainedPolicy({ ...policy, validationOnly: false },
    { ...candidate, publication: { ...candidate.publication, enabled: false } }), /disabled/);
  assert.throws(() => retainedPolicy({ ...policy, eventName: "push" }));
  assert.throws(() => selectRetainedRelease("11674484014"), /Unknown reviewed/);
  assert.equal(selectRetainedRelease(candidate.selection), candidate);
});

test("whole registry batch preflight rejects late conflicts before publishing", async () => {
  const release = { packages: candidate.packages }, published = [];
  await assert.rejects(publishRelease("/unused", release, {
    readState: input => registryState(input, { fetchImpl: async url => {
      if (url.includes("mcp")) return Response.json({ dist: { integrity: "different" } });
      return new Response(null, { status: 404 });
    } }), publish: async pkg => published.push(pkg),
  }), /different bytes/);
  assert.deepEqual(published, []);
});
test("interrupted publication skips identical archives and preserves dependency order", async () => {
  const data = fixture(), release = { packages: data.candidate.packages }, published = [];
  await publishRelease("/unused", release, {
    readState: input => registryState(input, { fetchImpl: async url => url.includes("/tarballs/")
      ? new Response(data.contents[1][1]) : url.includes("shared")
      ? Response.json({ dist: { integrity: release.packages[0].integrity, tarball: "https://registry.npmjs.org/tarballs/shared.tgz" } }) : new Response(null, { status: 404 }) }),
    publish: async pkg => published.push(pkg.name),
  });
  assert.deepEqual(published, ["@vardum/cli", "@vardum/mcp"]);
});
test("registry integrity metadata cannot hide altered actual tarball bytes", async () => {
  const data = fixture(), release = { packages: data.candidate.packages }, published = [];
  await assert.rejects(publishRelease("/unused", release, {
    readState: input => registryState(input, { fetchImpl: async url => url.includes("/tarballs/")
      ? new Response(Buffer.alloc(release.packages[0].bytes, 65))
      : Response.json({ dist: { integrity: release.packages[0].integrity, tarball: "https://registry.npmjs.org/tarballs/shared.tgz" } }) }),
    publish: async pkg => published.push(pkg.name),
  }), /tarball bytes differ/);
  assert.deepEqual(published, []);
});

test("tag preparation verifies immutable source, including annotated tags", async () => {
  const writes = [];
  const client = { request: async (path, options) => {
    if (options?.method === "POST") { writes.push(options.body); return { ref: "refs/tags/v0.7.0", object: { type: "commit", sha: candidate.commit } }; }
    return null;
  } };
  await ensureTag(client, candidate.repository, "v0.7.0", candidate.commit, { create: true });
  assert.deepEqual(writes, [{ ref: "refs/tags/v0.7.0", sha: candidate.commit }]);
  await ensureTag({ request: async path => path.includes("/git/ref/")
    ? { ref: "refs/tags/v0.7.0", object: { type: "tag", sha: "a".repeat(40) } }
    : { sha: "a".repeat(40), object: { type: "commit", sha: candidate.commit } } }, candidate.repository, "v0.7.0", candidate.commit);
  await assert.rejects(ensureTag({ request: async () => ({ ref: "refs/tags/v0.7.0", object: { type: "commit", sha: "b".repeat(40) } }) }, candidate.repository, "v0.7.0", candidate.commit), /different source/);
});

test("existing GitHub release asset conflicts fail before missing assets are uploaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "vard75-assets-")), uploads = [], bytes = Buffer.from("original");
  try {
    await writeFile(join(root, "release.json"), bytes); await writeFile(join(root, "cli.tgz"), bytes);
    const client = { request: async path => {
      if (path.includes("/git/ref/")) return { ref: "refs/tags/v0.7.0", object: { type: "commit", sha: candidate.commit } };
      if (path.includes("/releases/tags/")) return { id: 1, tag_name: "v0.7.0", draft: false, prerelease: false };
      return [{ id: 2, name: "cli.tgz", state: "uploaded", size: bytes.length }];
    }, download: async () => Buffer.from("modified"), upload: async (...args) => uploads.push(args) };
    await assert.rejects(ensureGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root,
      { packages: [{ file: "cli.tgz" }] }), /bytes differ/);
    assert.deepEqual(uploads, []);
    client.download = async () => bytes;
    client.request = async path => {
      if (path.includes("/git/ref/")) return { ref: "refs/tags/v0.7.0", object: { type: "commit", sha: candidate.commit } };
      if (path.includes("/releases/tags/")) return { id: 1, tag_name: "v0.7.0", draft: false, prerelease: false };
      return [{ id: 2, name: "cli.tgz", state: "uploaded", size: bytes.length }, { id: 3, name: "release.json", state: "uploaded", size: bytes.length }];
    };
    await ensureGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, { packages: [{ file: "cli.tgz" }] });
    assert.deepEqual(uploads, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retained reports project only allowlisted fields and separate controller/artifact source", async () => {
  const root = await mkdtemp(join(tmpdir(), "vard75-evidence-")), directory = join(root, "safe");
  try {
    await writeRetainedEvidence(directory, { controllerCommit: "a".repeat(40), downloadStatus: "success", installStatus: "failure",
      integrationStatus: "skipped", token: "secret", logs: "sensitive", url: "https://signed.invalid/" });
    const report = await readFile(join(directory, "retained-summary.json"), "utf8");
    assert.doesNotMatch(report, /secret|sensitive|signed\.invalid/);
    const data = JSON.parse(report); assert.equal(data.controllerCommit, "a".repeat(40)); assert.equal(data.artifactSource.commit, candidate.commit);
    assert.equal(data.publicationConfigured, true);
    assert.equal(data.publicationEnabled, false); assert.equal(data.checks.independentInstalls, "failure");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retained workflow uses readonly validation, installed contract and exact upload allowlists", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const job = workflow.split("    retained-validate:\n")[1].split("    publish:\n")[0];
  assert.match(job, /contents: read\n {12}actions: read/);
  assert.doesNotMatch(job, /environment:|id-token:|contents: write| pack |pnpm (?:-r )?build|SMOKE_PUBLIC_CLIENTS|SMOKE_SERVER_CANDIDATE|npm publish|gh release/);
  assert.match(job, /RETAINED_CANDIDATE: \$\{\{ inputs\.retained_candidate \}\}/);
  assert.doesNotMatch(job, /run:.*inputs\.retained_candidate/);
  assert.match(job, /retained-release\.mjs policy/); assert.match(job, /retained-release\.mjs integration/);
  assert.equal((job.match(/artifacts\/npm\/(?:release\.json|vardum-(?:shared-0\.3\.0|cli-0\.7\.0|mcp-0\.3\.0)\.tgz)/g) ?? []).length, 4);
  assert.match(job, /if: always\(\) && steps\.retained_evidence\.outcome == 'success'/);
  assert.doesNotMatch(job, /path:.*\*|runtime-images|\.log/);
});


const publicationEnvironment = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: candidate.repository, GITHUB_SHA: "a".repeat(40), RELEASE_VALIDATION_ONLY: "false" };
const enabledCandidate = { ...candidate, publication: { ...candidate.publication, enabled: true } };
test("enabled retained policy requires manual main, repository identity and a distinct controller", () => {
  assert.equal(retainedPublicationPolicy(publicationEnvironment, enabledCandidate).publicationAllowed, true);
  for (const changes of [{ GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/tags/v0.7.0" }, { GITHUB_REF: "refs/heads/other" },
    { GITHUB_REPOSITORY: "someone/vardum" }, { GITHUB_SHA: candidate.commit }, { GITHUB_SHA: "invalid" },
    { RELEASE_VALIDATION_ONLY: "true" }, { RELEASE_VALIDATION_ONLY: "" }, { RELEASE_VALIDATION_ONLY: undefined }]) {
    assert.throws(() => retainedPublicationPolicy({ ...publicationEnvironment, ...changes }, enabledCandidate));
  }
  for (const enabled of [false, "true", 1, undefined]) assert.throws(() => retainedPublicationPolicy(publicationEnvironment,
    { ...candidate, publication: { ...candidate.publication, enabled } }), /disabled/);
});

test("every enabled publication CLI guard denies unsafe contexts before files, network and subprocesses", async () => {
  const root = await mkdtemp(join(tmpdir(), "vard75-mutation-guards-"));
  const preload = join(root, "deny-touch.mjs"), directory = join(root, "missing");
  try {
    await writeFile(preload, `import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const readFile = fs.readFile;
fs.readFile = async (path, ...options) => {
  if (String(path).includes("missing/release.json")) throw new Error("UNEXPECTED FILE READ");
  return readFile(path, ...options);
};
childProcess.execFile = () => { throw new Error("UNEXPECTED SUBPROCESS"); };
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error("UNEXPECTED NETWORK"); };
`);
    for (const command of ["publication-policy", "github-preflight", "prepare-tag", "publish", "verify-registry", "github-release"]) {
      for (const value of [undefined, "", "true", "TRUE", "0", "null"]) {
        const env = { ...process.env, ...publicationEnvironment };
        if (value === undefined) delete env.RELEASE_VALIDATION_ONLY;
        else env.RELEASE_VALIDATION_ONLY = value;
        delete env.GH_TOKEN;
        const result = spawnSync(process.execPath, ["--import", preload,
          fileURLToPath(new URL("./retained-release.mjs", import.meta.url)), command, candidate.selection,
          ...(command === "publication-policy" ? [] : [directory])], { encoding: "utf8", env });
        assert.equal(result.status, 1, `${command}/${value}: ${result.stderr}`);
        assert.match(result.stderr, /requires RELEASE_VALIDATION_ONLY=false/);
        assert.doesNotMatch(result.stderr, /ENOENT|UNEXPECTED|GH_TOKEN is required/);
      }
      for (const changes of [{ GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "pull_request" },
        { GITHUB_REPOSITORY: "someone/vardum" }, { GITHUB_SHA: "invalid" }, { GITHUB_SHA: candidate.commit },
        { GITHUB_REF: "refs/heads/other" }, { GITHUB_REF: "refs/tags/v0.7.0" }]) {
        const result = spawnSync(process.execPath, ["--import", preload,
          fileURLToPath(new URL("./retained-release.mjs", import.meta.url)), command, candidate.selection,
          ...(command === "publication-policy" ? [] : [directory])], {
          encoding: "utf8", env: { ...process.env, ...publicationEnvironment, ...changes },
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /manual dispatch|Unexpected controller repository|did not match|reviewed main controller|must be distinct/);
        assert.doesNotMatch(result.stderr, /ENOENT|UNEXPECTED|GH_TOKEN is required/);
      }
    }
    const allowed = spawnSync(process.execPath, ["--import", preload,
      fileURLToPath(new URL("./retained-release.mjs", import.meta.url)), "publication-policy", candidate.selection],
      { encoding: "utf8", env: { ...process.env, ...publicationEnvironment } });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout.trim(), "Reviewed retained publication policy passed");
    for (const command of ["github-preflight", "prepare-tag", "publish", "verify-registry", "github-release"]) {
      const permitted = spawnSync(process.execPath, ["--import", preload,
        fileURLToPath(new URL("./retained-release.mjs", import.meta.url)), command, candidate.selection, directory],
        { encoding: "utf8", env: { ...process.env, ...publicationEnvironment } });
      assert.equal(permitted.status, 1);
      assert.match(permitted.stderr, /UNEXPECTED FILE READ/);
      assert.doesNotMatch(permitted.stderr, /UNEXPECTED NETWORK|UNEXPECTED SUBPROCESS/);
    }
    assert.deepEqual((await readdir(root)).sort(), ["deny-touch.mjs"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication stops on an interrupted CLI write before reaching MCP", async () => {
  const writes = [];
  await assert.rejects(publishRelease("/unused", { packages: candidate.packages }, {
    readState: async release => release.packages.map(pkg => ({ ...pkg, published: pkg.name === "@vardum/shared" })),
    publish: async pkg => { writes.push(pkg.name); throw new Error("Interrupted npm write"); },
  }), /Interrupted npm write/);
  assert.deepEqual(writes, ["@vardum/cli"]);
});

test("GitHub readonly preflight permits first attempt and partial retries, rejects conflicts without writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vard75-github-preflight-")), bytes = Buffer.from("original");
  const release = { packages: [{ file: "cli.tgz" }] };
  const tag = { ref: "refs/tags/v0.7.0", object: { type: "commit", sha: candidate.commit } };
  const existing = { id: 1, tag_name: "v0.7.0", draft: false, prerelease: false };
  try {
    await writeFile(join(root, "release.json"), bytes); await writeFile(join(root, "cli.tgz"), bytes);
    let reference = null, currentRelease = null, assets = [], downloaded = bytes;
    const client = { request: async (path, options) => {
      assert.ok(!options?.method || options.method === "GET", "Preflight must not write");
      if (path.includes("/git/ref/")) return reference;
      if (path.includes("/releases/tags/")) return currentRelease;
      return assets;
    }, download: async () => downloaded, upload: async () => assert.fail("Preflight uploaded") };
    let result = await preflightGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, release);
    assert.equal(result.existing, null); assert.equal(result.found.size, 0);
    reference = tag; currentRelease = existing;
    assets = [{ id: 2, name: "cli.tgz", state: "uploaded", size: bytes.length }];
    result = await preflightGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, release);
    assert.deepEqual([...result.found], ["cli.tgz"]);
    downloaded = Buffer.from("modified");
    await assert.rejects(preflightGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, release), /bytes differ/);
    downloaded = bytes;
    for (const changed of [{ ...existing, draft: true }, { ...existing, prerelease: true }, { ...existing, tag_name: "v999.0.0" }]) {
      currentRelease = changed;
      await assert.rejects(preflightGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, release));
    }
    currentRelease = existing; reference = null;
    await assert.rejects(preflightGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, release), /no source tag/);
    reference = { ...tag, object: { type: "commit", sha: "b".repeat(40) } };
    await assert.rejects(preflightGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, release), /different source/);
    reference = tag;
    for (const changed of [[...assets, ...assets], [{ ...assets[0], name: "unexpected.log" }]]) {
      assets = changed;
      await assert.rejects(preflightGitHubRelease(client, candidate.repository, "v0.7.0", candidate.commit, root, release), /Unexpected|duplicate/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication evidence records requested mode, configured gate and exact failed/skipped outcomes only", async () => {
  const root = await mkdtemp(join(tmpdir(), "vard75-publication-evidence-"));
  const checks = { policy: "failure", download: "skipped", npmPreflight: "skipped", githubPreflight: "skipped",
    tagPreparation: "skipped", npmPublish: "skipped", registryVerification: "skipped", githubRelease: "skipped", job: "failure" };
  try {
    for (const enabled of [false, true]) for (const validationOnly of [false, true]) {
      const directory = join(root, `${enabled}-${validationOnly}`);
      await writeRetainedPublicationEvidence(directory, { controllerCommit: "a".repeat(40), validationOnly,
        checks: { ...checks, rawLog: "sensitive" }, token: "secret", environment: "credentials", url: "https://signed.invalid/" },
        { ...candidate, publication: { ...candidate.publication, enabled } });
      assert.deepEqual((await readdir(directory)).sort(), ["checksums.txt", "retained-publication.json", "retained-publication.txt"]);
      const json = await readFile(join(directory, "retained-publication.json"), "utf8"), report = JSON.parse(json);
      assert.doesNotMatch(json, /secret|sensitive|credentials|signed\.invalid/);
      assert.equal(report.publicationEnabled, enabled); assert.equal(report.publicationRequested, !validationOnly);
      assert.equal(report.validationOnly, validationOnly); assert.equal(report.mode, "retained-publication");
      assert.equal(report.controllerCommit, "a".repeat(40)); assert.equal(report.artifactSource.commit, candidate.commit);
      assert.deepEqual(report.checks, checks);
      const text = await readFile(join(directory, "retained-publication.txt"), "utf8");
      assert.equal(await readFile(join(directory, "checksums.txt"), "utf8"),
        `${hash(json)}  retained-publication.json\n${hash(text)}  retained-publication.txt\n`);
    }
    await assert.rejects(writeRetainedPublicationEvidence(join(root, "invalid"), { controllerCommit: "a".repeat(40),
      validationOnly: false, checks: { ...checks, npmPublish: "sensitive error text" } }));
    await assert.rejects(readFile(join(root, "invalid", "retained-publication.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retained publication job is manual main explicit mode, scopes credentials and uses only original bytes", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const job = workflow.split("    retained-publish:\n")[1];
  const condition = job.match(/ {8}if: >-\n([\s\S]*?)\n {8}runs-on:/)[1].trim().replace(/\s+/g, " ");
  assert.equal(condition, "github.event_name == 'workflow_dispatch' && inputs.release_mode == 'retained' && github.ref == 'refs/heads/main' && inputs.validation_only == false && needs.retained-validate.result == 'success'");
  assert.match(job, /needs: retained-validate/);
  assert.match(job, /environment: npm/);
  assert.match(job, /permissions:\n {12}contents: write.*\n {12}actions: read.*\n {12}id-token: write/);
  assert.match(job, /RELEASE_VALIDATION_ONLY: \$\{\{ inputs\.validation_only \}\}/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /node-version: 22\.23\.3/); assert.match(job, /npm install --global npm@12\.0\.2/);
  assert.match(job, /registry-url: https:\/\/registry\.npmjs\.org/);
  const commands = ["publication-policy", "download", "check", "preflight", "github-preflight", "prepare-tag", "publish", "verify-registry", "github-release"];
  let previous = -1;
  for (const command of commands) {
    const position = job.indexOf(`run: node scripts/retained-release.mjs ${command} `);
    assert.ok(position > previous, `Missing or misplaced ${command}`); previous = position;
  }
  assert.doesNotMatch(job.slice(0, previous), /always\(\)|continue-on-error:| pack |pnpm|release-packages\.mjs|git push|PAT|NPM_TOKEN/);
  for (const line of job.split("\n").filter(line => line.includes("GH_TOKEN:"))) assert.match(line, /GH_TOKEN: \$\{\{ github\.token \}\}$/);
  assert.match(job, /NPM_CONFIG_PROVENANCE: \$\{\{ github\.event\.repository\.private == false \}\}/);
  assert.equal((job.match(/id-token: write/g) ?? []).length, 1);
  assert.equal((job.match(/vardum-retained-publication-sanitized\/(?:retained-publication\.(?:json|txt)|checksums\.txt)/g) ?? []).length, 3);
  assert.doesNotMatch(job, /path:.*\*|\.log|runtime-images/);
  assert.equal(retainedPublicationPolicy(publicationEnvironment).publicationAllowed, true);
});
