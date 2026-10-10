import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readEvidenceSnapshot } from "./evidence-snapshot.mjs";
import { observeRuntimeCharsetEvidence } from "./runtime-charset-evidence.mjs";
import { maximumReportBytes, runtimeEvidenceFiles, writeRuntimeEvidence } from "./runtime-evidence.mjs";

const commit = "a".repeat(40), tree = "b".repeat(40);
const hash = value => createHash("sha256").update(value).digest("hex");
const id = role => `sha256:${hash(role)}`;
const secret = "SECRET_SENTINEL_MUST_STAY_LOCAL";
const json = value => JSON.stringify(value, null, 2) + "\n";
const execute = async (_command, args) => ({ stdout: args[0] === "status" ? "" : args[1] === "HEAD" ? commit + "\n" : tree + "\n" });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vardum-runtime-projection-"));
  const runtime = join(root, "raw"), output = join(root, "sanitized");
  await mkdir(runtime);
  const save = async (name, value) => {
    const path = join(runtime, name); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : json(value));
  };
  const project = options => writeRuntimeEvidence({ runtimeDirectory: runtime, outputDirectory: output,
    expectedCommit: commit, acceptanceStatus: "success", jobStatus: "success", execute, ...options });
  return { root, runtime, output, save, project, close: () => rm(root, { recursive: true, force: true }) };
}
const capability = { uid: "65532", capEff: "0000000000000000", capBnd: "0000000000000000", noNewPrivs: "1" };
const policy = { user: "65532:65532", capDrop: ["ALL"], securityOpt: ["no-new-privileges:true"], state: "running", exitCode: 0 };
function inventory() {
  return { versions: { node: "22.23.3", openssl: "3.5.8", v8: "12.4.254.21-node.33", [secret]: secret },
    sharp: { sharp: "0.35.5", heif: "1.23.5", rsvg: "2.63.2", [secret]: secret }, uid: 65532,
    process: { ...capability, environment: secret }, initProcess: { ...capability },
    inheritedTools: { "/bin/sh": false, "/usr/local/bin/npm": false, [secret]: true },
    productionStorePresent: true, developmentPackages: [], trust: { systemCABundleBytes: 100, systemCACertificates: 150, nodeBundledCACertificates: 119, systemCABundleSha256: hash("ca"), pem: secret },
    timezone: { utc: { hour: "12", literal: secret }, prague: { hour: "13" }, filesPresent: true },
    fontInventory: [{ path: secret, bytes: 1234, sha256: hash("font") }],
    svgText: { format: "raw", width: 120, height: 32, channels: 4, size: 15360, visiblePixels: 145, sha256: hash("pixels"), extra: secret },
    resolver: { searchCount: 1, longestSearchDomain: 3, localDomainSet: false, longestLocalDomain: 0, searchDomains: secret }, error: secret };
}
function scan(role) {
  return { SchemaVersion: 2, ArtifactName: secret, Metadata: { ImageID: id(role), OS: { Family: role === "api" ? "debian" : "alpine", Name: role === "api" ? "13.7" : "3.24.0" },
    ImageConfig: { config: { Env: [secret], Cmd: [secret], Labels: { secret } }, history: [{ created_by: secret }] }, DiffIDs: [id(`${role}-layer`)] },
    Results: [{ Target: secret, Class: "os-pkgs", Type: role === "api" ? "debian" : "alpine", Packages: [{ Name: "openssl", License: secret }],
      Vulnerabilities: ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].map((severity, i) => ({ VulnerabilityID: `CVE-2026-${1000 + i}`, PkgName: "openssl", InstalledVersion: "1:3.5.8-1", FixedVersion: i ? "" : "1:3.5.9-1", Severity: severity, Description: secret, PrimaryURL: `https://${secret}.invalid` })) },
    { Target: secret, Class: "lang-pkgs", Type: "node-pkg", Packages: [{ Name: "sharp" }] }], error: secret };
}
function tls() {
  const fingerprints = { schemas: "0".repeat(32), objects: "1".repeat(32), roles: "2".repeat(32), sentinel: "3".repeat(32) };
  return { schema: 1, status: "passed", sourceCommit: commit, sourceStatus: "", platform: "linux/amd64", owner: secret, network: secret,
    images: { api: id("api"), worker: id("api"), migrate: id("api"), postgres: id("postgres"), rustfs: id("rustfs") },
    privateCertificatesRemoved: true, applicationPolicy: { ...policy, readOnly: true, network: secret },
    scripts: { "smoke-runtime-tls.mjs": hash("script"), [secret]: secret },
    runtimeInventory: { node: "22.23.3", openssl: "3.5.8", process: { uid: 65532, CapEff: capability.capEff, CapBnd: capability.capBnd, NoNewPrivs: "1", env: secret },
      pgBoss: { version: "12.3.4", dbModule: secret, dbSha256: hash("db-module") }, modules: { "storage.js": hash("storage"), "queue.js": hash("queue"), [secret]: secret } },
    cases: [{ kind: "trusted", path: "storage", status: "passed", exitCode: 0, elapsedMs: 12, result: { deleted: true, payloadSha256: hash("payload"), error: secret }, mutations: { http: 4, s3: 2, auth: 0, envelope: 0, data: 0, upgrades: 0 } },
      { kind: "rogue", path: "listener", status: "passed", exitCode: 1, refusal: { category: "rogue", codes: ["SELF_SIGNED_CERT_IN_CHAIN"], error: secret }, databaseMutation: { before: fingerprints, after: fingerprints, unchanged: true }, error: secret },
      { kind: "trusted", path: "api-startup", status: "passed", encryption: [{ role: "integrated_api", encrypted: true, protocol: "TLSv1.3", listener: true, query: secret }] },
      { kind: "trusted", path: "queue", status: "passed", result: { sent: true, warnings: [], encryption: { count: 2, listeners: 1, allEncrypted: true, protocols: ["TLSv1.3"] } } },
      { kind: "trusted", path: "db", status: "passed", result: { encryption: { ssl: true, version: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" } } }],
    fixtureCounters: { trusted: { http: 8, mutations: 3, implicit: { auth: 1, envelope: 2, data: 1, upgrades: 0, cleartextViolations: 0 }, starttls: { auth: 1, envelope: 2, data: 1, upgrades: 1, cleartextViolations: 0 }, extra: secret } },
    certificates: { privateKey: secret }, commands: [{ args: [secret], error: secret }], error: secret, logs: secret };
}
function gateway(dokploy = false) {
  return { schema: 2, status: "passed", platform: "linux/amd64", gatewayImage: id("gateway"), apiImage: id("api"), ...(dokploy ? { dokployImage: id("dokploy") } : {}), templateSha256: hash("template"),
    modes: Object.fromEntries(["standard", "marketing", "fallback"].map(mode => [mode, { image: id(mode === "standard" || !dokploy ? "gateway" : "dokploy"),
      templateSource: mode === "standard" ? "none" : dokploy ? "image" : "bind", effectiveConfigSha256: hash(`${mode} ${secret}\n`), initialRoutingPassed: true, passed: true,
      apiDnsRecovery: { recoveredMs: 250, passed: true, before: secret, after: secret }, ...(mode === "marketing" ? { marketingDnsRecovery: { recoveredMs: 300, passed: true } } : {}),
      checks: [{ passed: true, path: secret, upstreamResponse: { password: secret } }], base: secret, container: secret }])),
    app: { indexSha256: hash("index"), assetSha256: hash("asset"), assetPath: secret }, coldStart: { passed: true, apiRecoveredMs: 50, marketingRecoveredMs: 100, dnsQueries: [{ stdout: secret, stderr: secret }] },
    owner: secret, commands: [{ args: [secret], error: secret }], error: secret };
}
async function successfulReports(f) {
  const apiScan = scan("api"), gatewayScan = scan("gateway"), tlsReport = tls();
  const aggregate = { schema: 1, status: "scan-complete-requires-vendor-and-finding-assessment", sourceCommit: commit, sourceStatus: "", scanner: "aquasec/trivy:0.75.0@sha256:" + hash("scanner"),
    images: { api: { id: id("api"), os: "linux", architecture: "amd64", rootfs: { Type: "layers", Layers: [id("api-layer")] }, archiveSha256: hash("api-archive"), scanSha256: hash(json(apiScan)), Config: { Env: [secret] } },
      worker: { id: id("api"), os: "linux", architecture: "amd64", rootfs: { Type: "layers", Layers: [id("api-layer")] } },
      gateway: { id: id("gateway"), os: "linux", architecture: "amd64", rootfs: { Type: "layers", Layers: [id("gateway-layer")] }, archiveSha256: hash("gateway-archive"), scanSha256: hash(json(gatewayScan)) }, postgres: { id: id("postgres") }, rustfs: { id: id("rustfs") } },
    containerPolicies: { api: policy, worker: policy, migrate: { ...policy, state: "exited" } },
    database: { sha256: hash("db"), metadataSha256: hash("metadata"), metadata: { private: secret } },
    findings: Object.fromEntries(["api", "gateway"].map(role => [role, scan(role).Results[0].Vulnerabilities.map(v => ({ id: v.VulnerabilityID, package: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion, severity: v.Severity, target: secret, source: secret }))])),
    runtimeTls: { status: "passed", summarySha256: hash(json(tlsReport)), cases: tlsReport.cases.length }, invocations: [{ command: secret, args: [secret] }], error: secret };
  for (const [name, value] of [["runtime-evidence.json", aggregate], ["api-runtime.json", inventory()], ["worker-runtime.json", inventory()], ["api-scan.json", apiScan], ["gateway-scan.json", gatewayScan], ["runtime-tls/summary.json", tlsReport],
    ["gateway-config/gateway-config-evidence.json", gateway()], ["dokploy-gateway-config/gateway-config-evidence.json", gateway(true)],
    ["api-os.txt", `ID=debian\nVERSION_ID="13.7"\nPRETTY_NAME="${secret}"\n`], ["gateway-os.txt", `ID=alpine\nVERSION_ID=3.24.0\n${secret}\n`],
    ["nginx-version.txt", `nginx version: nginx/1.30.5\nconfigure arguments: ${secret}\n`], ["scanner-version.txt", `Version: 0.75.0\n${secret}\n`], ["nginx-effective.txt", secret]]) await f.save(name, value);
  for (const directory of ["gateway-config", "dokploy-gateway-config"]) for (const mode of ["standard", "marketing", "fallback"]) await f.save(`${directory}/${mode}-nginx-effective.txt`, `${mode} ${secret}\n`);
  await f.save("unknown.json", secret); await f.save("api.tar", secret); await f.save("cache/db/trivy.db", secret); await f.save("built-index.html", secret);
  return { aggregate, tlsReport, apiScan };
}
async function noSecrets(f) {
  assert.deepEqual((await readdir(f.output)).sort(), [...runtimeEvidenceFiles].sort());
  for (const name of runtimeEvidenceFiles) {
    const content = await readFile(join(f.output, name), "utf8"); assert.ok(!content.includes(secret), name);
    assert.equal((await stat(join(f.output, name))).mode & 0o777, 0o600);
  }
  const sums = (await readFile(join(f.output, "checksums.txt"), "utf8")).trim().split("\n");
  assert.deepEqual(sums, await Promise.all(runtimeEvidenceFiles.slice(0, 2).map(async name => `${hash(await readFile(join(f.output, name)))}  ${name}`)));
}
test("actual writer-shaped fields survive reconstruction and only three safe files leave the reports", async () => {
  const f = await fixture();
  try {
    await successfulReports(f); const summary = await f.project(); await noSecrets(f);
    assert.equal(summary.evidenceCompleteness, "complete"); assert.equal(summary.offlineReplay, false); assert.equal(summary.releaseCertification, "not-provided");
    assert.equal(summary.source.tree, tree); assert.equal(summary.source.treeKind, "tracked-git-tree"); assert.equal(summary.source.dirty, false);
    assert.equal(summary.reports["api-runtime.json"].data.identityBinding, "same-directory-runtime-aggregate-association");
    assert.equal(summary.reports["api-runtime.json"].data.nativeVersions.heif, "1.23.5");
    assert.equal(summary.reports["api-runtime.json"].data.initProcess.uid, 65532); assert.equal(summary.reports["api-runtime.json"].data.svgText.visiblePixels, 145);
    assert.equal(summary.nativeVersions.nginx, "1.30.5"); assert.equal(summary.nativeVersions.api.os.version, "13.7");
    assert.deepEqual(summary.reports["runtime-evidence.json"].data.findings.api.map(row => row.severity), ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
    assert.equal(summary.reports["api-scan.json"].data.results[0].findings.length, 5); assert.equal(summary.reports["api-scan.json"].data.results[1].findings.length, 0);
    assert.equal(summary.reports["runtime-tls/summary.json"].data.caseResults[1].databaseMutation.hashesEqual, true);
    assert.equal(summary.reports["runtime-tls/summary.json"].data.runtimeInventory.pgBoss.dbSha256, hash("db-module"));
    assert.equal(summary.reports["dokploy-gateway-config/gateway-config-evidence.json"].data.modes.marketing.marketingDnsRecovery.recoveredMs, 300);
    assert.equal(summary.reports["dokploy-gateway-config/gateway-config-evidence.json"].data.coldStart.apiRecoveredMs, 50);
    assert.equal(summary.reportHashes["nginx-effective.txt"], hash(secret));
    for (const name of ["unknown.json", "api.tar", "cache/db/trivy.db", "built-index.html"]) assert.equal(summary.reportHashes[name], undefined);
    assert.equal(summary.deployedChecks.avifEncodeDecode, "not-individually-recorded");
  } finally { await f.close(); }
});
for (const outcome of ["failure", "cancelled", "skipped"]) test(`${outcome} smoke outcome is independent of complete recorded evidence`, async () => {
  const f = await fixture();
  try { await successfulReports(f); const summary = await f.project({ acceptanceStatus: outcome, jobStatus: "failure" });
    assert.equal(summary.acceptance.productionSmoke, outcome); assert.equal(summary.acceptance.jobAtProjection, "failure"); assert.equal(summary.evidenceCompleteness, "complete"); await noSecrets(f);
  } finally { await f.close(); }
});
test("missing reports and skipped execution produce safe partial evidence without zero-finding claims", async () => {
  const f = await fixture();
  try { const summary = await f.project({ acceptanceStatus: "skipped", jobStatus: "failure" }); assert.equal(summary.evidenceCompleteness, "partial");
    assert.equal(summary.reports["runtime-evidence.json"].data, undefined); assert.deepEqual(summary.reportHashes, {}); await noSecrets(f);
  } finally { await f.close(); }
});
test("failure after a passed case preserves mutations and differing database fingerprints without promoting the matrix", async () => {
  const f = await fixture();
  try {
    const { aggregate, tlsReport } = await successfulReports(f); tlsReport.status = "incomplete";
    tlsReport.cases[1].databaseMutation.after = { ...tlsReport.cases[1].databaseMutation.before, sentinel: "4".repeat(32) };
    tlsReport.cases[0].mutations.auth = 1; tlsReport.cases.push({ kind: "expired", path: "worker-startup", status: "failed", error: secret });
    aggregate.runtimeTls.summarySha256 = hash(json(tlsReport)); aggregate.status = "incomplete";
    await f.save("runtime-evidence.json", aggregate); await f.save("runtime-tls/summary.json", tlsReport);
    const summary = await f.project({ acceptanceStatus: "failure", jobStatus: "failure" }); const data = summary.reports["runtime-tls/summary.json"].data;
    assert.equal(summary.evidenceCompleteness, "partial"); assert.equal(data.reportedStatus, "incomplete"); assert.equal(data.caseResults[1].status, "passed");
    assert.equal(data.caseResults[1].databaseMutation.reportedUnchanged, true); assert.equal(data.caseResults[1].databaseMutation.hashesEqual, false); assert.equal(data.caseResults[0].mutations.auth, 1);
    assert.equal(data.caseResults.at(-1).status, "failed"); await noSecrets(f);
  } finally { await f.close(); }
});
test("early failed gateway and aggregate retain only available safe sections", async () => {
  const f = await fixture();
  try {
    await successfulReports(f); await f.save("gateway-config/gateway-config-evidence.json", { schema: 2, platform: "linux/amd64", status: "incomplete", gatewayImage: id("gateway"), apiImage: id("api"), templateSha256: hash("template"), modes: {}, error: secret });
    const summary = await f.project({ acceptanceStatus: "failure" }); assert.equal(summary.evidenceCompleteness, "partial");
    assert.equal(summary.reports["gateway-config/gateway-config-evidence.json"].data.reportedStatus, "incomplete"); await noSecrets(f);
  } finally { await f.close(); }
});
for (const problem of ["commit", "worker-image", "gateway-image", "tls-image", "tls-hash", "scan-hash", "scan-image", "config-hash"]) test(`identity or digest mismatch: ${problem}`, async () => {
  const f = await fixture();
  try {
    const { aggregate, tlsReport, apiScan } = await successfulReports(f); let rejected = "runtime-evidence.json";
    if (problem === "commit") aggregate.sourceCommit = "c".repeat(40);
    if (problem === "worker-image") aggregate.images.worker.id = id("other");
    if (problem === "gateway-image") { const report = gateway(); report.gatewayImage = id("other"); await f.save("gateway-config/gateway-config-evidence.json", report); rejected = "gateway-config/gateway-config-evidence.json"; }
    if (problem === "tls-image") { tlsReport.images.postgres = id("other"); aggregate.runtimeTls.summarySha256 = hash(json(tlsReport)); await f.save("runtime-tls/summary.json", tlsReport); rejected = "runtime-tls/summary.json"; }
    if (problem === "tls-hash") { aggregate.runtimeTls.summarySha256 = hash("wrong"); rejected = "runtime-tls/summary.json"; }
    if (problem === "scan-hash") { aggregate.images.api.scanSha256 = hash("wrong"); rejected = "api-scan.json"; }
    if (problem === "scan-image") { apiScan.Metadata.ImageID = id("other"); apiScan.Metadata.DiffIDs = [id("other-layer")]; aggregate.images.api.scanSha256 = hash(json(apiScan)); await f.save("api-scan.json", apiScan); rejected = "api-scan.json"; }
    if (problem === "config-hash") { await f.save("gateway-config/standard-nginx-effective.txt", "different\n"); rejected = "gateway-config/gateway-config-evidence.json"; }
    await f.save("runtime-evidence.json", aggregate); const summary = await f.project(); assert.equal(summary.evidenceCompleteness, "partial");
    assert.equal(summary.reports[rejected].status, "missing-invalid-or-unsafe"); await noSecrets(f);
  } finally { await f.close(); }
});
for (const problem of ["malformed", "oversized", "symlink", "hardlink", "fifo", "directory"]) test(`unsafe named report: ${problem}`, async () => {
  const f = await fixture();
  try {
    await successfulReports(f); const path = join(f.runtime, "api-runtime.json"); await rm(path);
    if (problem === "malformed") await writeFile(path, `{${secret}`);
    if (problem === "oversized") { await writeFile(path, ""); await truncate(path, maximumReportBytes + 1); }
    if (["symlink", "hardlink"].includes(problem)) { const privatePath = join(f.root, "private"); await writeFile(privatePath, secret); await (problem === "symlink" ? symlink : link)(privatePath, path); }
    if (problem === "fifo") execFileSync("mkfifo", [path]);
    if (problem === "directory") await mkdir(path);
    const summary = await f.project(); assert.equal(summary.evidenceCompleteness, "partial"); assert.equal(summary.reports["api-runtime.json"].status, "missing-invalid-or-unsafe");
    assert.equal(summary.reportHashes["api-runtime.json"] !== undefined, problem === "malformed"); await noSecrets(f);
  } finally { await f.close(); }
});
for (const location of ["root", "ancestor", "subdirectory"]) test(`symlinked input ${location} is never followed`, async () => {
  const f = await fixture();
  try {
    await successfulReports(f); let runtimeDirectory = f.runtime;
    if (location === "root") { runtimeDirectory = join(f.root, "root-link"); await symlink(f.runtime, runtimeDirectory); }
    if (location === "ancestor") { const ancestor = join(f.root, "ancestor-link"); await symlink(f.root, ancestor); runtimeDirectory = join(ancestor, "raw"); }
    if (location === "subdirectory") { const target = join(f.root, "tls-target"); await mkdir(target); await writeFile(join(target, "summary.json"), json(tls())); await rm(join(f.runtime, "runtime-tls"), { recursive: true }); await symlink(target, join(f.runtime, "runtime-tls")); }
    const summary = await f.project({ runtimeDirectory }); assert.equal(summary.evidenceCompleteness, "partial");
    if (location === "subdirectory") assert.equal(summary.reportHashes["runtime-tls/summary.json"], undefined); else assert.deepEqual(summary.reportHashes, {});
    await noSecrets(f);
  } finally { await f.close(); }
});
test("unknown links and files are ignored, while stale or overlapping output directories are refused", async () => {
  const f = await fixture();
  try {
    await successfulReports(f); await symlink("/proc/self/environ", join(f.runtime, "unknown-link.json")); const summary = await f.project(); await noSecrets(f);
    assert.equal(summary.reportHashes["unknown-link.json"], undefined); const previous = await readFile(join(f.output, "runtime-summary.json"));
    await assert.rejects(f.project()); assert.deepEqual(await readFile(join(f.output, "runtime-summary.json")), previous);
    await assert.rejects(f.project({ outputDirectory: join(f.runtime, "child") })); await assert.rejects(f.project({ outputDirectory: f.root }));
  } finally { await f.close(); }
});
test("unknown source state or arbitrary git failures cannot become clean-source proof or leak text", async () => {
  const f = await fixture();
  try {
    const { aggregate } = await successfulReports(f); delete aggregate.sourceStatus; await f.save("runtime-evidence.json", aggregate);
    const summary = await f.project({ execute: async () => { throw new Error(secret); } }); assert.equal(summary.source.dirty, "unknown");
    assert.equal(summary.source.status, "missing-invalid-or-unsafe"); assert.equal(summary.reports["runtime-evidence.json"].data.sourceDirty, "unknown");
    assert.equal(summary.evidenceCompleteness, "partial"); await noSecrets(f);
  } finally { await f.close(); }
});
test("SVG-text errors retain a fixed result category without exposing native error messages", async () => {
  const f = await fixture();
  try { await successfulReports(f); const input = inventory(); input.svgText = { error: secret }; await f.save("api-runtime.json", input);
    const summary = await f.project(); assert.deepEqual(summary.reports["api-runtime.json"].data.svgText, { status: "failed" }); await noSecrets(f);
  } finally { await f.close(); }
});

test("gateway setup failure before template read keeps safe image association without a fake hash", async () => {
  const f = await fixture();
  try {
    await successfulReports(f); await f.save("gateway-config/gateway-config-evidence.json", { schema: 2, platform: "linux/amd64", status: "incomplete", gatewayImage: id("gateway"), apiImage: id("api"), modes: {}, error: secret });
    const summary = await f.project({ acceptanceStatus: "failure" }); const data = summary.reports["gateway-config/gateway-config-evidence.json"].data;
    assert.equal(summary.evidenceCompleteness, "partial"); assert.equal(data.images.api, id("api")); assert.equal(data.templateSha256, null); await noSecrets(f);
  } finally { await f.close(); }
});
test("passed aggregate cannot make unequal database fingerprints complete evidence", async () => {
  const f = await fixture();
  try {
    const { aggregate, tlsReport } = await successfulReports(f); tlsReport.cases[1].databaseMutation.after = { ...tlsReport.cases[1].databaseMutation.before, sentinel: "4".repeat(32) };
    aggregate.runtimeTls.summarySha256 = hash(json(tlsReport)); await f.save("runtime-evidence.json", aggregate); await f.save("runtime-tls/summary.json", tlsReport);
    const summary = await f.project(); assert.equal(summary.evidenceCompleteness, "partial"); assert.equal(summary.reports["runtime-tls/summary.json"].data.reportedStatus, "passed");
    assert.equal(summary.reports["runtime-tls/summary.json"].data.caseResults[1].databaseMutation.hashesEqual, false); await noSecrets(f);
  } finally { await f.close(); }
});
test("shared hash-only scanner input uses the same bounded snapshot and rejects oversized input", async () => {
  const f = await fixture();
  try {
    await successfulReports(f); const report = await readEvidenceSnapshot(f.runtime, "api-scan.json", ["api-scan.json"]);
    assert.equal(report.sha256, hash(report.bytes)); assert.equal(JSON.parse(report.bytes).Metadata.ImageID, id("api"));
    await truncate(join(f.runtime, "api-scan.json"), maximumReportBytes + 1);
    await assert.rejects(readEvidenceSnapshot(f.runtime, "api-scan.json", ["api-scan.json"]));
    const summary = await f.project(); assert.equal(summary.reportHashes["api-scan.json"], undefined); assert.equal(summary.evidenceCompleteness, "partial"); await noSecrets(f);
  } finally { await f.close(); }
});
test("shared snapshot reader refuses traversal even when a caller lists it", async () => {
  const f = await fixture();
  try { await writeFile(join(f.root, "private"), secret); await assert.rejects(readEvidenceSnapshot(f.runtime, "../private", ["../private"])); }
  finally { await f.close(); }
});
test("symlinked output parent cannot redirect sanitized writes", async () => {
  const f = await fixture();
  try { const redirected = join(f.root, "output-parent-link"); await symlink(f.root, redirected); await assert.rejects(f.project({ outputDirectory: join(redirected, "safe") })); }
  finally { await f.close(); }
});

const requiredTextFiles = ["api-os.txt", "gateway-os.txt", "nginx-version.txt", "nginx-effective.txt", "scanner-version.txt",
  ...["gateway-config", "dokploy-gateway-config"].flatMap(directory => ["standard", "marketing", "fallback"].map(mode => `${directory}/${mode}-nginx-effective.txt`))];
for (const name of requiredTextFiles) test(`missing required text snapshot makes otherwise successful evidence partial: ${name}`, async () => {
  const f = await fixture();
  try {
    await successfulReports(f); await rm(join(f.runtime, name)); const summary = await f.project();
    assert.equal(summary.evidenceCompleteness, "partial"); assert.equal(summary.reportHashes[name], undefined);
    assert.equal(summary.acceptance.productionSmoke, "success"); assert.equal(summary.reports["runtime-tls/summary.json"].status, "projected");
    if (name.includes("-nginx-effective")) assert.equal(summary.reports[`${name.split("/")[0]}/gateway-config-evidence.json`].status, "missing-invalid-or-unsafe");
    await noSecrets(f);
  } finally { await f.close(); }
});
for (const problem of ["symlink", "hardlink", "fifo", "oversized"]) test(`unsafe mode config snapshot cannot silently verify a recorded digest: ${problem}`, async () => {
  const f = await fixture();
  try {
    await successfulReports(f); const name = "dokploy-gateway-config/marketing-nginx-effective.txt", path = join(f.runtime, name); await rm(path);
    if (["symlink", "hardlink"].includes(problem)) { const privatePath = join(f.root, "private-mode-config"); await writeFile(privatePath, secret); await (problem === "symlink" ? symlink : link)(privatePath, path); }
    if (problem === "fifo") execFileSync("mkfifo", [path]);
    if (problem === "oversized") { await writeFile(path, ""); await truncate(path, maximumReportBytes + 1); }
    const summary = await f.project(); assert.equal(summary.evidenceCompleteness, "partial"); assert.equal(summary.reportHashes[name], undefined);
    assert.equal(summary.reports["dokploy-gateway-config/gateway-config-evidence.json"].status, "missing-invalid-or-unsafe");
    assert.equal(summary.reports["gateway-config/gateway-config-evidence.json"].status, "projected"); assert.equal(summary.reports["api-runtime.json"].status, "projected");
    await noSecrets(f);
  } finally { await f.close(); }
});
test("all required text snapshots absent preserves useful JSON evidence without a complete claim", async () => {
  const f = await fixture();
  try {
    await successfulReports(f); for (const name of requiredTextFiles) await rm(join(f.runtime, name));
    const summary = await f.project(); assert.equal(summary.evidenceCompleteness, "partial"); assert.deepEqual(summary.nativeVersions, {});
    assert.ok(requiredTextFiles.every(name => !Object.hasOwn(summary.reportHashes, name)));
    assert.equal(summary.reports["runtime-evidence.json"].status, "projected"); assert.equal(summary.reports["api-scan.json"].status, "projected");
    assert.equal(summary.reports["runtime-tls/summary.json"].data.caseResults.length, 5); await noSecrets(f);
  } finally { await f.close(); }
});
for (const [name, nativeKey] of [["api-os.txt", "api"], ["gateway-os.txt", "gateway"], ["nginx-version.txt", "nginx"], ["scanner-version.txt", "scanner"]]) test(`malformed native/version text prevents completeness while keeping its snapshot hash: ${name}`, async () => {
  const f = await fixture();
  try {
    await successfulReports(f); await f.save(name, secret); const summary = await f.project();
    assert.equal(summary.evidenceCompleteness, "partial"); assert.equal(summary.nativeVersions[nativeKey], undefined); assert.equal(summary.reportHashes[name], hash(secret));
    assert.ok(Object.values(summary.reports).every(report => report.status === "projected")); assert.equal(summary.acceptance.productionSmoke, "success");
    await noSecrets(f);
  } finally { await f.close(); }
});

test("older runtime inventories retain source bindings and report unknown charset evidence", async () => {
  const f = await fixture();
  try {
    await successfulReports(f); const summary = await f.project();
    assert.equal(summary.schema, 1); assert.equal(summary.evidenceCompleteness, "complete");
    for (const role of ["api", "worker"]) {
      const data = summary.reports[`${role}-runtime.json`].data;
      assert.equal(data.sourceCommit, commit); assert.equal(data.imageId, id("api"));
      assert.equal(data.charset.pid1StartupEnvironment.status, "unknown");
      assert.equal(data.charset.execProbeEnvironment.status, "unknown");
      assert.equal(data.charset.nativeState.glibCharset, "not-observed");
    }
    await noSecrets(f);
  } finally { await f.close(); }
});
test("three-file projection retains safe charset scopes without promoting them to native state or a gate", async () => {
  const f = await fixture();
  try {
    await successfulReports(f);
    const input = inventory();
    input.charset = observeRuntimeCharsetEvidence({ environment: { LANG: "C.UTF-8", GCONV_PATH: secret, LIBCHARSET_ALIAS_DIR: secret },
      io: { openSync() { throw new Error(secret); } } });
    await f.save("api-runtime.json", input);
    const summary = await f.project();
    const data = summary.reports["api-runtime.json"].data;
    assert.deepEqual(data.charset, input.charset); assert.equal(summary.evidenceCompleteness, "complete");
    assert.equal(data.charset.pid1StartupEnvironment.status, "unknown");
    assert.deepEqual(data.charset.execProbeEnvironment.variables.LANG, { status: "recognized", value: "C.UTF-8" });
    assert.deepEqual(data.charset.execProbeEnvironment.variables.LIBCHARSET_ALIAS_DIR, { status: "other" });
    await noSecrets(f);
  } finally { await f.close(); }
});
for (const problem of ["extra-root", "arbitrary-value", "path-value", "extra-hash", "native-state", "wrong-bound"]) {
  test(`three-file projection rejects unsafe charset section without losing older runtime evidence: ${problem}`, async () => {
    const f = await fixture();
    try {
      await successfulReports(f); const input = inventory();
      input.charset = observeRuntimeCharsetEvidence({ environment: {}, io: { openSync() { throw new Error(secret); } } });
      if (problem === "extra-root") input.charset.rawEnvironment = secret;
      if (problem === "arbitrary-value") input.charset.execProbeEnvironment.variables.LANG = { status: "recognized", value: secret };
      if (problem === "path-value") input.charset.execProbeEnvironment.variables.GCONV_PATH = { status: "other", value: secret };
      if (problem === "extra-hash") input.charset.execProbeEnvironment.variables.LOCPATH = { status: "other", sha256: hash(secret) };
      if (problem === "native-state") input.charset.nativeState.glibCharset = secret;
      if (problem === "wrong-bound") input.charset.pid1StartupEnvironment.readLimitBytes = 1_000_000_000;
      await f.save("api-runtime.json", input); const summary = await f.project();
      const report = summary.reports["api-runtime.json"];
      assert.equal(report.status, "projected"); assert.equal(report.data.versions.node, "22.23.3");
      assert.equal(report.data.charset.pid1StartupEnvironment.status, "unknown");
      assert.equal(report.data.charset.execProbeEnvironment.status, "unknown");
      assert.equal(summary.evidenceCompleteness, "complete");
      assert.ok(!(await readFile(join(f.output, "runtime-summary.json"), "utf8")).includes(`"sha256": "${hash(secret)}"`));
      await noSecrets(f);
    } finally { await f.close(); }
  });
}
