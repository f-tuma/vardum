import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const scanner = "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa";
const [project, destination] = process.argv.slice(2);
assert.match(project ?? "", /^vardum-smoke-[0-9]+$/, "Use a disposable smoke project");
assert.ok(destination, "Usage: check-runtime-images.mjs SMOKE_PROJECT EMPTY_REPORT_DIRECTORY");
const output = resolve(destination);
// Refuse replacement of previous proof and keep the database for exact replay.
await mkdir(output, { mode: 0o700 });
await mkdir(join(output, "cache"));
const recorded = { schema: 1, startedAt: new Date().toISOString(), project, scanner, images: {}, invocations: [] };
function run(command, args) {
  recorded.invocations.push({ command, args });
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 ** 2 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}
function docker(...args) { return run("docker", args); }
async function hash(path) {
  const h = createHash("sha256");
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest("hex");
}
const save = (name, data) => writeFile(join(output, name), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
try {
  recorded.sourceCommit = run("git", ["rev-parse", "HEAD"]).trim();
  recorded.sourceStatus = run("git", ["status", "--porcelain", "--untracked-files=all"]);
  const containers = {};
  for (const service of ["api", "worker", "gateway"]) {
    const ids = docker("ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`).trim().split(/\s+/);
    assert.equal(ids.length, 1, `Exactly one running ${service} is required`);
    assert.match(ids[0], /^[a-f0-9]{12,64}$/);
    containers[service] = ids[0];
    const id = docker("inspect", "--format", "{{.Image}}", ids[0]).trim();
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    const image = JSON.parse(docker("image", "inspect", id))[0];
    assert.equal(`${image.Os}/${image.Architecture}`, "linux/amd64", "Proof is bounded to linux/amd64");
    recorded.images[service] = { id, os: image.Os, architecture: image.Architecture, repoDigests: image.RepoDigests, rootfs: image.RootFS };
  }
  assert.equal(recorded.images.api.id, recorded.images.worker.id, "API and worker must use the same runtime image");
  run(process.execPath, ["scripts/smoke-gateway-config.mjs", recorded.images.gateway.id, recorded.images.api.id, join(output, "gateway-config")]);
  const runtimeProbe = `
    import { existsSync, readFileSync, readdirSync } from "node:fs";
    const { default: sharp } = await import("sharp");
    const tools = ["/usr/local/lib/node_modules/npm", "/usr/local/lib/node_modules/corepack", "/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg", ...readdirSync("/opt").filter(p => p.startsWith("yarn-v")).map(p => "/opt/" + p)];
    const search = readFileSync("/etc/resolv.conf", "utf8").split("\\n").filter(line => /^(?:search|domain)\\s/.test(line)).flatMap(line => line.replace(/[#;].*$/, "").trim().split(/\\s+/).slice(1));
    const localDomain = (process.env.LOCALDOMAIN ?? "").split(/\\s+/).filter(Boolean);
    console.log(JSON.stringify({ versions: process.versions, sharp: sharp.versions, uid: process.getuid(), capEff: readFileSync("/proc/self/status", "utf8").match(/^CapEff:\\s*(\\w+)$/m)?.[1], inheritedTools: Object.fromEntries(tools.map(path => [path, existsSync(path)])), resolver: { searchCount: search.length, longestSearchDomain: Math.max(0, ...search.map(s => s.length)), localDomainSet: process.env.LOCALDOMAIN !== undefined, longestLocalDomain: Math.max(0, ...localDomain.map(s => s.length)) } }));
  `;
  for (const service of ["api", "worker"]) {
    const runtime = JSON.parse(docker("exec", containers[service], "node", "--input-type=module", "-e", runtimeProbe));
    assert.ok(Object.values(runtime.inheritedTools).every(present => present === false), "Inherited package-manager tools must be absent from runtime");
    assert.notEqual(runtime.uid, 0, "Application runtime must not run as root");
    assert.match(runtime.capEff ?? "", /^[0-9a-f]+$/i, "Effective capabilities were not recorded");
    assert.equal(BigInt("0x" + runtime.capEff) & (1n << 21n), 0n, "Application runtime must not have CAP_SYS_ADMIN");
    await save(`${service}-runtime.json`, runtime);
  }
  for (const service of ["api", "gateway"]) {
    await save(`${service}-os.txt`, docker("exec", containers[service], "cat", "/etc/os-release"));
    const archive = join(output, `${service}.tar`);
    docker("image", "save", "--output", archive, recorded.images[service].id);
    recorded.images[service].archiveSha256 = await hash(archive);
  }
  await save("nginx-version.txt", docker("exec", containers.gateway, "sh", "-c", "nginx -V 2>&1"));
  await save("nginx-effective.txt", docker("exec", containers.gateway, "sh", "-c", "nginx -T 2>&1"));
  docker("pull", scanner);
  const scannerArgs = ["run", "--rm", "--read-only", "--user", `${process.getuid()}:${process.getgid()}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp", "--mount", `type=bind,src=${output},dst=/evidence`, "--mount", `type=bind,src=${output},dst=/input,readonly`];
  await save("scanner-version.txt", docker(...scannerArgs, "--network", "none", scanner, "--version"));
  docker(...scannerArgs, scanner, "image", "--cache-dir", "/evidence/cache", "--download-db-only");
  const db = join(output, "cache/db");
  recorded.database = { metadata: JSON.parse(await readFile(join(db, "metadata.json"), "utf8")), sha256: await hash(join(db, "trivy.db")), metadataSha256: await hash(join(db, "metadata.json")) };
  recorded.findings = {};
  for (const service of ["api", "gateway"]) {
    docker(...scannerArgs, "--network", "none", scanner, "image", "--cache-dir", "/evidence/cache", "--skip-db-update", "--skip-java-db-update", "--offline-scan", "--scanners", "vuln", "--list-all-pkgs", "--format", "json", "--output", `/evidence/${service}-scan.json`, "--input", `/input/${service}.tar`);
    const report = JSON.parse(await readFile(join(output, `${service}-scan.json`), "utf8"));
    assert.ok(report.Metadata?.OS?.Family && report.Metadata?.OS?.Name, "Scanner did not detect an OS");
    assert.ok(report.Results?.some(result => result.Class === "os-pkgs" && result.Packages?.length), "Scanner did not inventory OS packages");
    recorded.images[service].scanSha256 = await hash(join(output, `${service}-scan.json`));
    recorded.findings[service] = (report.Results ?? []).flatMap(result => (result.Vulnerabilities ?? []).map(v => ({ target: result.Target, class: result.Class, id: v.VulnerabilityID, package: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion ?? "", severity: v.Severity, source: v.PrimaryURL })));
  }
  recorded.completedAt = new Date().toISOString();
  recorded.status = "scan-complete-requires-vendor-and-finding-assessment";
  await save("runtime-evidence.json", recorded);
  console.log(`Runtime image evidence retained at ${output}; full findings and exact database are retained. This is not a safety certification.`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(recorded.findings).map(([service, findings]) => [service, findings.reduce((counts, v) => ({ ...counts, [v.severity]: (counts[v.severity] ?? 0) + 1 }), {})]))));
} catch (error) {
  recorded.status = "incomplete";
  recorded.error = error.message;
  await save("runtime-evidence.json", recorded);
  throw error;
}
