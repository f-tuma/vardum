import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { parseValidationOnly } from "./release-policy.mjs";
import { githubClient } from "./github-release-api.mjs";
import { expectedContract, retainedRelease, selectRetainedRelease } from "./retained-release-contract.mjs";
import { publishRelease, run, validateRelease, waitForPublishedRelease, withInstalledRelease } from "./release-packages.mjs";
import { ensureGitHubRelease, ensureTag } from "./github-release.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const milliseconds = value => { assert.match(value ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); return Date.parse(value); };

export function retainedPolicy({ eventName, ref, repository, controllerCommit, validationOnly }, candidate = retainedRelease) {
  assert.equal(eventName, "workflow_dispatch", "Retained releases require manual dispatch");
  assert.equal(repository, candidate.repository, "Unexpected controller repository");
  assert.match(controllerCommit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(typeof validationOnly, "boolean");
  if (!validationOnly) {
    assert.ok(candidate.publication.enabled, "Retained publication disabled: reviewed main controller policy exception and VARD-45 npm-owner gate required");
    assert.equal(ref, candidate.publication.controllerRef, "Publication requires the reviewed main controller");
  }
  return { publicationAllowed: !validationOnly, artifactCommit: candidate.commit, controllerCommit };
}

export function validateOrigin({ repository, workflow, run: currentRun, attempt, jobs, artifact, artifacts, commit }, candidate = retainedRelease, now = Date.now()) {
  assert.equal(repository.id, candidate.repositoryId);
  assert.equal(repository.owner?.id, candidate.ownerId);
  assert.equal(repository.full_name, candidate.repository);
  assert.equal(workflow.id, candidate.workflowId);
  assert.equal(workflow.path, candidate.workflowPath);
  for (const origin of [currentRun, attempt]) {
    assert.equal(origin.id, candidate.runId);
    assert.equal(origin.run_attempt, candidate.attempt, "Origin attempt changed");
    assert.equal(origin.workflow_id, candidate.workflowId);
    assert.equal(origin.path, candidate.workflowPath);
    assert.equal(origin.head_sha, candidate.commit);
    assert.equal(origin.head_branch, candidate.branch);
    assert.equal(origin.repository?.id, candidate.repositoryId);
    assert.equal(origin.head_repository?.id, candidate.repositoryId);
    assert.equal(origin.event, "workflow_dispatch");
    assert.equal(origin.status, "completed");
    assert.equal(origin.conclusion, "success");
  }
  assert.equal(commit.sha, candidate.commit);
  assert.equal(commit.tree?.sha, candidate.tree);
  assert.equal(jobs.total_count, candidate.jobs.length);
  assert.equal(jobs.jobs.length, candidate.jobs.length);
  for (const expected of candidate.jobs) {
    const matches = jobs.jobs.filter(job => job.id === expected.id && job.name === expected.name);
    assert.equal(matches.length, 1, "Missing or duplicate origin job");
    const job = matches[0];
    assert.equal(job.run_id, candidate.runId);
    assert.equal(job.run_attempt, candidate.attempt);
    assert.equal(job.head_sha, candidate.commit);
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, expected.conclusion);
  }
  assert.equal(artifact.id, candidate.artifactId);
  assert.equal(artifact.name, candidate.artifactName);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.size_in_bytes, candidate.archiveBytes);
  assert.equal(artifact.digest, `sha256:${candidate.archiveSha256}`);
  assert.equal(artifact.created_at, candidate.createdAt);
  assert.equal(artifact.updated_at, candidate.createdAt);
  assert.equal(artifact.expires_at, candidate.expiresAt);
  assert.ok(now < milliseconds(artifact.expires_at), "Retained artifact expired");
  const origin = artifact.workflow_run;
  assert.equal(origin?.id, candidate.runId);
  assert.equal(origin.repository_id, candidate.repositoryId);
  assert.equal(origin.head_repository_id, candidate.repositoryId);
  assert.equal(origin.head_sha, candidate.commit);
  assert.equal(origin.head_branch, candidate.branch);
  // The Artifacts API has no attempt field. Bind its exact creation time to the
  // successful attempt's validate job, and require membership of that run.
  const validationJob = jobs.jobs.find(job => job.name === "validate");
  assert.ok(milliseconds(validationJob.started_at) <= milliseconds(artifact.created_at) &&
    milliseconds(artifact.created_at) <= milliseconds(validationJob.completed_at), "Artifact is outside validation interval");
  assert.ok(Number.isSafeInteger(artifacts.total_count) && artifacts.total_count <= 100);
  assert.equal(artifacts.artifacts.length, artifacts.total_count, "Incomplete artifact membership response");
  const matching = artifacts.artifacts.filter(item => item.id === candidate.artifactId || item.name === candidate.artifactName);
  assert.equal(matching.length, 1, "Ambiguous artifact membership");
  assert.deepEqual(matching[0], artifact, "Artifact metadata differs between endpoints");
}

export async function readOrigin(client, candidate = retainedRelease) {
  const prefix = `/repos/${candidate.repository}`;
  const routes = {
    repository: prefix, workflow: `${prefix}/actions/workflows/${candidate.workflowId}`,
    run: `${prefix}/actions/runs/${candidate.runId}`,
    attempt: `${prefix}/actions/runs/${candidate.runId}/attempts/${candidate.attempt}`,
    jobs: `${prefix}/actions/runs/${candidate.runId}/attempts/${candidate.attempt}/jobs?per_page=100`,
    artifact: `${prefix}/actions/artifacts/${candidate.artifactId}`,
    artifacts: `${prefix}/actions/runs/${candidate.runId}/artifacts?per_page=100`,
    commit: `${prefix}/git/commits/${candidate.commit}`,
  };
  const result = Object.fromEntries(await Promise.all(Object.entries(routes).map(async ([key, path]) => [key, await client.request(path)])));
  validateOrigin(result, candidate);
  return result;
}

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Parse, bound and verify in memory before writing any entry. No general-purpose
// extractor ever sees an unverified name, symlink, duplicate or ZIP bomb.
export function inspectRetainedZip(bytes, candidate = retainedRelease) {
  assert.equal(bytes.length, candidate.archiveBytes, "Unexpected artifact ZIP size");
  assert.equal(sha256(bytes), candidate.archiveSha256, "Artifact ZIP digest changed");
  assert.ok(bytes.length >= 22);
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, "ZIP end record missing or trailing data");
  assert.equal(bytes.readUInt16LE(end + 4), 0); assert.equal(bytes.readUInt16LE(end + 6), 0);
  assert.equal(bytes.readUInt16LE(end + 8), 4); assert.equal(bytes.readUInt16LE(end + 10), 4);
  assert.equal(bytes.readUInt16LE(end + 20), 0);
  const centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  assert.equal(centralStart + centralSize, end);
  const expectedFiles = new Map([["release.json", candidate.manifestBytes], ...candidate.packages.map(pkg => [pkg.file, pkg.bytes])]);
  const entries = new Map();
  let position = centralStart, localEnd = 0;
  for (let index = 0; index < 4; index++) {
    assert.ok(position + 46 <= end);
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10);
    assert.ok([0, 8].includes(flags), "Unsupported or encrypted ZIP flags");
    assert.ok([0, 8].includes(method), "Unsupported ZIP compression");
    const crc = bytes.readUInt32LE(position + 16), compressed = bytes.readUInt32LE(position + 20), size = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28), extraLength = bytes.readUInt16LE(position + 30), commentLength = bytes.readUInt16LE(position + 32);
    assert.equal(extraLength, 0); assert.equal(commentLength, 0); assert.equal(bytes.readUInt16LE(position + 34), 0);
    const mode = bytes.readUInt32LE(position + 38) >>> 16;
    assert.equal(mode & 0o170000, 0o100000, "ZIP entry must be a regular file");
    assert.ok(position + 46 + nameLength <= end);
    const name = bytes.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    assert.ok(/^[A-Za-z0-9.-]+$/.test(name) && expectedFiles.has(name), "Unexpected ZIP entry basename");
    assert.ok(!entries.has(name), "Duplicate ZIP entry");
    assert.equal(size, expectedFiles.get(name), "ZIP entry size changed");
    assert.ok(compressed <= candidate.archiveBytes);
    const offset = bytes.readUInt32LE(position + 42);
    assert.equal(offset, localEnd, "Overlapping or unaccounted ZIP data");
    assert.ok(offset + 30 <= centralStart);
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    assert.equal(bytes.readUInt16LE(offset + 6), flags); assert.equal(bytes.readUInt16LE(offset + 8), method);
    assert.equal(bytes.readUInt16LE(offset + 26), nameLength); assert.equal(bytes.readUInt16LE(offset + 28), 0);
    assert.equal(bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), name);
    const dataStart = offset + 30 + nameLength, dataEnd = dataStart + compressed;
    assert.ok(dataEnd <= centralStart);
    if (flags === 8) {
      assert.equal(bytes.readUInt32LE(offset + 14), 0); assert.equal(bytes.readUInt32LE(offset + 18), 0); assert.equal(bytes.readUInt32LE(offset + 22), 0);
      assert.ok(dataEnd + 16 <= centralStart);
      assert.equal(bytes.readUInt32LE(dataEnd), 0x08074b50);
      assert.equal(bytes.readUInt32LE(dataEnd + 4), crc); assert.equal(bytes.readUInt32LE(dataEnd + 8), compressed); assert.equal(bytes.readUInt32LE(dataEnd + 12), size);
      localEnd = dataEnd + 16;
    } else {
      assert.equal(bytes.readUInt32LE(offset + 14), crc); assert.equal(bytes.readUInt32LE(offset + 18), compressed); assert.equal(bytes.readUInt32LE(offset + 22), size);
      localEnd = dataEnd;
    }
    const content = method === 8 ? inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: size }) : bytes.subarray(dataStart, dataEnd);
    assert.equal(content.length, size); assert.equal(crc32(content), crc, "ZIP CRC changed");
    entries.set(name, content);
    position += 46 + nameLength;
  }
  assert.equal(position, end); assert.equal(localEnd, centralStart);
  assert.equal(sha256(entries.get("release.json")), candidate.manifestSha256, "Manifest differs from reviewed origin");
  const manifest = JSON.parse(entries.get("release.json"));
  assert.equal(manifest.schema, 1); assert.equal(manifest.packages.length, 3);
  for (const [index, pkg] of candidate.packages.entries()) {
    const { bytes: ignored, ...expected } = pkg;
    assert.deepEqual(manifest.packages[index], expected, "Untrusted self-declared manifest");
    assert.equal(`sha512-${createHash("sha512").update(entries.get(pkg.file)).digest("base64")}`, pkg.integrity, "Archive differs from reviewed origin");
  }
  return entries;
}

export async function downloadRetainedRelease(directory, client, candidate = retainedRelease) {
  await readOrigin(client, candidate);
  const bytes = await client.download(`/repos/${candidate.repository}/actions/artifacts/${candidate.artifactId}/zip`, candidate.archiveBytes, "artifact");
  const entries = inspectRetainedZip(bytes, candidate);
  // Require a new destination; do not overwrite or merge into a symlink/tree.
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false });
  for (const [name, content] of entries) await writeFile(join(directory, name), content, { flag: "wx", mode: 0o644 });
  await validateRelease(directory, expectedContract(candidate));
}

export async function retainedIntegration(directory, candidate = retainedRelease) {
  await withInstalledRelease(directory, async installed => {
    await run(process.execPath, ["--import", "tsx", "--test", "apps/api/integration/private-delivery.test.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 240_000, maxBuffer: 8_000_000,
      env: { ...process.env, VARDUM_TEST_CLI_PATH: installed.cli.binary },
    });
    console.log("Installed retained CLI upload/import contract passed with disposable PostgreSQL");
  }, { expectedContract: expectedContract(candidate) });
}

export const retainedEvidenceFiles = Object.freeze(["retained-summary.json", "retained-summary.txt", "checksums.txt"]);
export async function writeRetainedEvidence(directory, { controllerCommit, downloadStatus, installStatus, integrationStatus }, candidate = retainedRelease) {
  assert.match(controllerCommit ?? "", /^[a-f0-9]{40}$/);
  const status = value => { assert.ok(["success", "failure", "cancelled", "skipped"].includes(value)); return value; };
  const report = { schema: 1, selection: candidate.selection, controllerCommit,
    artifactSource: { repository: candidate.repository, commit: candidate.commit, tree: candidate.tree,
      runId: candidate.runId, attempt: candidate.attempt, artifactId: candidate.artifactId,
      archiveSha256: candidate.archiveSha256, manifestSha256: candidate.manifestSha256 },
    checks: { download: status(downloadStatus), independentInstalls: status(installStatus), installedUploadImport: status(integrationStatus) },
    publicationEnabled: false };
  await mkdir(directory, { recursive: false });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const text = `Selection: ${candidate.selection}\nController: ${controllerCommit}\nArtifact source: ${candidate.commit}\nDownload: ${report.checks.download}\nIndependent installs: ${report.checks.independentInstalls}\nInstalled upload/import: ${report.checks.installedUploadImport}\nPublication: disabled\n`;
  await writeFile(join(directory, retainedEvidenceFiles[0]), json, { flag: "wx" });
  await writeFile(join(directory, retainedEvidenceFiles[1]), text, { flag: "wx" });
  await writeFile(join(directory, "checksums.txt"), `${sha256(json)}  retained-summary.json\n${sha256(text)}  retained-summary.txt\n`, { flag: "wx" });
}

async function main() {
  const [command, selection, argument, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  const candidate = selectRetainedRelease(selection);
  if (command === "policy") {
    assert.equal(argument, undefined);
    return retainedPolicy({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      repository: process.env.GITHUB_REPOSITORY, controllerCommit: process.env.GITHUB_SHA,
      validationOnly: parseValidationOnly(process.env.RELEASE_VALIDATION_ONLY) });
  }
  assert.ok(argument, "Usage: retained-release.mjs policy|download|check|smoke|integration|evidence|preflight|prepare-tag|publish|verify-registry|github-release SELECTION DIRECTORY");
  const directory = resolve(argument), contract = expectedContract(candidate);
  if (command === "download") return downloadRetainedRelease(directory, githubClient(), candidate);
  if (command === "evidence") return writeRetainedEvidence(directory, {
    controllerCommit: process.env.GITHUB_SHA, downloadStatus: process.env.DOWNLOAD_STATUS,
    installStatus: process.env.INSTALL_STATUS, integrationStatus: process.env.INTEGRATION_STATUS,
  }, candidate);
  const release = await validateRelease(directory, contract);
  if (command === "check") return console.log("Reviewed retained archive bytes and manifests passed");
  if (command === "smoke") return withInstalledRelease(directory, async () => {}, { expectedContract: contract });
  if (command === "integration") return retainedIntegration(directory, candidate);
  if (command === "preflight") return publishRelease(directory, release, { validationOnly: true });
  // Mutation helpers are implemented for review, but unreachable with the
  // reviewed descriptor until both independent external gates are resolved.
  assert.ok(["prepare-tag", "publish", "verify-registry", "github-release"].includes(command), "Unknown retained command");
  retainedPolicy({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY, controllerCommit: process.env.GITHUB_SHA,
    validationOnly: false }, candidate);
  if (command === "publish") return publishRelease(directory, release);
  if (command === "verify-registry") {
    await waitForPublishedRelease(release);
    return withInstalledRelease(directory, async () => {}, { expectedContract: contract, publicRegistry: true });
  }
  const client = githubClient();
  const tag = `v${candidate.packages.find(pkg => pkg.name === "@vardum/cli").version}`;
  if (command === "prepare-tag") return ensureTag(client, candidate.repository, tag, candidate.commit, { create: true });
  return ensureGitHubRelease(client, candidate.repository, tag, candidate.commit, directory, release);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
