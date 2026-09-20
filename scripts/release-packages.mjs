import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const directories = ["packages/shared", "apps/cli", "apps/mcp"];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export async function validateRelease(directory) {
  const release = await json(join(directory, "release.json"));
  assert.equal(release.schema, 1);
  assert.equal(release.packages.length, directories.length);
  for (const [index, path] of directories.entries()) {
    const source = await json(join(repo, path, "package.json"));
    const entry = release.packages[index];
    assert.equal(entry.name, source.name);
    assert.equal(entry.version, source.version);
    assert.equal(
      entry.file,
      `${source.name.replace("@", "").replace("/", "-")}-${source.version}.tgz`,
    );
    const archive = join(directory, entry.file);
    assert.equal(
      integrity(await readFile(archive)),
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
  { publicRegistry = false } = {},
) {
  const release = await validateRelease(directory);
  const root = await mkdtemp(join(tmpdir(), "vardum-consumer-"));
  const archives = new Map(
    await Promise.all(
      release.packages.map(async (pkg) => [
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
    await new Promise((yes, no) => {
      registry.once("error", no);
      registry.listen(0, "127.0.0.1", yes);
    });
    const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root };
    const installed = { root };
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
      const binary = join(
        cwd,
        "node_modules/.bin",
        kind === "cli" ? "vardum" : "vardum-mcp",
      );
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
    await new Promise((yes) => registry.close(yes));
    await rm(root, { recursive: true, force: true });
  }
}

async function registryState(release) {
  const states = [];
  for (const pkg of release.packages) {
    const response = await fetch(
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
    const published = await response.json();
    assert.equal(
      published.dist?.integrity,
      pkg.integrity,
      `${pkg.name}@${pkg.version} already exists with different bytes; use a new version`,
    );
    states.push({ ...pkg, published: true });
  }
  return states;
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
  const states = await registryState(release);
  if (command === "verify-registry") {
    assert.ok(
      states.every((pkg) => pkg.published),
      "Not all release archives are available on npm yet",
    );
    return withInstalledRelease(directory, async () => {}, {
      publicRegistry: true,
    });
  }
  for (const pkg of states) {
    console.log(
      `${pkg.name}@${pkg.version}: ${pkg.published ? "identical archive already published" : "version available"}`,
    );
    if (command === "publish" && !pkg.published) {
      const result = await run(
        "npm",
        [
          "publish",
          join(directory, pkg.file),
          "--access",
          "public",
          "--registry",
          "https://registry.npmjs.org/",
        ],
        { cwd: repo, timeout: 120_000 },
      );
      process.stdout.write(result.stdout);
    }
  }
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
