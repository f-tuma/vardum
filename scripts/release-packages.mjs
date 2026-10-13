import { smokeInstalledAdoption } from "./smoke-cli-adoption.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { boundedBytes } from "./github-release-api.mjs";

export const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const directories = ["packages/shared", "apps/cli", "apps/mcp"];
// Reviewed public baseline. A source version bump never changes this selection.
export const publicCompatibilityClients = Object.freeze({
  "@vardum/shared": "0.2.0", "@vardum/cli": "0.6.0", "@vardum/mcp": "0.2.0",
});
export const publicCompatibilityRelease = () => ({ packages: Object.entries(publicCompatibilityClients)
  .map(([name, version]) => ({ name, version, manifest: { name, version } })) });
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// Public install instructions are audited from packed bytes, not source Markdown.
export function validatePackageReadme(readme, manifest, packages) {
  const targets = [
    ...readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g),
    ...readme.matchAll(/^ *\[[^\]]+\]:\s*(\S+)/gm),
  ].map(match => match[1]);
  assert.ok(targets.includes(`https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`),
    `${manifest.name} README must link to its exact public npm version`);
  assert.ok(readme.includes(`${manifest.name}@${manifest.version}`),
    `${manifest.name} README must include an exact installation pin`);
  for (const [, name, version] of readme.matchAll(/(@vardum\/(?:cli|mcp|shared))@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)) {
    assert.equal(version, packages.find(pkg => pkg.name === name)?.version,
      `${name} README installation pin differs from the release batch`);
  }
  for (const target of targets) {
    let url;
    try { url = new URL(target); } catch { assert.fail("Packaged README links must be public absolute URLs"); }
    assert.equal(url.protocol, "https:", "Packaged README links must use HTTPS");
    assert.ok(!["github.com", "raw.githubusercontent.com"].includes(url.hostname),
      "Packaged setup must not depend on repository access");
    assert.ok(!url.username && !url.password, "Packaged README links must not contain credentials");
  }
}

export async function validateRelease(directory, {
  expectedPackages, expectedManifestSha256, expectedManifestBytes,
} = {}) {
  const manifestBytes = await readFile(join(directory, "release.json"));
  if (expectedManifestSha256) {
    assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), expectedManifestSha256,
      "Release manifest differs from the reviewed origin");
    assert.equal(manifestBytes.length, expectedManifestBytes);
    const files = ["release.json", ...expectedPackages.map(pkg => pkg.file)];
    assert.deepEqual((await readdir(directory)).sort(), files.sort(), "Unexpected retained release files");
    for (const file of files) assert.ok((await lstat(join(directory, file))).isFile(), "Retained files must be regular files");
  }
  const release = JSON.parse(manifestBytes);
  assert.equal(release.schema, 1);
  assert.equal(release.packages.length, directories.length);
  for (const [index, path] of directories.entries()) {
    const source = expectedPackages?.[index] ?? await json(join(repo, path, "package.json"));
    const entry = release.packages[index];
    if (expectedPackages) {
      assert.equal(entry.integrity, source.integrity, "Untrusted manifest integrity");
      assert.equal((await lstat(join(directory, source.file))).size, source.bytes);
    }
    assert.equal(entry.name, source.name);
    assert.equal(entry.version, source.version);
    assert.equal(
      entry.file,
      `${source.name.replace("@", "").replace("/", "-")}-${source.version}.tgz`,
    );
    const archive = join(directory, entry.file);
    const archiveBytes = await readFile(archive);
    entry.bytes = archiveBytes.length;
    assert.equal(
      integrity(archiveBytes),
      entry.integrity,
      "Release archive changed after packing",
    );
    const { stdout } = await run("tar", [
      "-xzOf",
      archive,
      "package/package.json",
    ]);
    const manifest = JSON.parse(stdout);
    assert.equal(manifest.name, source.name);
    assert.equal(manifest.version, source.version);
    assert.ok(!manifest.private);
    for (const group of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, range] of Object.entries(manifest[group] ?? {})) {
        assert.doesNotMatch(
          range,
          /^(workspace:|link:|file:)/,
          `${name} must be installable outside the workspace`,
        );
        const local = release.packages.find((pkg) => pkg.name === name);
        if (local) assert.equal(range, `^${local.version}`);
      }
    }
    if (source.name !== "@vardum/shared") {
      assert.equal(
        manifest.dependencies["@vardum/shared"],
        `^${release.packages[0].version}`,
      );
      assert.equal(manifest.engines.node, ">=22");
    }
    const files = (await run("tar", ["-tzf", archive])).stdout
      .trim()
      .split("\n");
    assert.ok(files.includes("package/README.md"));
    // Retained historical batches have fixed reviewed hashes and old README contracts.
    // Current source/tag batches always receive the standalone-onboarding check.
    if (!expectedPackages) {
      const readme = (await run("tar", ["-xzOf", archive, "package/README.md"])).stdout;
      validatePackageReadme(readme, manifest, release.packages);
    }
    assert.ok(files.includes("package/dist/index.js"));
    assert.ok(
      files.every(
        (file) =>
          !/\.test\.|(?:^|\/)\.env(?:\.|$)|(?:^|\/)node_modules\//.test(file),
      ),
      "Do not ship tests, credentials or node_modules",
    );
    for (const bin of Object.values(manifest.bin ?? {})) {
      assert.ok(files.includes(`package/${bin}`), `Missing executable ${bin}`);
      assert.match(
        (await run("tar", ["-xzOf", archive, `package/${bin}`])).stdout,
        /^#!\/usr\/bin\/env node/,
      );
    }
    entry.manifest = manifest;
  }
  return release;
}

async function packRelease(directory) {
  await mkdir(directory, { recursive: true });
  assert.equal(
    (await readdir(directory)).length,
    0,
    "Choose an empty release directory; reviewed archives must not be overwritten",
  );
  await run(
    "pnpm",
    ["--filter", "@vardum/cli...", "--filter", "@vardum/mcp...", "build"],
    { cwd: repo },
  );
  const packages = [];
  for (const path of directories) {
    const source = await json(join(repo, path, "package.json"));
    await run("pnpm", ["pack", "--pack-destination", directory], {
      cwd: join(repo, path),
    });
    const file = `${source.name.replace("@", "").replace("/", "-")}-${source.version}.tgz`;
    packages.push({
      name: source.name,
      version: source.version,
      file,
      integrity: integrity(await readFile(join(directory, file))),
    });
  }
  await writeFile(
    join(directory, "release.json"),
    `${JSON.stringify({ schema: 1, packages }, null, 2)}\n`,
  );
  await validateRelease(directory);
  console.log(`Validated release archives: ${directory}`);
}

const installOutputLimit = 128_000;
const waitForInstall = ms => new Promise(resolve => setTimeout(resolve, ms));

function installRetryOptions(options) {
  assert.ok(options && typeof options === "object" && !Array.isArray(options), "Install retry options must be an object");
  assert.ok(Object.keys(options).every(key => ["attempts", "delayMs", "budgetMs"].includes(key)), "Unknown install retry option");
  const { attempts = 6, delayMs = 10_000, budgetMs = 180_000 } = options;
  assert.ok(Number.isSafeInteger(attempts) && attempts > 0, "Install attempts must be a positive integer");
  assert.ok(Number.isSafeInteger(delayMs) && delayMs >= 0, "Install delay must be a nonnegative integer");
  assert.ok(Number.isSafeInteger(budgetMs) && budgetMs > 0, "Install budget must be a positive integer");
  return { attempts, delayMs, budgetMs };
}

// Accept only npm's structured, single-target ETARGET from a normally exited
// install. stderr and the process error message are never used for classification.
function structuredInstallError(error) {
  if (typeof error?.stdout !== "string" || error.stdout.length > installOutputLimit) return undefined;
  let output;
  try { output = JSON.parse(error.stdout); } catch { return undefined; }
  if (!output || Array.isArray(output) || Object.keys(output).join() !== "error") return undefined;
  const target = output.error;
  if (!target || Array.isArray(target) || typeof target !== "object" || typeof target.code !== "string" ||
      typeof target.summary !== "string" || (target.detail !== undefined && typeof target.detail !== "string") ||
      Object.keys(target).some(key => !["code", "summary", "detail"].includes(key))) return undefined;
  // JSON.parse silently accepts duplicate keys. Refuse that ambiguous form,
  // including escaped spellings of keys, before trusting the npm error object.
  const tokens = [...error.stdout.matchAll(/"(?:\\.|[^"\\])*"|[:,{}[\]]/g)].map(match => match[0]);
  const keys = tokens.filter((token, index) => tokens[index + 1] === ":").map(token => JSON.parse(token));
  if (new Set(keys).size !== keys.length) return undefined;
  return target;
}

function retryableInstallSpec(error, pkg, release) {
  if (!Number.isInteger(error?.code) || error.code <= 0 || error.killed !== false || error.signal !== null) return undefined;
  const target = structuredInstallError(error);
  if (!target || target.code !== "ETARGET") return undefined;
  const missing = /^No matching version found for ([^\s]+)\.$/.exec(target.summary)?.[1];
  if (!missing || target.summary !== `No matching version found for ${missing}.`) return undefined;
  const allowed = new Set([`${pkg.name}@${pkg.version}`]);
  for (const [name, spec] of Object.entries(pkg.manifest.dependencies ?? {})) {
    const dependency = release.packages.find(entry => entry.name === name);
    if (dependency && spec === `^${dependency.version}`) allowed.add(`${name}@${spec}`);
  }
  return allowed.has(missing) ? missing : undefined;
}

export function isRetryableInstallTarget(error, pkg, release) {
  return Boolean(retryableInstallSpec(error, pkg, release));
}

const boundedDiagnostic = (value, limit) => String(value ?? "unknown").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit);
function installFailure(pkg, attempt, retry, remaining, reason, cause, missing) {
  const npmError = structuredInstallError(cause);
  const processStatus = cause ? `process code=${boundedDiagnostic(cause.code, 32)}, killed=${cause.killed === true}, signal=${boundedDiagnostic(cause.signal, 32)}` : "no npm process started";
  const diagnostic = npmError ? `${cause.killed === true || cause.signal ? `${processStatus}; ` : ""}` +
    `npm ${boundedDiagnostic(npmError.code, 32)}: ${boundedDiagnostic(npmError.summary, 240)}` : processStatus;
  return new Error(`Public npm install ${pkg.name}@${pkg.version} failed after ${attempt}/${retry.attempts} attempt(s) ` +
    `(common budget ${retry.budgetMs}ms, remaining ${Math.max(0, Math.floor(remaining))}ms): ${reason}` +
    `${missing ? `; missing ${missing}` : ""}; ${diagnostic}`, { cause });
}

async function installPublicConsumer(root, kind, pkg, release, retry, deadline, { execute, now, wait }) {
  let lastError, lastMissing;
  const failure = (attempt, reason, error = lastError, missing = lastMissing) =>
    installFailure(pkg, attempt, retry, deadline - now(), reason, error, missing);
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    if (now() >= deadline) throw failure(attempt - 1, "install budget exhausted");
    const attemptRoot = join(root, `${kind}-attempt-${attempt}`);
    const cwd = join(attemptRoot, "project"), home = join(attemptRoot, "home"), cache = join(attemptRoot, "cache");
    await mkdir(cwd, { recursive: true });
    await mkdir(home);
    await mkdir(cache);
    await writeFile(join(cwd, "package.json"), '{"private":true,"type":"module"}\n');
    const config = join(attemptRoot, "user.npmrc"), globalConfig = join(attemptRoot, "global.npmrc");
    await writeFile(config, "registry=https://registry.npmjs.org/\n@vardum:registry=https://registry.npmjs.org/\n");
    await writeFile(globalConfig, "");
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home };
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) {
      await rm(attemptRoot, { recursive: true, force: true });
      throw failure(attempt - 1, "install budget exhausted");
    }
    try {
      await execute("npm", ["install", "--json", "--userconfig", config, "--globalconfig", globalConfig,
        "--cache", cache, "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", `${pkg.name}@${pkg.version}`],
      { cwd, env, timeout: Math.min(120_000, remaining), maxBuffer: installOutputLimit });
      return { cwd, env };
    } catch (error) {
      lastError = error;
      await rm(attemptRoot, { recursive: true, force: true });
      lastMissing = retryableInstallSpec(error, pkg, release);
      if (!lastMissing) throw failure(attempt, "non-retryable npm failure", error);
      if (attempt === retry.attempts) throw failure(attempt, "ETARGET propagation did not settle", error);
      // Do not begin a sleep or a new attempt at/past the common CLI/MCP deadline.
      const remainingDelay = deadline - now();
      if (remainingDelay <= retry.delayMs) throw failure(attempt, "install budget exhausted", error);
      console.log(`Waiting for npm install propagation: ${pkg.name}@${pkg.version} (${attempt}/${retry.attempts})`);
      await wait(retry.delayMs);
    }
  }
}

// Test real npm resolution: CLI and MCP install separately by name. Explicitly
// installing the shared tarball alongside them could hide broken dependencies.
// Only third-party packages go to npmjs; this helper never publishes anything.
export async function withInstalledRelease(
  directory,
  action,
  { publicRegistry = false, expectedContract, installRetry, execute = run,
    now = () => performance.now(), wait = waitForInstall } = {},
) {
  // Server candidates reuse already-published client versions. They do not
  // repack npm artifacts (README-only changes can change archive integrity).
  const release = publicRegistry && !directory
    ? publicCompatibilityRelease()
    : await validateRelease(directory, expectedContract);
  const retry = installRetry === undefined ? undefined : installRetryOptions(installRetry);
  assert.ok(!retry || (publicRegistry && directory), "Install retry requires a validated public release directory");
  const root = await mkdtemp(join(tmpdir(), "vardum-consumer-"));
  const archives = new Map(
    await Promise.all(
      (publicRegistry ? [] : release.packages).map(async (pkg) => [
        pkg.file,
        await readFile(join(directory, pkg.file)),
      ]),
    ),
  );
  const registry = createServer((req, res) => {
    const path = decodeURIComponent(
      new URL(req.url, "http://fixture.invalid").pathname.slice(1),
    );
    if (path.startsWith("tarballs/")) {
      const bytes = archives.get(path.slice("tarballs/".length));
      if (bytes) return res.end(bytes);
    }
    const pkg = release.packages.find((entry) => entry.name === path);
    if (!pkg) {
      res.writeHead(404);
      return res.end();
    }
    const dist = {
      tarball: `http://127.0.0.1:${registry.address().port}/tarballs/${pkg.file}`,
      integrity: pkg.integrity,
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: pkg.name,
        "dist-tags": { latest: pkg.version },
        versions: { [pkg.version]: { ...pkg.manifest, dist } },
      }),
    );
  });
  try {
    if (!publicRegistry) await new Promise((yes, no) => {
      registry.once("error", no);
      registry.listen(0, "127.0.0.1", yes);
    });
    const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root };
    const installed = { root, publicRegistry };
    const consumerEnvironments = {};
    const deadline = retry ? now() + retry.budgetMs : undefined;
    for (const kind of ["cli", "mcp"]) {
      const pkg = release.packages.find(
        (entry) => entry.name === `@vardum/${kind}`,
      );
      let cwd = join(root, kind), consumerEnv = env;
      if (retry) {
        ({ cwd, env: consumerEnv } = await installPublicConsumer(root, kind, pkg, release, retry, deadline, { execute, now, wait }));
      } else {
        await mkdir(cwd);
        await writeFile(join(cwd, "package.json"), '{"private":true,"type":"module"}\n');
        const config = join(cwd, ".npmrc");
        const scopedRegistry = publicRegistry ? "https://registry.npmjs.org/"
          : `http://127.0.0.1:${registry.address().port}/`;
        await writeFile(config, `registry=https://registry.npmjs.org/\n@vardum:registry=${scopedRegistry}\n`);
        await execute("npm", ["install", "--userconfig", config, "--ignore-scripts", "--no-audit", "--no-fund",
          "--no-package-lock", `${pkg.name}@${pkg.version}`], { cwd, env, timeout: 120_000 });
      }
      consumerEnvironments[kind] = consumerEnv;
      const installedManifest = await json(join(cwd, "node_modules", pkg.name, "package.json"));
      assert.equal(installedManifest.version, pkg.version);
      const shared = release.packages.find((entry) => entry.name === "@vardum/shared");
      assert.equal((await json(join(cwd, "node_modules/@vardum/shared/package.json"))).version, shared.version);
      const binary = join(
        cwd,
        "node_modules/.bin",
        kind === "cli" ? "vardum" : "vardum-mcp",
      );
      await access(binary, constants.X_OK);
      const result = await execute(
        process.execPath,
        [binary, kind === "cli" ? "version" : "--version"],
        { cwd, env: consumerEnv },
      );
      assert.equal(result.stdout.trim(), pkg.version);
      installed[kind] = { cwd, binary, version: pkg.version };
    }
    const init = (...args) =>
      execute(process.execPath, [installed.cli.binary, "init", ...args, "--json"], {
        cwd: installed.cli.cwd,
        env: consumerEnvironments.cli,
        timeout: 15_000,
      });
    const initValues = [
      "--server",
      "https://example.com",
      "--workspace",
      "workspace",
      "--vard",
      "vard",
    ];
    const configPath = join(installed.cli.cwd, "vardum.json");
    assert.equal(
      JSON.parse((await init(...initValues, "--dry-run")).stdout).actions[0]
        .applied,
      false,
    );
    await assert.rejects(readFile(configPath), { code: "ENOENT" });
    assert.equal(JSON.parse((await init(...initValues)).stdout).changed, 1);
    assert.deepEqual(await json(configPath), {
      schema: 1,
      server: "https://example.com",
      workspace: "workspace",
      vard: "vard",
    });
    assert.equal(JSON.parse((await init(...initValues)).stdout).changed, 0);
    await assert.rejects(init(...initValues, "--vard", "other"), /--force/);
    await assert.rejects(
      init("--server", "https://example.com"),
      /--workspace, --vard/,
    );
    await action(installed);
    console.log(
      "Independent npm CLI/MCP installs passed (including transitive shared resolution)",
    );
  } finally {
    registry.closeAllConnections();
    if (registry.listening) await new Promise((yes) => registry.close(yes));
    await rm(root, { recursive: true, force: true });
  }
}

export const smokeClientOptions = () => ({
  publicRegistry: process.env.SMOKE_PUBLIC_CLIENTS === "1",
});

export async function registryState(release, { fetchImpl = fetch } = {}) {
  const states = [];
  for (const pkg of release.packages) {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 404) {
      states.push({ ...pkg, published: false });
      continue;
    }
    if (!response.ok)
      throw new Error(
        `Registry check failed: ${pkg.name} (${response.status})`,
      );
    const published = JSON.parse((await boundedBytes(response, 2_000_000)).toString("utf8"));
    assert.equal(
      published.dist?.integrity,
      pkg.integrity,
      `${pkg.name}@${pkg.version} already exists with different bytes; use a new version`,
    );
    assert.ok(Number.isSafeInteger(pkg.bytes) && pkg.bytes > 0, "Expected archive byte size is required");
    const tarballUrl = new URL(published.dist?.tarball);
    assert.ok(tarballUrl.protocol === "https:" && tarballUrl.hostname === "registry.npmjs.org" &&
      !tarballUrl.username && !tarballUrl.password && !tarballUrl.port && !tarballUrl.hash, "Unexpected npm tarball URL");
    const tarball = await fetchImpl(tarballUrl.href, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    assert.ok(tarball.ok, `Registry archive download failed: ${pkg.name} (${tarball.status})`);
    const bytes = await boundedBytes(tarball, pkg.bytes);
    assert.equal(bytes.length, pkg.bytes, "Registry archive size differs");
    assert.equal(integrity(bytes), pkg.integrity, "Registry tarball bytes differ from the tested archive");
    states.push({ ...pkg, published: true });
  }
  return states;
}

export async function waitForPublishedRelease(
  release,
  {
    attempts = 18,
    delayMs = 10_000,
    readState = registryState,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Retry only missing versions. Registry errors and conflicting hashes must
    // still fail immediately; never retry publication to fix propagation.
    const states = await readState(release);
    if (states.every((pkg) => pkg.published)) return states;
    if (attempt === attempts) break;
    console.log(`Waiting for npm registry propagation (${attempt}/${attempts})`);
    await wait(delayMs);
  }
  throw new Error("Not all release archives are available on npm yet");
}

// Both source and retained publication verify exact registry bytes before public
// installs. Compatibility smoke calls withInstalledRelease directly and stays single-attempt.
export async function verifyPublishedRelease(directory, action, { expectedContract, registryOptions, consumerOptions = {} } = {}) {
  const retry = installRetryOptions(consumerOptions.installRetry === undefined ? {} : consumerOptions.installRetry);
  const release = await validateRelease(directory, expectedContract);
  await waitForPublishedRelease(release, registryOptions);
  return withInstalledRelease(directory, action, { ...consumerOptions, expectedContract, publicRegistry: true, installRetry: retry });
}

// Preflight every package before the first write, including interrupted retries.
export async function publishRelease(directory, release, {
  validationOnly = false, readState = registryState,
  publish = async pkg => {
    const result = await run("npm", ["publish", join(directory, pkg.file), "--access", "public",
      "--registry", "https://registry.npmjs.org/"], { cwd: repo, timeout: 120_000 });
    process.stdout.write(result.stdout);
  },
} = {}) {
  const states = await readState(release);
  assert.equal(states.length, release.packages.length);
  for (const [index, pkg] of states.entries()) {
    assert.equal(pkg.name, release.packages[index].name);
    assert.equal(pkg.integrity, release.packages[index].integrity);
    assert.equal(typeof pkg.published, "boolean");
  }
  for (const pkg of states) {
    console.log(`${pkg.name}@${pkg.version}: ${pkg.published ? "identical archive already published" : "version available"}`);
    if (!validationOnly && !pkg.published) await publish(pkg);
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (!argument)
    throw new Error(
      "Usage: node scripts/release-packages.mjs pack|check|smoke|preflight|publish|verify-registry DIRECTORY",
    );
  const directory = resolve(argument);
  if (command === "pack") return packRelease(directory);
  const release = await validateRelease(directory);
  if (command === "check")
    return console.log("Release archive manifests and hashes passed");
  if (command === "smoke")
    return withInstalledRelease(directory, smokeInstalledAdoption);
  if (!["preflight", "publish", "verify-registry"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  // Preflight the whole batch. Identical archives permit retrying an interrupted
  // release; a published version with different bytes is never silently skipped.
  if (command === "verify-registry") {
    return verifyPublishedRelease(directory, async () => {});
  }
  return publishRelease(directory, release, { validationOnly: command === "preflight" });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
