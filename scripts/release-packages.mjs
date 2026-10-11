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

// Test real npm resolution: CLI and MCP install separately by name. Explicitly
// installing the shared tarball alongside them could hide broken dependencies.
// Only third-party packages go to npmjs; this helper never publishes anything.
export async function withInstalledRelease(
  directory,
  action,
  { publicRegistry = false, expectedContract } = {},
) {
  // Server candidates reuse already-published client versions. They do not
  // repack npm artifacts (README-only changes can change archive integrity).
  const release = publicRegistry && !directory
    ? publicCompatibilityRelease()
    : await validateRelease(directory, expectedContract);
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
    for (const kind of ["cli", "mcp"]) {
      const pkg = release.packages.find(
        (entry) => entry.name === `@vardum/${kind}`,
      );
      const cwd = join(root, kind);
      await mkdir(cwd);
      await writeFile(
        join(cwd, "package.json"),
        '{"private":true,"type":"module"}\n',
      );
      const config = join(cwd, ".npmrc");
      const scopedRegistry = publicRegistry
        ? "https://registry.npmjs.org/"
        : `http://127.0.0.1:${registry.address().port}/`;
      await writeFile(
        config,
        `registry=https://registry.npmjs.org/\n@vardum:registry=${scopedRegistry}\n`,
      );
      await run(
        "npm",
        [
          "install",
          "--userconfig",
          config,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          `${pkg.name}@${pkg.version}`,
        ],
        { cwd, env, timeout: 120_000 },
      );
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
      const result = await run(
        process.execPath,
        [binary, kind === "cli" ? "version" : "--version"],
        { cwd, env },
      );
      assert.equal(result.stdout.trim(), pkg.version);
      installed[kind] = { cwd, binary, version: pkg.version };
    }
    const init = (...args) =>
      run(process.execPath, [installed.cli.binary, "init", ...args, "--json"], {
        cwd: installed.cli.cwd,
        env,
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
    return withInstalledRelease(directory, async () => {});
  if (!["preflight", "publish", "verify-registry"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  // Preflight the whole batch. Identical archives permit retrying an interrupted
  // release; a published version with different bytes is never silently skipped.
  if (command === "verify-registry") {
    await waitForPublishedRelease(release);
    return withInstalledRelease(directory, async () => {}, {
      publicRegistry: true,
    });
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
