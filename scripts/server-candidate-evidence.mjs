#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validateCandidate } from "./server-candidate.mjs";
import { readEvidenceSnapshot } from "./evidence-snapshot.mjs";

export const evidenceFiles = Object.freeze(["candidate-summary.json", "acceptance-summary.json", "checksums.txt"]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value) => { assert.match(value ?? "", /^[a-f0-9]{64}$/); return value; };
const imageId = (value) => { assert.match(value ?? "", /^sha256:[a-f0-9]{64}$/); return value; };
const commitId = (value) => { assert.match(value ?? "", /^[a-f0-9]{40}$/); return value; };
const token = (value) => { assert.match(value ?? "", /^[A-Za-z0-9@+_.:~/-]{1,256}$/); return value; };
const status = (value) => ["passed", "incomplete", "interrupted", "scan-complete-requires-vendor-and-finding-assessment"].includes(value) ? value : "incomplete";
const count = (values) => { assert.ok(Array.isArray(values) && values.length <= 100_000); return values.length; };
const imageRoles = ["api", "worker", "gateway", "postgres", "rustfs"];

// Reconstruct approved fields. Never spread raw reports: scanner metadata,
// commands, environment, URLs, source status, logs and errors can contain secrets.
export function projectRuntimeReport(report, expectedCommit) {
  assert.ok(object(report));
  assert.equal(commitId(report.sourceCommit), expectedCommit, "Runtime evidence belongs to another source");
  const images = {};
  for (const role of imageRoles) if (report.images?.[role]) {
    const image = report.images[role];
    images[role] = { id: imageId(image.id) };
    for (const field of ["archiveSha256", "scanSha256"]) if (image[field] !== undefined) images[role][field] = sha(image[field]);
  }
  const findings = {};
  for (const role of ["api", "gateway"]) if (report.findings?.[role]) {
    count(report.findings[role]);
    findings[role] = report.findings[role].map((finding) => {
      assert.ok(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(finding.severity));
      return { id: token(finding.id), package: token(finding.package), installed: token(finding.installed),
        fixed: finding.fixed === "" ? "" : token(finding.fixed), severity: finding.severity };
    });
  }
  const database = report.database ? { sha256: sha(report.database.sha256), metadataSha256: sha(report.database.metadataSha256) } : null;
  return { status: status(report.status), sourceCommit: expectedCommit, images, findings, database,
    scanner: report.scanner === undefined ? null : token(report.scanner),
    runtimeTls: report.runtimeTls ? { status: status(report.runtimeTls.status), summarySha256: sha(report.runtimeTls.summarySha256) } : null };
}
export function projectTlsReport(report, expectedCommit) {
  assert.ok(object(report));
  assert.equal(commitId(report.sourceCommit), expectedCommit, "TLS evidence belongs to another source");
  const images = {};
  for (const role of ["api", "worker", "migrate", "postgres", "rustfs"]) images[role] = imageId(report.images?.[role]);
  const cases = count(report.cases);
  return { status: status(report.status), sourceCommit: expectedCommit, images, cases,
    passedCases: report.cases.filter((item) => item.status === "passed").length,
    privateCertificatesRemoved: report.privateCertificatesRemoved === true };
}
export function projectGatewayReport(report) {
  assert.ok(object(report));
  const images = { gateway: imageId(report.gatewayImage), api: imageId(report.apiImage) };
  if (report.dokployImage !== undefined) images["gateway-dokploy"] = imageId(report.dokployImage);
  const modes = {};
  for (const mode of ["standard", "marketing", "fallback"]) if (report.modes?.[mode]) {
    const item = report.modes[mode];
    modes[mode] = { checks: count(item.checks), passedChecks: item.checks.filter((check) => check.passed === true).length, passed: item.passed === true };
  }
  return { status: status(report.status), images, templateSha256: sha(report.templateSha256), modes,
    coldStartPassed: report.coldStart?.passed === true };
}

const rawFiles = ["runtime-evidence.json", "api-runtime.json", "worker-runtime.json", "api-scan.json", "gateway-scan.json",
  "gateway-config/gateway-config-evidence.json", "dokploy-gateway-config/gateway-config-evidence.json", "runtime-tls/summary.json"];
async function readEvidenceFile(directory, name, json) {
  const report = await readEvidenceSnapshot(directory, name, rawFiles);
  return { sha256: report.sha256, ...(json ? { data: JSON.parse(report.bytes.toString("utf8")) } : {}) };
}
function inside(root, path) {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}

export async function writeServerEvidence({ candidateDirectory, runtimeDirectory, outputDirectory, expectedCommit, acceptanceStatus = "unknown", execute }) {
  expectedCommit = commitId(expectedCommit);
  assert.ok(["success", "failure", "cancelled", "skipped", "unknown"].includes(acceptanceStatus));
  candidateDirectory = resolve(candidateDirectory);
  runtimeDirectory = resolve(runtimeDirectory);
  outputDirectory = resolve(outputDirectory);
  assert.ok(!inside(candidateDirectory, outputDirectory) && !inside(runtimeDirectory, outputDirectory), "Projection must use a separate output directory");
  await mkdir(outputDirectory, { mode: 0o700 });
  const candidate = { schema: 1, scope: "Sanitized identity evidence; full portable bundle and scanner database retained locally.",
    offlineReplay: false, releaseCertification: "pending", expectedCommit, status: "invalid-or-incomplete" };
  try {
    const manifest = await validateCandidate(candidateDirectory, { expectedCommit, requireClean: true, ...(execute ? { execute } : {}) });
    const bytes = await readFile(join(candidateDirectory, "candidate.json"));
    Object.assign(candidate, { status: "verified", serverVersion: manifest.serverVersion, platform: manifest.platform,
      source: { commit: manifest.source.commit, tree: manifest.source.tree, dirty: manifest.source.dirty, context: manifest.source.context },
      sourceClientVersions: manifest.sourceClientVersions, clientVersions: manifest.clientVersions,
      clientFeatureCoverage: { schema: 2, folderVardImport: "not-covered-by-public-baseline", vardEditRevision: "not-covered-by-public-baseline" },
      manifestSha256: digest(bytes), archiveSha256: manifest.archive.sha256, files: manifest.files,
      migrations: manifest.migrations,
      images: manifest.images.map((image) => ({ role: image.role, tag: image.tag, id: image.id, configId: image.configId })) });
  } catch { /* Fixed status only: arbitrary validation errors are never exported. */ }
  const acceptance = { schema: 1, scope: "Sanitized validation evidence; hashes do not provide self-contained offline replay.",
    offlineReplay: false, releaseCertification: "pending", expectedCommit, acceptanceStatus, reports: {}, reportHashes: {} };
  for (const name of rawFiles) {
    const projection = name === "runtime-evidence.json" ? (data) => projectRuntimeReport(data, expectedCommit)
      : name === "runtime-tls/summary.json" ? (data) => projectTlsReport(data, expectedCommit)
      : name.endsWith("gateway-config-evidence.json") ? projectGatewayReport : null;
    try {
      const report = await readEvidenceFile(runtimeDirectory, name, Boolean(projection));
      acceptance.reportHashes[name] = report.sha256;
      if (projection) acceptance.reports[name] = projection(report.data);
    } catch { if (projection) acceptance.reports[name] = { status: "missing-invalid-or-unsafe" }; }
  }
  await writeFile(join(outputDirectory, evidenceFiles[0]), JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(outputDirectory, evidenceFiles[1]), JSON.stringify(acceptance, null, 2) + "\n", { mode: 0o600 });
  const lines = [`Scope: sanitized evidence only; full archives and scanner database remain local; no offline replay; release certification pending.`,
    `Expected source: ${expectedCommit}`, `Candidate: ${candidate.status}`, `Acceptance job: ${acceptanceStatus}`];
  for (const name of evidenceFiles.slice(0, 2)) lines.push(`${digest(await readFile(join(outputDirectory, name)))}  ${name}`);
  await writeFile(join(outputDirectory, evidenceFiles[2]), lines.join("\n") + "\n", { mode: 0o600 });
  return { candidate, acceptance };
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    "expected-commit": { type: "string" }, "acceptance-status": { type: "string", default: "unknown" },
  } });
  assert.equal(positionals.length, 3, "Usage: server-candidate-evidence.mjs CANDIDATE RUNTIME_REPORTS NEW_PROJECTION_DIRECTORY --expected-commit SHA [--acceptance-status success|failure|cancelled|skipped|unknown]");
  await writeServerEvidence({ candidateDirectory: positionals[0], runtimeDirectory: positionals[1], outputDirectory: positionals[2],
    expectedCommit: values["expected-commit"], acceptanceStatus: values["acceptance-status"] });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("Could not write sanitized server evidence; inspect local inputs."); process.exitCode = 1;
});
