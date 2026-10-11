#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { ordinaryEvidenceDirectory, readEvidenceSnapshot } from "./evidence-snapshot.mjs";
export { maximumReportBytes } from "./evidence-snapshot.mjs";
import { projectRuntimeCharsetEvidence } from "./runtime-charset-evidence.mjs";
import { projectGatewayReport, projectRuntimeReport, projectTlsReport } from "./server-candidate-evidence.mjs";

export const runtimeEvidenceFiles = Object.freeze(["runtime-summary.json", "runtime-summary.txt", "checksums.txt"]);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executeFile = promisify(execFile);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const object = value => { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value; };
const sha = value => { assert.match(value ?? "", /^[a-f0-9]{64}$/); return value; };
const imageId = value => { assert.match(value ?? "", /^sha256:[a-f0-9]{64}$/); return value; };
const commitId = value => { assert.match(value ?? "", /^[a-f0-9]{40}$/); return value; };
const bounded = value => { assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000); return value; };
const bool = value => { assert.equal(typeof value, "boolean"); return value; };
const list = (value, limit = 100_000) => { assert.ok(Array.isArray(value) && value.length <= limit); return value; };
const oneOf = (value, values) => { assert.ok(values.includes(value)); return value; };
const version = value => { assert.match(value ?? "", /^[0-9][A-Za-z0-9+_.~-]{0,63}$/); return value; };
const taxonomy = value => { assert.match(value ?? "", /^[a-z][a-z0-9-]{0,31}$/); return value; };
const optional = (input, fields, project) => Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, project(input[key])]));
const sourceDirty = value => typeof value === "string" ? value.length !== 0 : "unknown";
const outcomes = ["success", "failure", "cancelled", "skipped", "unknown"];
const runtimeNames = ["node", "acorn", "ada", "amaro", "ares", "brotli", "cjs_module_lexer", "cldr", "icu", "llhttp", "modules", "napi", "nbytes", "ncrypto", "nghttp2", "nghttp3", "ngtcp2", "openssl", "simdjson", "simdutf", "sqlite", "tz", "undici", "unicode", "uv", "uvwasi", "v8", "zlib", "zstd"];
const nativeNames = ["aom", "archive", "cairo", "cgif", "exif", "expat", "ffi", "fontconfig", "freetype", "fribidi", "glib", "harfbuzz", "heif", "highway", "imagequant", "lcms", "mozjpeg", "pango", "pixman", "png", "proxy-libintl", "rsvg", "sharp", "spng", "tiff", "uhdr", "vips", "webp", "xml", "xml2", "zlib", "zlib-ng"];
const tools = ["/usr/local/lib/node_modules/npm", "/usr/local/lib/node_modules/corepack", "/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg", "/nodejs/bin/npm", "/bin/sh", "/usr/bin/perl", "/usr/bin/mount", "/usr/bin/su", "/usr/bin/gzip", "/usr/bin/infocmp"];
const imageRoles = ["api", "worker", "gateway", "postgres", "rustfs"];
const modes = ["standard", "marketing", "fallback"];
const kinds = ["trusted", "rogue", "expired", "wrong-san"];
const tlsPaths = ["bucket", "storage", "smtp-implicit", "smtp-starttls", "db", "queue", "listener", "queue-migrate", "full-migrate", "api-startup", "worker-startup", "worker-job"];
const certificateCodes = ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"];
const moduleNames = ["storage.js", "mail.js", "db/index.js", "queue.js", "queue-migrate.js", "migrate.js", "server.js", "worker.js"];
const jsonFiles = ["runtime-evidence.json", "api-runtime.json", "worker-runtime.json", "api-scan.json", "gateway-scan.json", "gateway-config/gateway-config-evidence.json", "dokploy-gateway-config/gateway-config-evidence.json", "runtime-tls/summary.json"];
const textFiles = ["api-os.txt", "gateway-os.txt", "nginx-version.txt", "nginx-effective.txt", "scanner-version.txt", ...["gateway-config", "dokploy-gateway-config"].flatMap(directory => modes.map(mode => `${directory}/${mode}-nginx-effective.txt`))];
const approvedFiles = [...jsonFiles, ...textFiles];

function inside(root, path) {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}
function privileges(input, uppercase = false) {
  object(input);
  const result = { uid: typeof input.uid === "number" ? bounded(input.uid) : Number(oneOf(input.uid, ["0", "65532", "1000"])) };
  for (const [field, raw] of [["capEff", uppercase ? "CapEff" : "capEff"], ["capBnd", uppercase ? "CapBnd" : "capBnd"]]) {
    assert.match(input[raw] ?? "", /^[a-f0-9]{1,16}$/i); result[field] = input[raw].toLowerCase();
  }
  result.noNewPrivs = oneOf(input[uppercase ? "NoNewPrivs" : "noNewPrivs"], ["0", "1"]);
  return result;
}
function policy(input) {
  object(input);
  assert.match(input.user ?? "", /^[0-9]{1,10}(?::[0-9]{1,10})?$/);
  return { user: input.user, dropsAllCapabilities: list(input.capDrop, 64).includes("ALL"),
    noNewPrivileges: list(input.securityOpt, 64).some(value => typeof value === "string" && /^no-new-privileges(?::true)?$/.test(value)),
    ...optional(input, ["readOnly"], bool) };
}
function runtimeInventory(input) {
  object(input);
  const fonts = list(input.fontInventory, 10_000);
  const result = {
    charset: projectRuntimeCharsetEvidence(input.charset),
    versions: optional(object(input.versions), runtimeNames, version), nativeVersions: optional(object(input.sharp), nativeNames, version),
    uid: bounded(input.uid), process: privileges(input.process), initProcess: privileges(input.initProcess),
    inheritedTools: optional(object(input.inheritedTools), tools, bool), productionStorePresent: bool(input.productionStorePresent),
    developmentPackageCount: list(input.developmentPackages, 10_000).length,
    trust: { ...optional(object(input.trust), ["systemCABundleBytes", "systemCACertificates", "nodeBundledCACertificates"], bounded), systemCABundleSha256: sha(input.trust.systemCABundleSha256) },
    timezone: { utcHour: oneOf(input.timezone?.utc?.hour, ["12"]), pragueHour: oneOf(input.timezone?.prague?.hour, ["13"]), filesPresent: bool(input.timezone.filesPresent) },
    fonts: { count: fonts.length, files: fonts.map(font => ({ bytes: bounded(font.bytes), sha256: sha(font.sha256) })) },
    resolver: { ...optional(object(input.resolver), ["searchCount", "longestSearchDomain", "longestLocalDomain"], bounded), localDomainSet: bool(input.resolver.localDomainSet) },
  };
  object(input.svgText);
  result.svgText = input.svgText.error !== undefined ? { status: "failed" } : {
    status: "recorded", ...optional(input.svgText, ["width", "height", "channels", "size", "visiblePixels"], bounded), sha256: sha(input.svgText.sha256),
  };
  return result;
}
function runtimeReport(input, expectedCommit) {
  assert.equal(input.schema, 1);
  const base = projectRuntimeReport(input, expectedCommit);
  if (base.images.api && base.images.worker) assert.equal(base.images.api.id, base.images.worker.id);
  for (const role of imageRoles) if (base.images[role]) {
    const image = input.images[role];
    if (image.os !== undefined || image.architecture !== undefined) {
      assert.equal(`${image.os}/${image.architecture}`, "linux/amd64"); base.images[role].platform = "linux/amd64";
    }
    if (image.rootfs !== undefined) {
      assert.equal(image.rootfs.Type, "layers"); base.images[role].rootfsDiffIds = list(image.rootfs.Layers, 1000).map(imageId);
    }
  }
  const policies = {};
  for (const role of ["api", "worker", "migrate"]) if (input.containerPolicies?.[role]) {
    const raw = input.containerPolicies[role];
    policies[role] = { ...policy(raw), state: oneOf(raw.state, ["running", "exited", "created", "dead", "restarting", "paused", "removing"]), exitCode: bounded(raw.exitCode) };
  }
  const { status, ...approved } = base;
  return { ...approved, reportedStatus: status, sourceDirty: sourceDirty(input.sourceStatus), containerPolicies: policies };
}
function scanReport(input) {
  object(input);
  const metadata = object(input.Metadata);
  const result = { os: { family: taxonomy(metadata.OS?.Family), version: version(metadata.OS?.Name) }, results: [] };
  if (metadata.ImageID !== undefined) result.scannerImageId = imageId(metadata.ImageID);
  if (metadata.DiffIDs !== undefined) result.rootfsDiffIds = list(metadata.DiffIDs, 1000).map(imageId);
  for (const raw of list(input.Results, 10_000)) {
    const projected = projectRuntimeReport({ sourceCommit: "0".repeat(40), findings: { api: list(raw.Vulnerabilities ?? []).map(finding => ({ id: finding.VulnerabilityID, package: finding.PkgName, installed: finding.InstalledVersion, fixed: finding.FixedVersion ?? "", severity: finding.Severity })) } }, "0".repeat(40));
    result.results.push({ class: oneOf(raw.Class, ["os-pkgs", "lang-pkgs"]), type: taxonomy(raw.Type),
      packageCount: list(raw.Packages ?? []).length, findings: projected.findings.api });
  }
  assert.ok(result.results.some(item => item.class === "os-pkgs" && item.packageCount > 0));
  return result;
}
function protocols(values) { return [...new Set(list(values, 1000).map(value => oneOf(value, ["TLSv1.2", "TLSv1.3"])))]; }
function encryption(input) {
  object(input);
  if (input.ssl !== undefined) {
    const result = { encrypted: bool(input.ssl), protocol: oneOf(input.version, ["TLSv1.2", "TLSv1.3"]) };
    if (input.cipher !== undefined) { assert.match(input.cipher, /^[A-Z0-9_-]{1,64}$/); result.cipher = input.cipher; }
    return result;
  }
  return { count: bounded(input.count), listeners: bounded(input.listeners), allEncrypted: bool(input.allEncrypted), protocols: protocols(input.protocols) };
}
function tlsReport(input, expectedCommit) {
  assert.equal(input.schema, 1);
  const { status, ...base } = projectTlsReport(input, expectedCommit);
  assert.equal(input.platform, "linux/amd64");
  assert.equal(base.images.api, base.images.worker); assert.equal(base.images.api, base.images.migrate);
  const result = { ...base, reportedStatus: status, sourceDirty: sourceDirty(input.sourceStatus), platform: "linux/amd64", caseResults: [] };
  if (input.applicationPolicy) result.applicationPolicy = policy(input.applicationPolicy);
  if (input.scripts) result.scripts = optional(object(input.scripts), ["smoke-runtime-tls.mjs", "runtime-tls-probe.mjs", "runtime-tls-fixtures.mjs"], sha);
  if (input.runtimeInventory) {
    const raw = input.runtimeInventory;
    result.runtimeInventory = { node: version(raw.node), openssl: version(raw.openssl), process: privileges(raw.process, true),
      pgBoss: { version: version(raw.pgBoss?.version), dbSha256: sha(raw.pgBoss?.dbSha256) }, modules: optional(object(raw.modules), moduleNames, sha) };
  }
  for (const raw of input.cases) {
    const item = { kind: oneOf(raw.kind, kinds), path: oneOf(raw.path, tlsPaths), status: oneOf(raw.status, ["passed", "failed"]), ...optional(raw, ["elapsedMs", "exitCode"], bounded) };
    if (raw.refusal) item.refusal = { category: oneOf(raw.refusal.category, kinds.slice(1)), codes: list(raw.refusal.codes, 6).map(code => oneOf(code, certificateCodes)) };
    if (raw.mutations) item.mutations = optional(object(raw.mutations), ["http", "s3", "auth", "envelope", "data", "upgrades"], bounded);
    if (raw.databaseMutation) {
      const fingerprints = value => optional(object(value), ["schemas", "objects", "roles", "sentinel"], hash => { assert.match(hash ?? "", /^[a-f0-9]{32}$/); return hash; });
      const beforeMd5 = fingerprints(raw.databaseMutation.before), afterMd5 = fingerprints(raw.databaseMutation.after);
      assert.equal(Object.keys(beforeMd5).length, 4); assert.equal(Object.keys(afterMd5).length, 4);
      item.databaseMutation = { reportedUnchanged: bool(raw.databaseMutation.unchanged), beforeMd5, afterMd5,
        hashesEqual: Object.keys(beforeMd5).every(key => beforeMd5[key] === afterMd5[key]) };
    }
    if (raw.encryption) {
      const connections = list(raw.encryption, 1000);
      item.encryption = { sessions: connections.length, encryptedSessions: connections.filter(connection => connection.encrypted === true).length,
        listeners: connections.filter(connection => connection.listener === true).length, protocols: protocols(connections.map(connection => connection.protocol)) };
    }
    if (raw.result) {
      const data = object(raw.result);
      item.result = optional(data, ["created", "sent", "deleted", "migrated", "queueSchemaPresent", "objectDeleted", "app", "queue", "drizzle", "runtimeRole", "notified"], bool);
      if (data.payloadSha256 !== undefined) item.result.payloadSha256 = sha(data.payloadSha256);
      if (data.encryption) item.result.encryption = encryption(data.encryption);
      if (data.warnings) item.result.warningCount = list(data.warnings, 1000).length;
    }
    result.caseResults.push(item);
  }
  if (input.fixtureCounters) result.fixtureCounters = Object.fromEntries(kinds.filter(kind => input.fixtureCounters[kind]).map(kind => {
    const raw = object(input.fixtureCounters[kind]);
    return [kind, { ...optional(raw, ["http", "mutations"], bounded), ...Object.fromEntries(["implicit", "starttls"].filter(mode => raw[mode]).map(mode => [mode, optional(object(raw[mode]), ["auth", "envelope", "data", "upgrades", "cleartextViolations"], bounded)])) }];
  }));
  return result;
}
function gatewayReport(input) {
  assert.equal(input.schema, 2); assert.equal(input.platform, "linux/amd64");
  // Setup can fail before the writer records a template hash. Keep proven
  // image association and available counts without manufacturing that hash.
  const projected = input.templateSha256 !== undefined ? projectGatewayReport(input) : {
    status: ["passed", "incomplete", "interrupted"].includes(input.status) ? input.status : "incomplete",
    images: { gateway: imageId(input.gatewayImage), api: imageId(input.apiImage),
      ...(input.dokployImage !== undefined ? { "gateway-dokploy": imageId(input.dokployImage) } : {}) },
    templateSha256: null,
    modes: Object.fromEntries(modes.filter(mode => input.modes?.[mode]).map(mode => [mode, {
      checks: list(input.modes[mode].checks).length,
      passedChecks: input.modes[mode].checks.filter(check => check.passed === true).length,
      passed: input.modes[mode].passed === true,
    }])), coldStartPassed: input.coldStart?.passed === true,
  };
  const { status, ...base } = projected;
  for (const mode of modes) if (base.modes[mode]) {
    const raw = input.modes[mode];
    const expected = mode === "standard" ? base.images.gateway : base.images["gateway-dokploy"] ?? base.images.gateway;
    if (raw.image !== undefined) assert.equal(imageId(raw.image), expected);
    Object.assign(base.modes[mode], optional(raw, ["effectiveConfigSha256"], sha), optional(raw, ["initialRoutingPassed"], bool));
    if (raw.templateSource !== undefined) base.modes[mode].templateSource = oneOf(raw.templateSource, ["none", "image", "bind"]);
    for (const field of ["apiDnsRecovery", "marketingDnsRecovery"]) if (raw[field]) base.modes[mode][field] = { passed: bool(raw[field].passed), recoveredMs: bounded(raw[field].recoveredMs) };
  }
  return { ...base, reportedStatus: status, platform: "linux/amd64",
    appHashes: input.app ? { indexSha256: sha(input.app.indexSha256), assetSha256: sha(input.app.assetSha256) } : null,
    coldStart: input.coldStart ? { passed: bool(input.coldStart.passed), ...optional(input.coldStart, ["apiRecoveredMs", "marketingRecoveredMs"], bounded) } : null };
}
async function checkoutSource(expectedCommit, execute) {
  const git = async (...args) => (await execute("git", args, { cwd: repository, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const commit = commitId(await git("rev-parse", "HEAD")); assert.equal(commit, expectedCommit);
  const tree = commitId(await git("rev-parse", "HEAD^{tree}"));
  return { status: "recorded", commit, tree, treeKind: "tracked-git-tree", dirty: sourceDirty(await git("status", "--porcelain", "--untracked-files=all")) };
}

export async function writeRuntimeEvidence({ runtimeDirectory, outputDirectory, expectedCommit, acceptanceStatus = "unknown", jobStatus = "unknown", execute = executeFile }) {
  expectedCommit = commitId(expectedCommit);
  oneOf(acceptanceStatus, outcomes); oneOf(jobStatus, outcomes);
  runtimeDirectory = resolve(runtimeDirectory); outputDirectory = resolve(outputDirectory);
  assert.ok(!inside(runtimeDirectory, outputDirectory) && !inside(outputDirectory, runtimeDirectory), "Use a new separate projection directory");
  await ordinaryEvidenceDirectory(dirname(outputDirectory));
  await mkdir(outputDirectory, { mode: 0o700 }); // Existing/stale directories are never replaced.
  const summary = { schema: 1, scope: "Sanitized ordinary workflow evidence; recorded findings require vendor assessment. Hashes do not supply offline replay or release certification.",
    offlineReplay: false, releaseCertification: "not-provided", platformScope: "linux/amd64", expectedCommit,
    acceptance: { productionSmoke: acceptanceStatus, jobAtProjection: jobStatus }, source: { status: "missing-invalid-or-unsafe", dirty: "unknown", treeKind: "tracked-git-tree" },
    evidenceCompleteness: "partial", reports: {}, reportHashes: {}, nativeVersions: {},
    deployedChecks: { svgRasterization: "not-individually-recorded", avifEncodeDecode: "not-individually-recorded", runtimeDatabaseRole: "not-individually-recorded" } };
  try { summary.source = await checkoutSource(expectedCommit, execute); } catch { /* Never serialize arbitrary git errors. */ }
  const snapshots = {};
  for (const name of approvedFiles) {
    try { snapshots[name] = await readEvidenceSnapshot(runtimeDirectory, name, approvedFiles); summary.reportHashes[name] = snapshots[name].sha256; } catch { /* Unsafe/missing inputs are not read. */ }
  }
  const parse = name => JSON.parse(snapshots[name].bytes.toString("utf8"));
  const project = (name, operation) => {
    try { summary.reports[name] = { status: "projected", data: operation(parse(name)) }; }
    catch { summary.reports[name] = { status: "missing-invalid-or-unsafe" }; }
  };
  project(jsonFiles[0], input => runtimeReport(input, expectedCommit));
  const runtime = summary.reports[jsonFiles[0]].data;
  for (const role of ["api", "worker"]) project(`${role}-runtime.json`, input => {
    assert.ok(runtime?.images[role]);
    return { identityBinding: "same-directory-runtime-aggregate-association", imageId: runtime.images[role].id, sourceCommit: expectedCommit, ...runtimeInventory(input) };
  });
  for (const role of ["api", "gateway"]) project(`${role}-scan.json`, input => {
    const image = runtime?.images[role]; assert.ok(image);
    assert.equal(image.scanSha256, snapshots[`${role}-scan.json`].sha256);
    const data = scanReport(input);
    if (data.scannerImageId !== undefined && data.scannerImageId !== image.id) {
      assert.ok(image.rootfsDiffIds?.length && data.rootfsDiffIds?.length);
      assert.deepEqual(data.rootfsDiffIds, image.rootfsDiffIds);
    }
    return { imageId: image.id, binding: "recorded-scan-hash", ...data };
  });
  for (const directory of ["gateway-config", "dokploy-gateway-config"]) project(`${directory}/gateway-config-evidence.json`, input => {
    const data = gatewayReport(input);
    assert.equal(data.images.api, runtime?.images.api?.id); assert.equal(data.images.gateway, runtime?.images.gateway?.id);
    for (const mode of modes) if (data.modes[mode]?.effectiveConfigSha256) {
      const configSnapshot = snapshots[`${directory}/${mode}-nginx-effective.txt`];
      assert.ok(configSnapshot, "Recorded effective config needs an ordinary bounded snapshot");
      assert.equal(data.modes[mode].effectiveConfigSha256, configSnapshot.sha256);
    }
    return { sourceBinding: "matching-runtime-image-ids", ...data };
  });
  project("runtime-tls/summary.json", input => {
    const data = tlsReport(input, expectedCommit);
    for (const role of ["api", "worker", "postgres", "rustfs"]) assert.equal(data.images[role], runtime?.images[role]?.id);
    if (runtime.runtimeTls) assert.equal(runtime.runtimeTls.summarySha256, snapshots["runtime-tls/summary.json"].sha256);
    return data;
  });
  for (const role of ["api", "gateway"]) if (snapshots[`${role}-os.txt`]) {
    const text = snapshots[`${role}-os.txt`].bytes.toString("utf8");
    const id = text.match(/^ID=["']?([a-z0-9_-]{1,32})["']?$/m)?.[1];
    const release = text.match(/^VERSION_ID=["']?([0-9][A-Za-z0-9+_.~-]{0,63})["']?$/m)?.[1];
    if (runtime?.images[role] && id && release) summary.nativeVersions[role] = { imageId: runtime.images[role].id, os: { id, version: release } };
  }
  const nginx = snapshots["nginx-version.txt"]?.bytes.toString("utf8").match(/^nginx version: nginx\/([0-9]+\.[0-9]+\.[0-9]+)$/m)?.[1];
  if (runtime?.images.gateway && nginx) summary.nativeVersions.nginx = nginx;
  const scanner = snapshots["scanner-version.txt"]?.bytes.toString("utf8").match(/^Version: ([0-9]+\.[0-9]+\.[0-9]+)$/m)?.[1];
  if (scanner) summary.nativeVersions.scanner = scanner;
  const gatewayComplete = directory => {
    const data = summary.reports[`${directory}/gateway-config-evidence.json`]?.data;
    return data?.reportedStatus === "passed" && data.templateSha256 && data.coldStartPassed && modes.every(mode => data.modes[mode]?.passed && data.modes[mode].checks > 0 && data.modes[mode].passedChecks === data.modes[mode].checks && data.modes[mode].effectiveConfigSha256 && data.modes[mode].initialRoutingPassed && data.modes[mode].apiDnsRecovery?.passed && (mode !== "marketing" || data.modes[mode].marketingDnsRecovery?.passed));
  };
  const tls = summary.reports["runtime-tls/summary.json"].data;
  const nativeVersionsComplete = Boolean(summary.nativeVersions.api && summary.nativeVersions.gateway && summary.nativeVersions.nginx && summary.nativeVersions.scanner);
  if (summary.source.status === "recorded" && jsonFiles.every(name => summary.reports[name].status === "projected") &&
      textFiles.every(name => Object.hasOwn(snapshots, name)) && nativeVersionsComplete &&
      runtime.reportedStatus === "scan-complete-requires-vendor-and-finding-assessment" &&
      ["api", "gateway"].every(role => Object.hasOwn(runtime.findings, role)) && gatewayComplete("gateway-config") && gatewayComplete("dokploy-gateway-config") &&
      tls.reportedStatus === "passed" && tls.cases > 0 && tls.passedCases === tls.cases && tls.privateCertificatesRemoved &&
      tls.caseResults.every(item => !item.databaseMutation || item.databaseMutation.hashesEqual)) summary.evidenceCompleteness = "complete";
  const lines = ["Sanitized ordinary workflow evidence; no offline replay or release certification; findings require vendor assessment.",
    `Expected source: ${expectedCommit}`, `Tracked Git tree: ${summary.source.tree ?? "unknown"}`, `Source dirty: ${summary.source.dirty}`,
    `Production smoke outcome: ${acceptanceStatus}`, `Job status before projection: ${jobStatus}`, `Evidence completeness: ${summary.evidenceCompleteness}`,
    "Deployed SVG rasterization, AVIF encode/decode and database-role results are not individually recorded; see production smoke outcome."];
  for (const name of jsonFiles) lines.push(`${name}: ${summary.reports[name].status}${summary.reports[name].data?.reportedStatus ? ` (${summary.reports[name].data.reportedStatus})` : ""}`);
  const contents = [JSON.stringify(summary, null, 2) + "\n", lines.join("\n") + "\n"];
  for (const [index, bytes] of contents.entries()) await writeFile(join(outputDirectory, runtimeEvidenceFiles[index]), bytes, { mode: 0o600, flag: "wx" });
  await writeFile(join(outputDirectory, runtimeEvidenceFiles[2]), contents.map((bytes, index) => `${digest(bytes)}  ${runtimeEvidenceFiles[index]}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return summary;
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    "expected-commit": { type: "string" }, "acceptance-status": { type: "string", default: "unknown" }, "job-status": { type: "string", default: "unknown" },
  } });
  assert.equal(positionals.length, 2, "Usage: runtime-evidence.mjs RAW_REPORTS NEW_OUTPUT_DIRECTORY --expected-commit SHA --acceptance-status OUTCOME --job-status STATUS");
  await writeRuntimeEvidence({ runtimeDirectory: positionals[0], outputDirectory: positionals[1], expectedCommit: values["expected-commit"], acceptanceStatus: values["acceptance-status"], jobStatus: values["job-status"] });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("Could not finalize sanitized runtime evidence; no raw fallback is permitted."); process.exitCode = 1;
});
