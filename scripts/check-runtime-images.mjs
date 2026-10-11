import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runtimeCharsetProbeSource } from "./runtime-charset-evidence.mjs";

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
  const runtimeProbe = String.raw`
    ${runtimeCharsetProbeSource}
    import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
    import { createHash } from "node:crypto";
    import { createSecureContext, rootCertificates } from "node:tls";
    const { default: sharp } = await import("sharp");
    const fingerprint = bytes => createHash("sha256").update(bytes).digest("hex");
    const paths = directory => existsSync(directory) ? readdirSync(directory) : [];
    const tools = ["/usr/local/lib/node_modules/npm", "/usr/local/lib/node_modules/corepack", "/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg", "/nodejs/bin/npm", "/bin/sh", "/usr/bin/perl", "/usr/bin/mount", "/usr/bin/su", "/usr/bin/gzip", "/usr/bin/infocmp", ...paths("/opt").filter(p => p.startsWith("yarn-v")).map(p => "/opt/" + p)];
    const productionStorePresent = existsSync("/app/node_modules/.pnpm");
    const developmentPackages = paths("/app/node_modules/.pnpm").filter(p => /^(?:drizzle-kit@|esbuild@|@esbuild\+|@esbuild-kit\+)/.test(p));
    function privileges(path) {
      const status = readFileSync(path, "utf8");
      return {
        uid: status.match(/^Uid:\s*(\d+)/m)?.[1],
        capEff: status.match(/^CapEff:\s*(\w+)$/m)?.[1],
        capBnd: status.match(/^CapBnd:\s*(\w+)$/m)?.[1],
        noNewPrivs: status.match(/^NoNewPrivs:\s*(\d+)$/m)?.[1],
      };
    }
    const search = readFileSync("/etc/resolv.conf", "utf8").split("\n").filter(line => /^(?:search|domain)\s/.test(line)).flatMap(line => line.replace(/[#;].*$/, "").trim().split(/\s+/).slice(1));
    const localDomain = (process.env.LOCALDOMAIN ?? "").split(/\s+/).filter(Boolean);
    const ca = readFileSync("/etc/ssl/certs/ca-certificates.crt");
    createSecureContext({ ca });
    const timezone = zone => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date("2026-01-01T12:00:00Z")).map(p => [p.type, p.value]));
    function fonts(directory) {
      if (!existsSync(directory)) return [];
      return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = directory + "/" + entry.name;
        if (entry.isDirectory()) return fonts(path);
        return entry.isFile() && /\.(?:ttf|otf|ttc|woff2?)$/i.test(path) ? [{ path, bytes: statSync(path).size, sha256: fingerprint(readFileSync(path)) }] : [];
      });
    }
    const fontInventory = ["/usr/share/fonts", "/usr/local/share/fonts"].flatMap(fonts).sort((a, b) => a.path.localeCompare(b.path));
    let svgText;
    try {
      const { data, info } = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><text x="4" y="24" font-family="sans-serif" font-size="20">Vardum</text></svg>')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let visiblePixels = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) visiblePixels++;
      svgText = { ...info, visiblePixels, sha256: fingerprint(data) };
    } catch (error) { svgText = { error: error.message }; }
    console.log(JSON.stringify({ charset: observeRuntimeCharsetEvidence(), versions: process.versions, sharp: sharp.versions, uid: process.getuid(), process: privileges("/proc/self/status"), initProcess: privileges("/proc/1/status"), inheritedTools: Object.fromEntries(tools.map(path => [path, existsSync(path)])), productionStorePresent, developmentPackages, trust: { systemCABundleBytes: ca.length, systemCACertificates: (ca.toString().match(/-----BEGIN CERTIFICATE-----/g) ?? []).length, systemCABundleSha256: fingerprint(ca), nodeBundledCACertificates: rootCertificates.length }, timezone: { utc: timezone("UTC"), prague: timezone("Europe/Prague"), filesPresent: ["/usr/share/zoneinfo/UTC", "/usr/share/zoneinfo/Europe/Prague"].every(existsSync) }, fontInventory, svgText, resolver: { searchCount: search.length, longestSearchDomain: Math.max(0, ...search.map(s => s.length)), localDomainSet: process.env.LOCALDOMAIN !== undefined, longestLocalDomain: Math.max(0, ...localDomain.map(s => s.length)) } }));
  `;
  for (const service of ["api", "worker"]) {
    const runtime = JSON.parse(docker("exec", containers[service], "node", "--input-type=module", "-e", runtimeProbe));
    assert.ok(Object.values(runtime.inheritedTools).every(present => present === false), "Inherited package managers and unused essential tools must be absent from runtime");
    assert.equal(runtime.productionStorePresent, true, "Production package inventory must be present");
    assert.deepEqual(runtime.developmentPackages, [], "Development Drizzle/esbuild packages must be absent from runtime");
    assert.equal(runtime.uid, 65532, "Application runtime must use the pinned nonroot UID");
    for (const [name, process] of Object.entries({ probe: runtime.process, application: runtime.initProcess })) {
      assert.equal(process.uid, "65532", `${service} ${name} must use the pinned nonroot UID`);
      for (const cap of ["capEff", "capBnd"]) {
        assert.match(process[cap] ?? "", /^[0-9a-f]+$/i, `${service} ${name} ${cap} was not recorded`);
        assert.equal(BigInt("0x" + process[cap]), 0n, `${service} ${name} ${cap} must be zero`);
      }
      assert.equal(process.noNewPrivs, "1", `${service} ${name} must prohibit privilege gain on exec`);
    }
    assert.ok(runtime.trust.systemCACertificates > 0 && runtime.trust.nodeBundledCACertificates > 0, "System and Node CA inventories must be present");
    assert.equal(runtime.timezone.utc.hour, "12");
    assert.equal(runtime.timezone.prague.hour, "13");
    assert.equal(runtime.timezone.filesPresent, true, "Runtime timezone files must be present");
    await save(`${service}-runtime.json`, runtime);
  }
  const migrations = docker("ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=migrate").trim().split(/\s+/);
  assert.equal(migrations.length, 1, "Exactly one completed migration container is required");
  assert.match(migrations[0], /^[a-f0-9]{12,64}$/);
  const migration = JSON.parse(docker("inspect", migrations[0]))[0];
  assert.equal(migration.Image, recorded.images.api.id, "Migration must use the API runtime image");
  assert.equal(migration.State.Status, "exited");
  assert.equal(migration.State.ExitCode, 0, "Migration must have completed successfully");
  for (const service of ["api", "worker", "migrate"]) {
    const container = service === "migrate" ? migration : JSON.parse(docker("inspect", containers[service]))[0];
    assert.ok(container.HostConfig.CapDrop?.includes("ALL"), `${service} must drop all capabilities`);
    assert.ok(container.HostConfig.SecurityOpt?.some(option => /^no-new-privileges(?::true)?$/.test(option)), `${service} must prohibit privilege gain on exec`);
    recorded.containerPolicies ??= {};
    recorded.containerPolicies[service] = { user: container.Config.User, capDrop: container.HostConfig.CapDrop, securityOpt: container.HostConfig.SecurityOpt, state: container.State.Status, exitCode: container.State.ExitCode };
  }
  // Reuse the exact running service images after acceptance has verified the
  // application identity, completed migration and privilege policies. Mutable
  // Compose tags (especially postgres:17-alpine) are never TLS gate inputs.
  for (const service of ["postgres", "rustfs"]) {
    const ids = docker("ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`).trim().split(/\s+/);
    assert.equal(ids.length, 1, `Exactly one running ${service} is required for TLS acceptance`);
    assert.match(ids[0], /^[a-f0-9]{12,64}$/);
    const id = docker("inspect", "--format", "{{.Image}}", ids[0]).trim();
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    recorded.images[service] = { id };
  }
  run(process.execPath, ["scripts/smoke-runtime-tls.mjs", recorded.images.api.id, recorded.images.worker.id, migration.Image, recorded.images.postgres.id, recorded.images.rustfs.id, join(output, "runtime-tls")]);
  const tlsSummary = JSON.parse(await readFile(join(output, "runtime-tls/summary.json"), "utf8"));
  assert.equal(tlsSummary.status, "passed", "Actual application TLS matrix must pass before image acceptance");
  recorded.runtimeTls = { status: tlsSummary.status, summarySha256: await hash(join(output, "runtime-tls/summary.json")), cases: tlsSummary.cases.length };
  for (const service of ["api", "gateway"]) {
    await save(`${service}-os.txt`, service === "api"
      ? docker("exec", containers.api, "node", "--input-type=module", "-e", 'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync("/etc/os-release", "utf8"))')
      : docker("exec", containers.gateway, "cat", "/etc/os-release"));
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
