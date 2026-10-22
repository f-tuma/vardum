import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { evidenceFiles, writeServerEvidence } from "./server-candidate-evidence.mjs";
import { runInstalledConsumerCheck } from "./smoke-installed-packages.mjs";
import { publicCompatibilityClients, publicCompatibilityRelease, run, smokeClientOptions } from "./release-packages.mjs";
import { assertRunningCandidate, candidateApiRuntime, probeCandidateApiRuntime, validateApiRuntimeSelection, candidateImageId, candidateComposeArgs, createGraphBudget, loadCandidate, normalizeUploadOrigins, prepareCandidate, validateCandidate, walkSavedGraph } from "./server-candidate.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commit = "a".repeat(40);
async function fixture({ sourceVersions, apiRuntime } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vardum-candidate-test-"));
  const directory = join(root, "bundle");
  const store = new Map();
  const mutations = [];
  const archives = join(root, "save");
  await mkdir(archives);
  const image = (role) => {
    const rootfs = { type: "layers", diff_ids: [`sha256:${hash("fake layer content")}`] };
    const config = JSON.stringify({ architecture: "amd64", os: "linux", role, rootfs });
    return { config, Id: `sha256:${hash(config)}`, Os: "linux", Architecture: "amd64", RootFS: { Type: rootfs.type, Layers: rootfs.diff_ids } };
  };
  for (const [tag, role] of [["postgres:17-alpine", "postgres"], ["rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c", "rustfs"], ["amazon/aws-cli:2.36.47", "rustfs-init"]]) store.set(tag, image(role));
  const execute = async (command, args, options) => {
    if (command === "git" && args[0] === "archive") {
      await run("tar", ["--exclude=node_modules", "--exclude=dist", "-cf", args[3], "-C", options.cwd,
        "compose.production.yml", "compose.dokploy.yml", "compose.dokploy.dev.yml", ".env.production.example", ".env.dokploy.example", "docker", "scripts", "docs", "apps/api/drizzle", "apps/cli/package.json", "apps/mcp/package.json", "packages/shared/package.json"]);
      return { stdout: "" };
    }
    if (command === "git") return { stdout: args[0] === "status" ? "" : args[1] === "HEAD" ? commit : "b".repeat(40) };
    if (command !== "docker") {
      const result = await run(command, args, options);
      if (sourceVersions && command === "tar" && args[0] === "-xf") {
        for (const path of ["apps/cli", "apps/mcp", "packages/shared"]) {
          const file = join(args[args.indexOf("-C") + 1], path, "package.json");
          const source = JSON.parse(await readFile(file, "utf8"));
          source.version = sourceVersions[source.name];
          await writeFile(file, JSON.stringify(source));
        }
      }
      return result;
    }
    if (args[0] === "version") return { stdout: "linux/amd64" };
    if (args[0] === "run") return { stdout: JSON.stringify({ node: "26.11.0", openssl: "3.5.9", uid: 65532,
      platform: "linux/amd64", nodeSha256: "c445d85bb8886e15bbc85973134274fb190088233b174841b9999dbabfeef9f8" }) };
    if (args[0] === "image") {
      const saved = store.get(args[2]);
      if (!saved) throw Object.assign(new Error("missing"), { code: 1, stderr: "No such image" });
      return { stdout: JSON.stringify([saved]) };
    }
    if (["build", "tag", "pull", "load"].includes(args[0])) mutations.push(args);
    if (args[0] === "build") store.set(args[args.indexOf("--tag") + 1], image(args.includes("docker/api.Dockerfile") ? "api" : args.includes("dokploy") ? "gateway-dokploy" : "gateway"));
    else if (args[0] === "tag") store.set(args[2], [...store.values()].find((value) => value.Id === args[1]));
    else if (args[0] === "save") {
      const manifest = [];
      for (const tag of args.slice(3)) {
        const saved = store.get(tag);
        const Config = `${saved.Id.slice(7)}.json`;
        await writeFile(join(archives, Config), saved.config);
        manifest.push({ Config, RepoTags: [tag], Layers: ["layer.tar"] });
      }
      await writeFile(join(archives, "layer.tar"), "fake layer content");
      await writeFile(join(archives, "manifest.json"), JSON.stringify(manifest));
      await run("tar", ["-cf", args[2], "-C", archives, "manifest.json", "layer.tar", ...manifest.map((entry) => entry.Config)]);
    }
    return { stdout: "" };
  };
  await prepareCandidate(directory, { execute, apiRuntime });
  const builds = mutations.filter((args) => args[0] === "build");
  mutations.length = 0;
  const manifestPath = join(directory, "candidate.json");
  const alter = async (action) => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await action(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
  };
  return { directory, root, execute, mutations, builds, store, archives, alter, close: () => rm(root, { recursive: true, force: true }) };
}

test("default candidate retains the exact Node22 production base and explicit selection", async () => {
  const f = await fixture();
  try {
    const m = await validateCandidate(f.directory, { execute: f.execute, expectedCommit: commit });
    assert.equal(m.apiRuntime.profile.name, "node22");
    assert.equal(m.apiRuntime.observation, null);
    const dockerfile = await readFile(new URL("../docker/api.Dockerfile", import.meta.url), "utf8");
    assert.ok(dockerfile.startsWith(`ARG API_RUNTIME_IMAGE=${m.apiRuntime.profile.baseImage}\n`));
    assert.match(dockerfile, /FROM node:22\.23\.3-bookworm-slim@sha256:43ac6c60/);
    assert.match(dockerfile, /FROM \$\{API_RUNTIME_IMAGE\} AS runtime/);
    assert.ok(f.builds[0].includes(`API_RUNTIME_IMAGE=${m.apiRuntime.profile.baseImage}`));
    for (const args of f.builds) {
      assert.ok(args.includes("--provenance=false"));
      assert.ok(args.includes(`org.opencontainers.image.revision=${commit}`));
      assert.ok(args.includes(`io.vardum.candidate.namespace=${m.images[0].tag.split(":")[1]}`));
    }

    assert.equal(f.builds.slice(1).some(args => args.some(arg => arg.startsWith("API_RUNTIME_IMAGE="))), false);
  } finally { await f.close(); }
});

test("explicit Node26 selection is fixed, observed and sanitized; legacy selection stays unspecified", async () => {
  const f = await fixture({ apiRuntime: "node26" });
  try {
    const m = await validateCandidate(f.directory, { execute: f.execute, expectedCommit: commit });
    assert.equal(m.apiRuntime.profile.name, "node26");
    assert.equal(m.apiRuntime.observation.node, "26.11.0");
    assert.equal(m.apiRuntime.observation.openssl, "3.5.9");
    assert.ok(f.builds[0].includes(`API_RUNTIME_IMAGE=${m.apiRuntime.profile.baseImage}`));
    const evidence = await writeServerEvidence({ candidateDirectory: f.directory, runtimeDirectory: join(f.root, "absent"),
      outputDirectory: join(f.root, "summary"), expectedCommit: commit, execute: f.execute });
    assert.deepEqual(evidence.candidate.apiRuntime, m.apiRuntime);
    assert.equal(evidence.candidate.releaseCertification, "pending");
    await f.alter(m => { delete m.apiRuntime; });
    const legacy = await writeServerEvidence({ candidateDirectory: f.directory, runtimeDirectory: join(f.root, "absent"),
      outputDirectory: join(f.root, "legacy-summary"), expectedCommit: commit, execute: f.execute });
    assert.equal(legacy.candidate.status, "verified");
    assert.equal(legacy.candidate.apiRuntime, null);
    assert.equal(validateApiRuntimeSelection(undefined), null);
  } finally { await f.close(); }
});

test("manual workflow passes hostile runtime input as data and fails before candidate mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vardum-workflow-runtime-"));
  try {
    const workflow = await readFile(new URL("../.github/workflows/server-candidate.yml", import.meta.url), "utf8");
    assert.match(workflow, /API_RUNTIME_PROFILE: \$\{\{ inputs\.api_runtime \}\}/);
    const line = workflow.split("\n").find(line => line.includes("run: node scripts/server-candidate.mjs prepare"));
    assert.ok(line.includes('--api-runtime "$API_RUNTIME_PROFILE"'));
    assert.equal(line.includes("${{"), false);
    const marker = join(root, "unexpected-shell-write");
    await assert.rejects(run("bash", ["-c", line.trim().slice(5)], { cwd: new URL("../", import.meta.url),
      env: { ...process.env, API_RUNTIME_PROFILE: `node26"; touch "${marker}"; #` }, timeout: 10_000 }), /Unknown API runtime/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown runtime profile fails before any subprocess or output mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vardum-runtime-profile-"));
  try {
    const calls = [];
    const path = join(root, "candidate");
    await assert.rejects(prepareCandidate(path, { apiRuntime: "evil.invalid/unsafe:latest",
      execute: async (...args) => { calls.push(args); throw new Error("must not execute"); } }), /Unknown API runtime/);
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(root), []);
    for (const value of [null, "constructor", "__proto__", "node24", "NODE26"]) assert.throws(() => candidateApiRuntime(value), /Unknown API runtime/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const field of ["node", "openssl", "uid", "platform", "nodeSha256"]) test(`actual Node26 ${field} mismatch fails bounded runtime probe`, async () => {
  const observation = { node: "26.11.0", openssl: "3.5.9", uid: 65532, platform: "linux/amd64",
    nodeSha256: "c445d85bb8886e15bbc85973134274fb190088233b174841b9999dbabfeef9f8" };
  observation[field] = field === "uid" ? 0 : "mismatched";
  let calls = 0;
  await assert.rejects(probeCandidateApiRuntime(`sha256:${"a".repeat(64)}`, candidateApiRuntime("node26"), async (command, args, options) => {
    calls++;
    assert.equal(command, "docker");
    assert.deepEqual(args.slice(0, 9), ["run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop", "ALL"]);
    assert.ok(args.includes("no-new-privileges"));
    assert.equal(args.some(arg => /--(?:mount|volume|user)/.test(arg)), false);
    assert.equal(options.timeout, 30_000);
    return { stdout: JSON.stringify(observation) };
  }), /Observed API runtime/);
  assert.equal(calls, 1);
});

for (const [name, change] of [
  ["arbitrary image", m => { m.apiRuntime.profile.baseImage = "evil.invalid/node:latest"; }],
  ["wrong observed version", m => { m.apiRuntime.observation.node = "26.11.1"; }],
  ["extra private field", m => { m.apiRuntime.observation.private = "secret"; }],
  ["null selection", m => { m.apiRuntime = null; }],
]) test(`tampered runtime ${name} fails before Docker load and invalidates projection`, async () => {
  const f = await fixture({ apiRuntime: "node26" });
  try {
    await f.alter(change);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute, expectedCommit: commit }), /runtime|Runtime/);
    assert.deepEqual(f.mutations, []);
    const evidence = await writeServerEvidence({ candidateDirectory: f.directory, runtimeDirectory: join(f.root, "absent"),
      outputDirectory: join(f.root, "summary"), expectedCommit: commit, execute: f.execute });
    assert.equal(evidence.candidate.status, "invalid-or-incomplete");
    assert.equal(JSON.stringify(evidence.candidate).includes("secret"), false);
  } finally { await f.close(); }
});

test("candidate uses exact saved images, keeps independent clients and never builds on load", async () => {
  const f = await fixture();
  try {
    const manifest = await validateCandidate(f.directory, { execute: f.execute, expectedCommit: commit });
    assert.equal(manifest.migrations.length, 21);
    const lastMigration = manifest.migrations.at(-1);
    assert.equal(lastMigration.file, "migrations/0020_vard_definition_bindings.sql");
    assert.equal(lastMigration.sha256, hash(await readFile(new URL("../apps/api/drizzle/0020_vard_definition_bindings.sql", import.meta.url))));
    assert.equal(lastMigration.sha256, hash(await readFile(join(f.directory, lastMigration.file))));
    const compose = await readFile(join(f.directory, "compose.production.yml"), "utf8");
    assert.doesNotMatch(compose, /build:|vardum-api:smoke/);
    assert.equal((compose.match(/pull_policy: never/g) ?? []).length, 7);
    await loadCandidate(f.directory, { execute: f.execute, expectedCommit: commit });
    assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
  } finally { await f.close(); }
});

for (const [name, change, pattern] of [
  ["wrong version", (m) => { m.serverVersion = "v0.6.0"; }, /version/],
  ["wrong platform", (m) => { m.platform = "linux/arm64"; }, /amd64/],
  ["wrong compatible clients", (m) => { m.clientVersions["@vardum/cli"] = "0.5.0"; }, /clients/],
  ["wrong source identity", (m) => { m.source.commit = "c".repeat(40); }, /commit/],
  ["dirty artifact", (m) => { m.source.dirty = true; m.source.context = "dirty-working-tree"; }, /Dirty/],
  ["unsafe payload path", (m) => { m.files["../escape"] = "0".repeat(64); }, /payload/],
  ["wrong saved ID", (m) => { m.images[0].id = `sha256:${"0".repeat(64)}`; }, /image ID/],
]) test(`${name} fails before Docker mutation`, async () => {
  const f = await fixture();
  try {
    await f.alter(change);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute, expectedCommit: commit }), pattern);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test("checksum and symlinks fail before Docker mutation", async () => {
  const f = await fixture();
  try {
    const file = join(f.directory, "docker/nginx.conf");
    const original = await readFile(file);
    await writeFile(file, "corrupted");
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /checksum/);
    await rm(file);
    await writeFile(join(f.root, "target"), original);
    await symlink(join(f.root, "target"), file);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /symlinks/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

for (const kind of ["traversal", "symlink"]) test(`archive ${kind} fails before Docker mutation even with recomputed checksum`, async () => {
  const f = await fixture();
  try {
    const archive = join(f.directory, "images.tar");
    if (kind === "traversal") await run("tar", ["-cf", archive, "-C", f.archives, "--transform=s|layer.tar|../escape|", "layer.tar"]);
    else {
      await symlink("/etc/passwd", join(f.archives, "link"));
      await run("tar", ["-cf", archive, "-C", f.archives, "link"]);
    }
    await f.alter(async (m) => { m.archive.sha256 = m.files["images.tar"] = hash(await readFile(archive)); });
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), kind === "traversal" ? /Unsafe/ : /links/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test("existing conflicting candidate tag is never overwritten", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    f.store.set(manifest.images[0].tag, { Id: `sha256:${"0".repeat(64)}`, Os: "linux", Architecture: "amd64" });
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Wrong image/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test("candidate Compose recovery cannot build or pull; public registry mode is explicit", () => {
  const savedCandidate = process.env.SMOKE_SERVER_CANDIDATE;
  const savedPublic = process.env.SMOKE_PUBLIC_CLIENTS;
  try {
    process.env.SMOKE_SERVER_CANDIDATE = "/bundle";
    process.env.SMOKE_PUBLIC_CLIENTS = "1";
    assert.deepEqual(candidateComposeArgs(["up", "-d", "api"]), ["up", "--no-build", "--pull", "never", "-d", "api"]);
    assert.deepEqual(candidateComposeArgs(["run", "--rm", "migrate"]), ["run", "--pull", "never", "--rm", "migrate"]);
    assert.deepEqual(smokeClientOptions(), { publicRegistry: true });
    delete process.env.SMOKE_SERVER_CANDIDATE;
    delete process.env.SMOKE_PUBLIC_CLIENTS;
    assert.deepEqual(candidateComposeArgs(["up", "-d"]), ["up", "-d"]);
    assert.deepEqual(smokeClientOptions(), { publicRegistry: false });
  } finally {
    if (savedCandidate === undefined) delete process.env.SMOKE_SERVER_CANDIDATE; else process.env.SMOKE_SERVER_CANDIDATE = savedCandidate;
    if (savedPublic === undefined) delete process.env.SMOKE_PUBLIC_CLIENTS; else process.env.SMOKE_PUBLIC_CLIENTS = savedPublic;
  }
});

const manifestType = "application/vnd.oci.image.manifest.v1+json";
const configType = "application/vnd.oci.image.config.v1+json";
const layerType = "application/vnd.oci.image.layer.v1.tar";

// Write an OCI graph that binds its tag/descriptor/config/layers. The original
// producer ID can remain classic while a receiving store reports its descriptor.
async function ociArchive(f, images, archive, { producerIsClassic = false, layer = Buffer.from("fake layer content"), mediaType = layerType } = {}) {
  const root = await mkdtemp(join(f.root, "oci-"));
  const blobs = join(root, "blobs/sha256");
  await mkdir(blobs, { recursive: true });
  const index = { schemaVersion: 2, manifests: [] };
  const saved = [];
  const descriptors = new Map();
  const layerDigest = `sha256:${hash(layer)}`;
  await writeFile(join(blobs, layerDigest.slice(7)), layer);
  for (const image of images) {
    const stored = f.store.get(image.tag);
    const config = stored.config;
    const configDigest = `sha256:${hash(config)}`;
    await writeFile(join(blobs, configDigest.slice(7)), config);
    const leaf = JSON.stringify({ schemaVersion: 2, mediaType: manifestType,
      config: { mediaType: configType, digest: configDigest, size: Buffer.byteLength(config) },
      layers: [{ mediaType, digest: layerDigest, size: layer.length }] });
    const descriptor = { mediaType: manifestType, digest: `sha256:${hash(leaf)}`, size: Buffer.byteLength(leaf),
      annotations: { "io.containerd.image.name": `docker.io/library/${image.tag}` } };
    await writeFile(join(blobs, descriptor.digest.slice(7)), leaf);
    index.manifests.push(descriptor);
    descriptors.set(image.tag, descriptor.digest);
    if (!producerIsClassic) image.id = descriptor.digest;
    saved.push({ Config: `blobs/sha256/${configDigest.slice(7)}`, RepoTags: [image.tag], Layers: [`blobs/sha256/${layerDigest.slice(7)}`] });
  }
  await writeFile(join(root, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(root, "index.json"), JSON.stringify(index));
  await writeFile(join(root, "manifest.json"), JSON.stringify(saved));
  await run("tar", ["-cf", archive, "-C", root, "oci-layout", "index.json", "manifest.json", "blobs"]);
  return { descriptors, root, index };
}

async function updateArchive(f, manifest) {
  manifest.archive.sha256 = manifest.files["images.tar"] = hash(await readFile(join(f.directory, "images.tar")));
  await writeFile(join(f.directory, "candidate.json"), JSON.stringify(manifest));
}

test("OCI descriptor IDs and classic config IDs both bind to the saved platform config", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    await ociArchive(f, manifest.images, join(f.directory, "images.tar"));
    await updateArchive(f, manifest);
    await loadCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
    f.mutations.length = 0;
    await f.alter((m) => { m.images[0].configId = `sha256:${"f".repeat(64)}`; });
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /config ID/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

for (const problem of ["missing blob", "invalid digest", "wrong config", "missing layout", "wrong layer"]) test(`classic producer cannot bypass OCI ${problem} checks before load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const archive = join(f.directory, "images.tar");
    const built = await ociArchive(f, manifest.images, archive, { producerIsClassic: true });
    if (problem === "missing blob") built.index.manifests[0].digest = `sha256:${"f".repeat(64)}`;
    else if (problem === "invalid digest") built.index.manifests[0].digest = "sha256:../escape";
    else if (problem === "missing layout") await rm(join(built.root, "oci-layout"));
    else {
      const descriptor = built.index.manifests[0];
      const file = join(built.root, "blobs/sha256", descriptor.digest.slice(7));
      const leaf = JSON.parse(await readFile(file, "utf8"));
      if (problem === "wrong config") {
        leaf.config.digest = manifest.images[1].configId;
        leaf.config.size = Buffer.byteLength(f.store.get(manifest.images[1].tag).config);
      }
      else leaf.layers[0].digest = `sha256:${"e".repeat(64)}`;
      const bytes = JSON.stringify(leaf);
      descriptor.digest = `sha256:${hash(bytes)}`;
      descriptor.size = Buffer.byteLength(bytes);
      await writeFile(join(built.root, "blobs/sha256", descriptor.digest.slice(7)), bytes);
    }
    await writeFile(join(built.root, "index.json"), JSON.stringify(built.index));
    await run("tar", ["-cf", archive, "-C", built.root, "index.json", "manifest.json", "blobs", ...(problem === "missing layout" ? [] : ["oci-layout"])]);
    await updateArchive(f, manifest);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Missing archive|Missing matching|descriptor digest|wrong config|layout and index/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test("classic archive translates only through an authenticated host graph and running container IDs", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const translatedIds = new Map();
    let savingHost = false;
    const hostSaveCalls = [];
    const execute = async (command, args, options) => {
      if (command === "docker" && args[0] === "load") {
        f.mutations.push(args);
        for (const image of manifest.images) {
          const host = await ociArchive(f, [{ ...image }], join(f.root, `${image.role}-host.tar`));
          translatedIds.set(image.tag, host.descriptors.get(image.tag));
        }
        return { stdout: "" };
      }
      if (command === "docker" && args[0] === "save") {
        assert.equal(savingHost, false);
        savingHost = true;
        try {
          hostSaveCalls.push(args[3]);
          const image = manifest.images.find((entry) => entry.tag === args[3]);
          await ociArchive(f, [{ ...image }], args[2]);
          return { stdout: "" };
        } finally { savingHost = false; }
      }
      if (command === "docker" && args[0] === "image" && translatedIds.has(args[2])) {
        return { stdout: JSON.stringify([{ ...f.store.get(args[2]), Id: translatedIds.get(args[2]) }]) };
      }
      if (command === "docker" && args[0] === "compose") return { stdout: args.at(-1) };
      if (command === "docker" && args[0] === "inspect") {
        const service = args[1];
        const image = manifest.images.find((entry) => entry.role === (["worker", "migrate"].includes(service) ? "api" : service));
        return { stdout: JSON.stringify([{ Image: translatedIds.get(image.tag), Config: { Image: image.tag }, State: { Running: service !== "migrate", ExitCode: 0 } }]) };
      }
      return f.execute(command, args, options);
    };
    await loadCandidate(f.directory, { execute });
    assert.equal(hostSaveCalls.length, manifest.images.length, "each unfamiliar host ID must be authenticated");
    await assertRunningCandidate(f.directory, "vardum-smoke-123-restore", { execute });
    assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
    await assert.rejects(assertRunningCandidate(f.directory, "vardum-smoke-123", { execute: async (command, args, options) => {
      if (command === "docker" && args[0] === "inspect") {
        const result = await execute(command, args, options);
        const container = JSON.parse(result.stdout)[0];
        container.Image = `sha256:${"d".repeat(64)}`;
        return { stdout: JSON.stringify([container]) };
      }
      return execute(command, args, options);
    } }), /wrong image ID/);
    // A foreign descriptor with even the right platform must not pass merely
    // because the receiving daemon returned a syntactically valid image ID.
    f.store.get(manifest.images[0].tag).config = JSON.stringify({ architecture: "amd64", os: "linux", role: "foreign" });
    await assert.rejects(assertRunningCandidate(f.directory, "vardum-smoke-123", { execute }), /config ID/);
  } finally { await f.close(); }
});


// Construct raw headers so the test preserves REGTYPE even when a visual TAR
// listing would infer a directory from the trailing slash.
async function appendTarEntry(archive, name, type, bytes, mutateHeader = () => {}) {
  const original = await readFile(archive);
  let end = 0;
  while (original[end]) {
    const size = Number.parseInt(original.subarray(end + 124, end + 136).toString("ascii"), 8);
    end += 512 + Math.ceil(size / 512) * 512;
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  }
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  mutateHeader(header);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  await writeFile(archive, Buffer.concat([original.subarray(0, end), header, bytes,
    Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(1024)]));
}

for (const file of ["manifest.json", "index.json"]) for (const type of ["0", "5"]) {
  test(`raw TAR ${file}/ type ${type} alias cannot add tags before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const archive = join(f.directory, "images.tar");
      let replacement;
      if (file === "index.json") {
        const built = await ociArchive(f, manifest.images, archive, { producerIsClassic: true });
        built.index.manifests.push({ ...built.index.manifests[0], annotations: { "io.containerd.image.name": "docker.io/library/vardum-api:smoke" } });
        replacement = JSON.stringify(built.index);
      } else {
        const saved = JSON.parse(await readFile(join(f.archives, file), "utf8"));
        saved[0].RepoTags.push("vardum-api:smoke");
        replacement = JSON.stringify(saved);
      }
      await appendTarEntry(archive, `${file}/`, type, type === "5" ? Buffer.alloc(0) : Buffer.from(replacement));
      await updateArchive(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /trailing slash|Duplicate canonical/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("raw TAR extensions, damaged headers and appended metadata fail before load", async () => {
  for (const problem of ["extension", "checksum", "after end marker"]) {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const archive = join(f.directory, "images.tar");
      if (problem === "extension") await appendTarEntry(archive, "overrides", "x", Buffer.from("path=manifest.json"));
      else {
        const bytes = await readFile(archive);
        if (problem === "checksum") bytes[100] ^= 1;
        else bytes[bytes.length - 1] = 1;
        await writeFile(archive, bytes);
      }
      await updateArchive(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /extensions|header checksum|after TAR end/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  }
});

async function repackOci(f, manifest, built) {
  await writeFile(join(built.root, "index.json"), JSON.stringify(built.index));
  await run("tar", ["-cf", join(f.directory, "images.tar"), "-C", built.root, "oci-layout", "index.json", "manifest.json", "blobs"]);
  await updateArchive(f, manifest);
}

test("an extra unnamed OCI root is still rejected before Docker load", async () => {
  const f = await fixture();
  try {
    const m = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, m.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    const extra = structuredClone(built.index.manifests[0]);
    delete extra.annotations;
    built.index.manifests.push(extra);
    await repackOci(f, m, built);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Unexpected OCI saved image tags/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

async function changeLeaf(built, action) {
  const descriptor = built.index.manifests[0];
  const leaf = JSON.parse(await readFile(join(built.root, "blobs/sha256", descriptor.digest.slice(7)), "utf8"));
  await action(leaf);
  const bytes = JSON.stringify(leaf);
  descriptor.digest = `sha256:${hash(bytes)}`;
  descriptor.size = Buffer.byteLength(bytes);
  await writeFile(join(built.root, "blobs/sha256", descriptor.digest.slice(7)), bytes);
}

for (const problem of ["decoded manifest", "config", "layer", "unsupported zstd", "compression mismatch"]) {
  test(`OCI ${problem} media type fails before Docker mutation`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      await changeLeaf(built, (leaf) => {
        if (problem === "decoded manifest") leaf.mediaType = "application/evil";
        else if (problem === "config") leaf.config.mediaType = "application/evil";
        else leaf.layers[0].mediaType = problem === "unsupported zstd" ? "application/vnd.oci.image.layer.v1.tar+zstd" : problem === "compression mismatch" ? `${layerType}+gzip` : "application/evil";
      });
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /media type/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const format of ["classic", "OCI"]) for (const problem of ["changed decoded bytes", "corrupt gzip", "truncated gzip", "unsupported codec"]) {
  test(`${format} ${problem} fails before Docker mutation`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const archive = join(f.directory, "images.tar");
      let layer;
      if (problem === "changed decoded bytes") layer = gzipSync(Buffer.from("different layer with recomputed packed hashes"));
      else if (problem === "unsupported codec") layer = Buffer.from("28b52ffd0102030405", "hex");
      else {
        layer = gzipSync(Buffer.from("fake layer content"));
        if (problem === "corrupt gzip") layer[layer.length - 8] ^= 1;
        else layer = layer.subarray(0, layer.length - 4);
      }
      if (format === "OCI") {
        await ociArchive(f, manifest.images, archive, { producerIsClassic: true, layer, mediaType: `${layerType}+gzip` });
      } else {
        await writeFile(join(f.archives, "layer.tar"), layer);
        const saved = JSON.parse(await readFile(join(f.archives, "manifest.json"), "utf8"));
        await run("tar", ["-cf", archive, "-C", f.archives, "manifest.json", "layer.tar", ...saved.map((entry) => entry.Config)]);
      }
      await updateArchive(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /diff ID|data check|unexpected end|compression/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const problem of ["type", "digest", "length", "order"]) {
  test(`classic config diff IDs ${problem} mismatch fails before Docker mutation`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const saved = JSON.parse(await readFile(join(f.archives, "manifest.json"), "utf8"));
      const config = JSON.parse(await readFile(join(f.archives, saved[0].Config), "utf8"));
      if (problem === "type") config.rootfs.type = "foreign";
      else if (problem === "digest") config.rootfs.diff_ids[0] = "sha256:invalid";
      else if (problem === "length") config.rootfs.diff_ids = [];
      else {
        const bytes = "second distinct layer";
        await writeFile(join(f.archives, "second.tar"), bytes);
        config.rootfs.diff_ids.push(`sha256:${hash(bytes)}`);
        saved[0].Layers = ["second.tar", "layer.tar"];
      }
      const bytes = JSON.stringify(config);
      manifest.images[0].id = manifest.images[0].configId = `sha256:${hash(bytes)}`;
      await writeFile(join(f.archives, saved[0].Config), bytes);
      await writeFile(join(f.archives, "manifest.json"), JSON.stringify(saved));
      await run("tar", ["-cf", join(f.directory, "images.tar"), "-C", f.archives, "manifest.json", "layer.tar", ...saved.map((entry) => entry.Config), ...(problem === "order" ? ["second.tar"] : [])]);
      await updateArchive(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /RootFS|diff ID/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("classic and OCI gzip layers validate against the uncompressed config diff ID", async () => {
  for (const format of ["classic", "OCI"]) {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const archive = join(f.directory, "images.tar");
      const layer = gzipSync(Buffer.from("fake layer content"));
      if (format === "OCI") await ociArchive(f, manifest.images, archive, { producerIsClassic: true, layer, mediaType: `${layerType}+gzip` });
      else {
        await writeFile(join(f.archives, "layer.tar"), layer);
        const saved = JSON.parse(await readFile(join(f.archives, "manifest.json"), "utf8"));
        await run("tar", ["-cf", archive, "-C", f.archives, "manifest.json", "layer.tar", ...saved.map((entry) => entry.Config)]);
      }
      await updateArchive(f, manifest);
      await loadCandidate(f.directory, { execute: f.execute });
      assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
    } finally { await f.close(); }
  }
});

test("development origins use the gateway's comma-separated format without credentials", () => {
  assert.equal(normalizeUploadOrigins("https://a.example http://localhost:19000,https://a.example/"), "https://a.example,http://localhost:19000");
  for (const value of ["", "file:///tmp", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=secret"]) {
    assert.throws(() => normalizeUploadOrigins(value));
  }
});


for (const problem of ["length", "order"]) test(`OCI ordered layers and config diff IDs ${problem} mismatch fails before load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    const saved = JSON.parse(await readFile(join(built.root, "manifest.json"), "utf8"));
    const config = JSON.parse(f.store.get(manifest.images[0].tag).config);
    if (problem === "length") config.rootfs.diff_ids = [];
    else {
      const bytes = Buffer.from("second distinct layer");
      const layer = { mediaType: layerType, digest: `sha256:${hash(bytes)}`, size: bytes.length };
      await writeFile(join(built.root, "blobs/sha256", layer.digest.slice(7)), bytes);
      config.rootfs.diff_ids.push(layer.digest);
      saved[0].Layers.unshift(`blobs/sha256/${layer.digest.slice(7)}`);
      await changeLeaf(built, (leaf) => { leaf.layers.unshift(layer); });
    }
    const bytes = JSON.stringify(config);
    const configDescriptor = { mediaType: configType, digest: `sha256:${hash(bytes)}`, size: Buffer.byteLength(bytes) };
    saved[0].Config = `blobs/sha256/${configDescriptor.digest.slice(7)}`;
    manifest.images[0].id = manifest.images[0].configId = configDescriptor.digest;
    await writeFile(join(built.root, saved[0].Config), bytes);
    await writeFile(join(built.root, "manifest.json"), JSON.stringify(saved));
    await changeLeaf(built, (leaf) => { leaf.config = configDescriptor; });
    await repackOci(f, manifest, built);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /diff ID/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});


for (const format of ["magic high bit", "STAR", "GNU version"]) test(`ambiguous TAR ${format} interpretation fails before load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const archive = join(f.directory, "images.tar");
    await appendTarEntry(archive, "harmless", "0", Buffer.from("{}"), (header) => {
      if (format === "magic high bit") header[257] |= 0x80;
      else if (format === "STAR") header.write("tar\0", 508, 4, "ascii");
      else header.write("ustar ", 257, 6, "ascii");
    });
    await updateArchive(f, manifest);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Unsupported TAR format/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});


async function repackClassic(f, manifest) {
  const saved = JSON.parse(await readFile(join(f.archives, "manifest.json"), "utf8"));
  await run("tar", ["-cf", join(f.directory, "images.tar"), "-C", f.archives, "manifest.json", "layer.tar", ...saved.map((entry) => entry.Config)]);
  await updateArchive(f, manifest);
}

async function classicConfig(f, manifest, change) {
  const saved = JSON.parse(await readFile(join(f.archives, "manifest.json"), "utf8"));
  const config = JSON.parse(await readFile(join(f.archives, saved[0].Config), "utf8"));
  const bytes = await change(config) ?? JSON.stringify(config);
  manifest.images[0].id = manifest.images[0].configId = `sha256:${hash(bytes)}`;
  await writeFile(join(f.archives, saved[0].Config), bytes);
  Object.assign(f.store.get(manifest.images[0].tag), { config: bytes, Id: manifest.images[0].id });
}

for (const key of ["repotags", "RepoTagſ", "ConfiG", "layerſ", "parent", "layersources"]) {
  test(`Docker structural alias ${key} fails before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const file = join(f.archives, "manifest.json");
      const saved = JSON.parse(await readFile(file, "utf8"));
      saved[0][key] = key.includes("tag") || key.includes("Tag") ? ["vardum-api:smoke"] : "hidden";
      await writeFile(file, JSON.stringify(saved));
      await repackClassic(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Noncanonical JSON structural key/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

const configAliases = [
  ["OS", (c) => { c.OS = "freebsd"; }],
  ["RootFS", (c) => { c.RootFS = { type: "layers", diff_ids: [] }; }],
  ["Config", (c) => { c.Config = { Env: ["ALTERED=yes"] }; }],
  ["Container_Config", (c) => { c.Container_Config = {}; }],
  ["ſize", (c) => { c["ſize"] = 1; }],
  ["RootFS Diff_ids", (c) => { c.rootfs.Diff_ids = []; }],
  ["RootFS Type", (c) => { c.rootfs.Type = "other"; }],
  ["runtime env", (c) => { c.config = { Env: ["A=one"], env: ["A=two"] }; }],
  ["runtime HealthchecK", (c) => { c.config = { "HealthchecK": { Test: ["NONE"] } }; }],
  ["healthcheck teſt", (c) => { c.config = { Healthcheck: { Test: ["NONE"], "teſt": ["CMD", "hidden"] } }; }],
  ["history Created_By", (c) => { c.history = [{ created_by: "known", Created_By: "hidden" }]; }],
];
for (const [name, change] of configAliases) test(`config structural alias ${name} fails before load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    await classicConfig(f, manifest, change);
    await repackClassic(f, manifest);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Noncanonical JSON structural key/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

for (const problem of ["layout ImageLayoutVersion", "root Manifests", "root manifeſtſ", "descriptor Annotations",
  "descriptor annotationſ", "descriptor Digest", "descriptor Platform", "platform OS", "nested Manifests", "nested manifeſtſ",
  "leaf Config", "leaf Layers", "leaf Annotationſ", "layer MediaType", "layer SiZe", "config descriptor Digest"]) {
  test(`OCI structural alias ${problem} fails before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      const descriptor = built.index.manifests[0];
      const extraTags = [{ ...descriptor, annotations: { "io.containerd.image.name": "docker.io/library/vardum-api:smoke" } }];
      if (problem.startsWith("layout")) await writeFile(join(built.root, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0", ImageLayoutVersion: "1.0.0" }));
      else if (problem.startsWith("root")) built.index[problem.split(" ")[1]] = extraTags;
      else if (problem.startsWith("descriptor")) descriptor[problem.split(" ")[1]] = problem.includes("Platform") ? { os: "freebsd", architecture: "amd64" } : problem.includes("Digest") ? manifest.images[1].configId : extraTags[0].annotations;
      else if (problem.startsWith("platform")) descriptor.platform = { os: "linux", architecture: "amd64", OS: "freebsd" };
      else if (problem.startsWith("nested")) {
        const child = { ...descriptor, platform: { os: "linux", architecture: "amd64" } };
        const index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [child], [problem.split(" ")[1]]: extraTags };
        const bytes = JSON.stringify(index);
        descriptor.digest = `sha256:${hash(bytes)}`;
        descriptor.size = Buffer.byteLength(bytes);
        descriptor.mediaType = index.mediaType;
        await writeFile(join(built.root, "blobs/sha256", descriptor.digest.slice(7)), bytes);
      } else await changeLeaf(built, (leaf) => {
        if (problem.startsWith("leaf")) leaf[problem.split(" ")[1]] = problem.includes("Config") ? leaf.config : problem.includes("Layers") ? leaf.layers : extraTags[0].annotations;
        else if (problem.startsWith("layer")) leaf.layers[0][problem.split(" ")[1]] = "hidden";
        else leaf.config.Digest = manifest.images[1].configId;
      });
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Noncanonical JSON structural key/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const escaped of [false, true]) for (const location of ["Docker entry", "OCI annotations object", "OCI annotation map", "config RootFS", "runtime Labels", "candidate manifest"]) {
  test(`${location} ${escaped ? "escaped" : "exact"} duplicate decoded key fails before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const key = (value) => escaped ? `${value.slice(0, -1)}\\u${value.charCodeAt(value.length - 1).toString(16).padStart(4, "0")}` : value;
      if (location === "candidate manifest") {
        const file = join(f.directory, "candidate.json");
        const text = JSON.stringify(manifest).replace('"schema":1', `"schema":2,"${key("schema")}":1`);
        await writeFile(file, text);
      } else if (location === "Docker entry") {
        const file = join(f.archives, "manifest.json");
        const text = (await readFile(file, "utf8")).replace('"RepoTags":', `"RepoTags":["vardum-api:smoke"],"${key("RepoTags")}":`);
        await writeFile(file, text);
        await repackClassic(f, manifest);
      } else if (location.startsWith("OCI")) {
        const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
        let text = JSON.stringify(built.index);
        if (location === "OCI annotations object") text = text.replace('"annotations":{', `"annotations":{"org.opencontainers.image.ref.name":"vardum-api:smoke"},"${key("annotations")}":{`);
        else text = text.replace('"io.containerd.image.name":', `"io.containerd.image.name":"docker.io/library/vardum-api:smoke","${key("io.containerd.image.name")}":`);
        await writeFile(join(built.root, "index.json"), text);
        await run("tar", ["-cf", join(f.directory, "images.tar"), "-C", built.root, "oci-layout", "index.json", "manifest.json", "blobs"]);
        await updateArchive(f, manifest);
      } else {
        await classicConfig(f, manifest, (config) => {
          if (location === "config RootFS") return JSON.stringify(config).replace('"rootfs":{', `"rootfs":{"type":"foreign"},"${key("rootfs")}":{`);
          config.config = { Labels: { preserved: "yes" } };
          return JSON.stringify(config).replace('"Labels":{', `"Labels":{"hidden":"retained by Go merge"},"${key("Labels")}":{`);
        });
        await repackClassic(f, manifest);
      }
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Duplicate decoded JSON key/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("canonical escaped fields and distinct case-sensitive annotation/label keys remain valid", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    await classicConfig(f, manifest, (config) => {
      config.config = { Labels: { Env: "upper", env: "lower", "ſ": "long s", s: "ascii s", "K": "Kelvin", K: "ascii K", emoji: "\\ud83d\\ude00", escaped: "quote: \\\" and slash: \\\\" } };
      return JSON.stringify(config).replace('"Labels":', '"Label\\u0073":');
    });
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    Object.assign(built.index.manifests[0].annotations, { Name: "upper", name: "lower", "ſ": "long s", s: "ascii s", "K": "Kelvin", K: "ascii K" });
    const text = JSON.stringify(built.index).replace('"annotations":', '"annotation\\u0073":');
    await writeFile(join(built.root, "index.json"), text);
    await run("tar", ["-cf", join(f.directory, "images.tar"), "-C", built.root, "oci-layout", "index.json", "manifest.json", "blobs"]);
    await updateArchive(f, manifest);
    await loadCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
  } finally { await f.close(); }
});

for (const problem of ["unpaired surrogate", "invalid UTF-8", "deep nesting"]) test(`JSON ${problem} fails before load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    await classicConfig(f, manifest, (config) => {
      const text = JSON.stringify(config);
      if (problem === "unpaired surrogate") return text.replace('"role":', '"\\ud800":1,"role":');
      if (problem === "deep nesting") return text.replace('"role":', `"unknown":${"[".repeat(130)}0${"]".repeat(130)},"role":`);
      return Buffer.concat([Buffer.from(text.slice(0, -1)), Buffer.from(',"unknown":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    });
    await repackClassic(f, manifest);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /surrogate|encoded data|nesting/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});


async function graphBlob(built, bytes, mediaType, extra = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(typeof bytes === "string" ? bytes : JSON.stringify(bytes));
  const descriptor = { mediaType, digest: `sha256:${hash(bytes)}`, size: bytes.length, ...extra };
  await writeFile(join(built.root, "blobs/sha256", descriptor.digest.slice(7)), bytes);
  return descriptor;
}
async function graphIndex(built, children, extra = {}) {
  return graphBlob(built, { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: children }, "application/vnd.oci.image.index.v1+json", extra);
}
async function firstGraphLeaf(built) {
  const original = built.index.manifests[0];
  const leaf = JSON.parse(await readFile(join(built.root, "blobs/sha256", original.digest.slice(7)), "utf8"));
  return { descriptor: { mediaType: original.mediaType, digest: original.digest, size: original.size, platform: { os: "linux", architecture: "amd64" } }, leaf };
}
async function foreignGraphLeaf(built, native, mutateConfig = () => {}, mutateLeaf = () => {}) {
  const config = { os: "linux", architecture: "arm64", rootfs: { type: "layers", diff_ids: [`sha256:${hash("fake layer content")}`] } };
  mutateConfig(config);
  const leaf = { ...native.leaf, config: await graphBlob(built, config, configType), layers: native.leaf.layers.map((layer) => ({ ...layer })) };
  await mutateLeaf(leaf);
  return graphBlob(built, leaf, manifestType, { platform: { os: "linux", architecture: "arm64" } });
}
async function rootGraph(built, children) {
  const descriptor = await graphIndex(built, children);
  Object.assign(built.index.manifests[0], descriptor);
}
async function inertAttestation(built, native, mutate = () => {}) {
  const predicateType = "https://slsa.dev/provenance/v1";
  const statement = { _type: "https://in-toto.io/Statement/v1", predicateType, subject: [{ name: "fixture", digest: { sha256: native.descriptor.digest.slice(7) } }], predicate: {} };
  const config = await graphBlob(built, Buffer.from("{}"), "application/vnd.oci.empty.v1+json", { data: Buffer.from("{}").toString("base64") });
  const layer = await graphBlob(built, statement, "application/vnd.in-toto+json", { annotations: { "in-toto.io/predicate-type": predicateType } });
  const { platform: ignored, ...subject } = native.descriptor;
  const leaf = { schemaVersion: 2, mediaType: manifestType, artifactType: "application/vnd.docker.attestation.manifest.v1+json", config, layers: [layer], subject };
  await mutate(leaf, statement);
  return graphBlob(built, leaf, manifestType, { platform: { os: "unknown", architecture: "unknown" }, annotations: {
    "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": native.descriptor.digest,
  } });
}

for (const problem of ["OS alias", "architecture alias", "uppercase arch", "AMD64 variant", "nil platform", "null platform", "same-digest duplicate",
  "nested matching alternative", "nested duplicate alternative", "missing matching", "missing index", "missing nil", "missing inline-only"]) {
  test(`all-present OCI graph ${problem} fails before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      const native = await firstGraphLeaf(built);
      const child = { ...native.descriptor, platform: { ...native.descriptor.platform } };
      let children = [child, native.descriptor];
      if (problem === "OS alias") child.platform.os = "LINUX";
      else if (problem === "architecture alias") child.platform.architecture = "x86_64";
      else if (problem === "uppercase arch") child.platform.architecture = "AMD64";
      else if (problem === "AMD64 variant") child.platform.variant = "v1";
      else if (problem === "nil platform") delete child.platform;
      else if (problem === "null platform") child.platform = null;
      else if (problem.startsWith("nested")) {
        child.platform = problem === "nested matching alternative" ? { os: "linux", architecture: "arm64" } : { os: "linux", architecture: "amd64" };
        children = [native.descriptor, await graphIndex(built, [native.descriptor], { platform: child.platform })];
      } else if (problem.startsWith("missing")) {
        child.digest = `sha256:${"f".repeat(64)}`;
        if (problem === "missing index") { child.mediaType = "application/vnd.oci.image.index.v1+json"; child.platform.architecture = "arm64"; }
        else if (problem === "missing nil") delete child.platform;
        else if (problem === "missing inline-only") {
          const { platform: ignored, ...subject } = native.descriptor;
          child.data = (await readFile(join(built.root, "blobs/sha256", native.descriptor.digest.slice(7)))).toString("base64");
          child.digest = subject.digest;
          await rm(join(built.root, "blobs/sha256", subject.digest.slice(7)));
        }
      }
      await rootGraph(built, children);
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /platform|variant|exactly one|Nested index|Missing matching/i);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const problem of ["config alias", "config platform mismatch", "RootFS count", "changed foreign layer", "foreign config media type", "foreign decoded manifest type"]) {
  test(`present foreign OCI ${problem} validates before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      const native = await firstGraphLeaf(built);
      const foreign = await foreignGraphLeaf(built, native, (config) => {
        if (problem === "config alias") config.OS = "linux";
        if (problem === "config platform mismatch") config.architecture = "amd64";
        if (problem === "RootFS count") config.rootfs.diff_ids = [];
      }, async (leaf) => {
        if (problem === "changed foreign layer") leaf.layers[0] = await graphBlob(built, Buffer.from("different foreign bytes"), layerType);
        if (problem === "foreign config media type") leaf.config.mediaType = "application/evil";
        if (problem === "foreign decoded manifest type") leaf.mediaType = "application/evil";
      });
      await rootGraph(built, [native.descriptor, foreign]);
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Noncanonical|platforms differ|diff ID|media type/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("canonical absent foreign references, valid present foreign images, nested sole native leaf and inert attestations remain valid", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    const native = await firstGraphLeaf(built);
    const foreign = await foreignGraphLeaf(built, native);
    const absent = { mediaType: manifestType, digest: `sha256:${"f".repeat(64)}`, size: 100, platform: { os: "linux", architecture: "s390x" } };
    const absentAttestation = { mediaType: manifestType, digest: `sha256:${"e".repeat(64)}`, size: 100, platform: { os: "unknown", architecture: "unknown" }, annotations: {
      "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": absent.digest,
    } };
    const attestation = await inertAttestation(built, native);
    const nested = await graphIndex(built, [native.descriptor, attestation], { platform: { os: "linux", architecture: "amd64" } });
    await rootGraph(built, [nested, foreign, absent, absentAttestation]);
    await repackOci(f, manifest, built);
    await loadCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
  } finally { await f.close(); }
});

for (const problem of ["unmarked unknown platform", "artifact config", "artifact layer", "subject", "reference", "inline empty config", "statement subject", "artifact native platform"]) {
  test(`inert OCI attestation ${problem} fails before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      const native = await firstGraphLeaf(built);
      const artifact = await inertAttestation(built, native, async (leaf, statement) => {
        if (problem === "artifact config") leaf.config = native.leaf.config;
        if (problem === "artifact layer") leaf.layers = native.leaf.layers;
        if (problem === "subject") leaf.subject = { ...native.leaf.config, mediaType: manifestType };
        if (problem === "inline empty config") leaf.config.data = Buffer.from("[]").toString("base64");
        if (problem === "statement subject") {
          statement.subject[0].digest.sha256 = "f".repeat(64);
          const layer = await graphBlob(built, statement, "application/vnd.in-toto+json", { annotations: leaf.layers[0].annotations });
          leaf.layers = [layer];
        }
      });
      if (problem === "unmarked unknown platform") delete artifact.annotations;
      if (problem === "reference") artifact.annotations["vnd.docker.reference.digest"] = `sha256:${"f".repeat(64)}`;
      if (problem === "artifact native platform") artifact.platform = { os: "linux", architecture: "amd64" };
      await rootGraph(built, [native.descriptor, artifact]);
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /artifact|empty config|runnable leaf|reference and subject|Inline descriptor|wrong subject/i);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const location of ["index", "config", "layer"]) test(`contradictory inline OCI ${location} data fails before load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    if (location === "index") built.index.manifests[0].data = Buffer.from("different data").toString("base64");
    else await changeLeaf(built, (leaf) => { (location === "config" ? leaf.config : leaf.layers[0]).data = Buffer.from("different data").toString("base64"); });
    await repackOci(f, manifest, built);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Inline descriptor/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test("identical inline config and manifest bytes are authenticated", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    await changeLeaf(built, async (leaf) => { leaf.config.data = (await readFile(join(built.root, "blobs/sha256", leaf.config.digest.slice(7)))).toString("base64"); });
    built.index.manifests[0].data = (await readFile(join(built.root, "blobs/sha256", built.index.manifests[0].digest.slice(7)))).toString("base64");
    await repackOci(f, manifest, built);
    await loadCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
  } finally { await f.close(); }
});

for (const problem of ["cycle", "depth", "count"]) test(`bounded graph walker rejects ${problem} before mutation with an injected reader`, async () => {
  let mutations = 0;
  const descriptor = (index) => ({ digest: `sha256:${index.toString(16).padStart(64, "0")}` });
  const root = descriptor(1);
  const read = async (current) => {
    if (problem === "cycle") return { manifests: [root] };
    if (problem === "count") return current === root ? { manifests: Array.from({ length: 1024 }, () => descriptor(2)) } : {};
    return { manifests: [descriptor(Number.parseInt(current.digest.slice(7), 16) + 1)] };
  };
  await assert.rejects(async () => { await walkSavedGraph(root, read, () => {}); mutations++; }, new RegExp(problem));
  assert.equal(mutations, 0);
});

for (const kind of ["metadata", "encoded", "decoded"]) test(`graph-wide ${kind} byte limit accumulates across roots`, () => {
  const budget = createGraphBudget();
  const maximum = kind === "metadata" ? 64 * 1024 ** 2 : 64 * 1024 ** 3;
  budget.account(kind, maximum / 2);
  budget.account(kind, maximum / 2);
  assert.throws(() => budget.account(kind, 1), /byte limit/);
});


async function legacyAttestation(built, native, change = () => {}) {
  return inertAttestation(built, native, async (leaf, statement) => {
    delete leaf.artifactType;
    delete leaf.subject;
    const config = { architecture: "unknown", os: "unknown", config: {}, rootfs: { type: "layers", diff_ids: leaf.layers.map((layer) => layer.digest) } };
    await change(config, leaf, statement);
    leaf.config = await graphBlob(built, config, configType);
  });
}

test("retained legacy BuildKit unknown/unknown attestation is validated as inert", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    const native = await firstGraphLeaf(built);
    await rootGraph(built, [native.descriptor, await legacyAttestation(built, native)]);
    await repackOci(f, manifest, built);
    await loadCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations.map((args) => args[0]), ["load"]);
  } finally { await f.close(); }
});

for (const problem of ["runtime metadata", "runnable platform", "config alias", "wrong diff IDs", "config extra", "explicit subject", "wrong statement subject"]) {
  test(`legacy inert attestation ${problem} fails before load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      const native = await firstGraphLeaf(built);
      const artifact = await legacyAttestation(built, native, async (config, leaf, statement) => {
        if (problem === "runtime metadata") config.config.Env = ["RUNNABLE=yes"];
        if (problem === "runnable platform") { config.os = "linux"; config.architecture = "amd64"; }
        if (problem === "config alias") config.OS = "unknown";
        if (problem === "wrong diff IDs") config.rootfs.diff_ids = [];
        if (problem === "config extra") config.author = "unsupported";
        if (problem === "explicit subject") leaf.subject = native.descriptor;
        if (problem === "wrong statement subject") {
          statement.subject[0].digest.sha256 = "f".repeat(64);
          leaf.layers = [await graphBlob(built, statement, "application/vnd.in-toto+json", { annotations: leaf.layers[0].annotations })];
          config.rootfs.diff_ids = leaf.layers.map((layer) => layer.digest);
        }
      });
      await rootGraph(built, [native.descriptor, artifact]);
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), (error) => {
        assert.match(error.message, /legacy inert|Noncanonical|wrong subject/);
        assert.ok(!error.message.includes("RUNNABLE=yes"), "Rejection must not print runtime metadata values");
        return true;
      });
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const location of ["root", "nested", "leaf"]) for (const key of ["fsLayers", "FSLAYERS", "fſLayerſ"]) {
  test(`schema 1 ${key} discriminator in ${location} fails before Docker load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      if (location === "root") built.index[key] = [];
      else if (location === "leaf") await changeLeaf(built, (leaf) => { leaf[key] = []; });
      else {
        const native = await firstGraphLeaf(built);
        const index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [native.descriptor], [key]: [] };
        Object.assign(built.index.manifests[0], await graphBlob(built, index, index.mediaType));
      }
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /schema 1|Noncanonical/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const [field, value] of [["config", {}], ["layers", []], ["subject", null], ["artifactType", ""], ["manifests", []]]) {
  test(`unsupported root index ${field} shape fails before Docker load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      built.index[field] = value;
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /OCI descriptor|OCI index shape|OCI .* object/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const [name, change] of [
  ["urls scalar", (d) => { d.urls = "https://example.invalid/blob"; }],
  ["urls element", (d) => { d.urls = [123]; }],
  ["annotations scalar", (d) => { d.annotations = "extra"; }],
  ["annotations value", (d) => { d.annotations = { ...d.annotations, extra: 123 }; }],
  ["data array", (d) => { d.data = [1, 2]; }],
  ["artifactType number", (d) => { d.artifactType = 123; }],
  ["platform string", (d) => { d.platform = "linux/amd64"; }],
  ["platform architecture number", (d) => { d.platform = { os: "linux", architecture: 123 }; }],
  ["platform variant null", (d) => { d.platform = { os: "linux", architecture: "amd64", variant: null }; }],
  ["platform os.features element", (d) => { d.platform = { os: "linux", architecture: "amd64", "os.features": [123] }; }],
]) test(`OCI descriptor ${name} type fails before Docker load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    change(built.index.manifests[0]);
    await repackOci(f, manifest, built);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Invalid OCI/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

for (const location of ["root", "leaf", "config descriptor", "layer descriptor"]) test(`OCI ${location} annotation values are strings before Docker load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    if (location === "root") built.index.annotations = { extra: 123 };
    else await changeLeaf(built, (leaf) => {
      const object = location === "leaf" ? leaf : location === "config descriptor" ? leaf.config : leaf.layers[0];
      object.annotations = { extra: 123 };
    });
    await repackOci(f, manifest, built);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /annotations type/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

for (const [name, change] of [
  ["created number", (c) => { c.created = 123; }],
  ["created invalid timestamp", (c) => { c.created = "not-a-timestamp"; }],
  ["created invalid calendar date", (c) => { c.created = "2026-02-31T00:00:00Z"; }],
  ["author object", (c) => { c.author = {}; }],
  ["history created number", (c) => { c.history = [{ created: 123 }]; }],
  ["history empty_layer number", (c) => { c.history = [{ empty_layer: 1 }]; }],
  ["RootFS diff_ids element", (c) => { c.rootfs.diff_ids = [123]; }],
  ["runtime Env element", (c) => { c.config = { Env: [123] }; }],
  ["runtime Cmd scalar", (c) => { c.config = { Cmd: "start" }; }],
  ["runtime Labels value", (c) => { c.config = { Labels: { extra: 123 } }; }],
  ["runtime User number", (c) => { c.config = { User: 123 }; }],
  ["runtime ArgsEscaped string", (c) => { c.config = { ArgsEscaped: "true" }; }],
  ["runtime StopTimeout fractional", (c) => { c.config = { StopTimeout: 1.5 }; }],
  ["runtime ExposedPorts value", (c) => { c.config = { ExposedPorts: { "80/tcp": 123 } }; }],
  ["runtime Volumes array", (c) => { c.config = { Volumes: [] }; }],
  ["runtime health Test element", (c) => { c.config = { Healthcheck: { Test: [123] } }; }],
  ["runtime health Interval string", (c) => { c.config = { Healthcheck: { Interval: "1000000000" } }; }],
  ["container_config Env element", (c) => { c.container_config = { Env: [123] }; }],
]) test(`foreign image ${name} typed metadata fails before Docker load`, async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    const native = await firstGraphLeaf(built);
    await rootGraph(built, [native.descriptor, await foreignGraphLeaf(built, native, change)]);
    await repackOci(f, manifest, built);
    await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Invalid .*type/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

for (const problem of ["native attestation", "undeclared attestation", "nested foreign contradiction", "nested foreign index contradiction", "nested absent attestation contradiction"]) {
  test(`missing graph ${problem} fails before Docker load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      const native = await firstGraphLeaf(built);
      const absent = { mediaType: manifestType, digest: `sha256:${"f".repeat(64)}`, size: 100, platform: { os: "linux", architecture: "arm64" } };
      const artifact = { mediaType: manifestType, digest: `sha256:${"e".repeat(64)}`, size: 100, platform: { os: "unknown", architecture: "unknown" }, annotations: {
        "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": absent.digest,
      } };
      let children;
      if (problem === "native attestation" || problem === "undeclared attestation") {
        artifact.annotations["vnd.docker.reference.digest"] = problem === "native attestation" ? native.descriptor.digest : `sha256:${"d".repeat(64)}`;
        children = [native.descriptor, artifact];
      } else if (problem === "nested absent attestation contradiction") {
        children = [native.descriptor, absent, await graphIndex(built, [artifact], { platform: { os: "linux", architecture: "amd64" } })];
      } else {
        const nested = await graphIndex(built, [absent], { platform: { os: "linux", architecture: problem.includes("index") ? "s390x" : "amd64" } });
        children = [native.descriptor, nested];
      }
      await rootGraph(built, children);
      await repackOci(f, manifest, built);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Missing attestation must reference|Nested index and runnable platforms differ/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("canonical nested absent foreign image and its absent attestation remain supported", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    const native = await firstGraphLeaf(built);
    const foreignPlatform = { os: "linux", architecture: "arm64" };
    const absent = { mediaType: manifestType, digest: `sha256:${"f".repeat(64)}`, size: 100, platform: foreignPlatform };
    const artifact = { mediaType: manifestType, digest: `sha256:${"e".repeat(64)}`, size: 100, platform: { os: "unknown", architecture: "unknown" }, annotations: {
      "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": absent.digest,
    } };
    await rootGraph(built, [native.descriptor, await graphIndex(built, [absent, artifact], { platform: foreignPlatform })]);
    await repackOci(f, manifest, built);
    await validateCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

for (const [field, value] of [["Config", 123], ["RepoTags", "unexpected"], ["Layers", [123]], ["Parent", {}], ["LayerSources", []]]) {
  test(`Docker manifest ${field} typed metadata fails before Docker load`, async () => {
    const f = await fixture();
    try {
      const file = join(f.archives, "manifest.json");
      const saved = JSON.parse(await readFile(file, "utf8"));
      const configs = saved.map((entry) => entry.Config);
      saved[0][field] = value;
      await writeFile(file, JSON.stringify(saved));
      await run("tar", ["-cf", join(f.directory, "images.tar"), "-C", f.archives, "manifest.json", "layer.tar", ...configs]);
      await f.alter(async (manifest) => { manifest.archive.sha256 = manifest.files["images.tar"] = hash(await readFile(join(f.directory, "images.tar"))); });
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Invalid Docker|Invalid layer sources/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const location of ["root schema", "nested schema", "leaf schema", "root descriptor", "nested descriptor", "config descriptor", "layer descriptor"]) {
  for (const spelling of ["decimal", "exponent"]) test(`${location} ${spelling} integer token fails before Docker load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
      const token = (value) => `${value}${spelling === "decimal" ? ".0" : "e0"}`;
      let indexJson;
      if (location.startsWith("root")) {
        indexJson = JSON.stringify(built.index).replace(location.endsWith("schema") ? /"schemaVersion":(\d+)/ : /"size":(\d+)/,
          (match, number) => match.replace(number, token(number)));
      } else {
        const native = await firstGraphLeaf(built);
        let json;
        let mediaType = manifestType;
        if (location.startsWith("nested")) {
          mediaType = "application/vnd.oci.image.index.v1+json";
          json = JSON.stringify({ schemaVersion: 2, mediaType, manifests: [native.descriptor] });
          json = json.replace(location.endsWith("schema") ? /"schemaVersion":(\d+)/ : /"size":(\d+)/,
            (match, number) => match.replace(number, token(number)));
        } else {
          json = JSON.stringify(native.leaf);
          if (location === "leaf schema") json = json.replace('"schemaVersion":2', `"schemaVersion":${token(2)}`);
          else {
            const descriptor = JSON.stringify(location === "config descriptor" ? native.leaf.config : native.leaf.layers[0]);
            json = json.replace(descriptor, descriptor.replace(/"size":(\d+)/, (match, number) => match.replace(number, token(number))));
          }
        }
        Object.assign(built.index.manifests[0], await graphBlob(built, json, mediaType));
        indexJson = JSON.stringify(built.index);
      }
      await writeFile(join(built.root, "index.json"), indexJson);
      await run("tar", ["-cf", join(f.directory, "images.tar"), "-C", built.root, "oci-layout", "index.json", "manifest.json", "blobs"]);
      await updateArchive(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /JSON metadata integer token type/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const [field, token] of [["StopTimeout", "1.0"], ["StopTimeout", "1e0"], ["Interval", "1E+9"], ["Retries", "1.00"]]) {
  test(`runtime ${field} ${token} token fails before Docker load`, async () => {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      await classicConfig(f, manifest, (config) => {
        const value = Number(token);
        config.config = field === "StopTimeout" ? { [field]: value } : { Healthcheck: { [field]: value } };
        return JSON.stringify(config).replace(`"${field}":${value}`, `"${field}":${token}`);
      });
      await repackClassic(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /JSON metadata integer token type/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("structured metadata restriction also rejects noninteger extension tokens and oversized integers", async () => {
  for (const token of ["1.5", "9007199254740993"]) {
    const f = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
      await classicConfig(f, manifest, (config) => JSON.stringify(config).replace(/}$/, `,"ignoredExtension":${token}}`));
      await repackClassic(f, manifest);
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /JSON metadata integer token/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  }
});

test("inert in-toto predicate numbers remain generic JSON", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.directory, "candidate.json"), "utf8"));
    const built = await ociArchive(f, manifest.images, join(f.directory, "images.tar"), { producerIsClassic: true });
    const native = await firstGraphLeaf(built);
    const artifact = await inertAttestation(built, native, async (leaf, statement) => {
      statement.predicate = { confidence: 1.25, exponent: 1 };
      const json = JSON.stringify(statement).replace('"exponent":1', '"exponent":1e0');
      leaf.layers = [await graphBlob(built, json, "application/vnd.in-toto+json", { annotations: leaf.layers[0].annotations })];
    });
    await rootGraph(built, [native.descriptor, artifact]);
    await repackOci(f, manifest, built);
    await validateCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

async function lateTarHeader(f, change) {
  const archive = join(f.directory, "images.tar");
  const bytes = await readFile(archive);
  let selected;
  for (let offset = 0; offset < bytes.length && !bytes.subarray(offset, offset + 512).every((byte) => byte === 0);) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name.endsWith(".json") && name !== "manifest.json") selected = header;
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, ""), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(selected, "Fixture must have a late config header");
  change(selected);
  selected.fill(32, 148, 156);
  selected.write(selected.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  await writeFile(archive, bytes);
  await f.alter((manifest) => { manifest.archive.sha256 = manifest.files["images.tar"] = hash(bytes); });
}

for (const [field, start, length] of [["mode", 100, 8], ["uid", 108, 8], ["gid", 116, 8], ["mtime", 136, 12],
  ["devmajor", 329, 8], ["devminor", 337, 8], ["GNU atime", 345, 12], ["GNU ctime", 357, 12]]) {
  test(`invalid late TAR ${field} number fails before Docker load despite a valid checksum`, async () => {
    const f = await fixture();
    try {
      await lateTarHeader(f, (header) => {
        // GNU has no USTAR prefix; atime and ctime occupy these header bytes.
        header.write("ustar ", 257, 6, "ascii");
        header.write(" \0", 263, 2, "ascii");
        header.fill(0, start, start + length);
        header[start] = 0x7a;
      });
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Invalid TAR number/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const problem of ["invalid octal digit", "embedded NUL", "negative base-256", "oversized base-256"]) {
  test(`late TAR numeric ${problem} fails before Docker load`, async () => {
    const f = await fixture();
    try {
      await lateTarHeader(f, (header) => {
        const field = header.subarray(108, 116);
        if (problem === "invalid octal digit") { field.fill(0); field[0] = 0x38; }
        else if (problem === "embedded NUL") { field.fill(0); field[0] = 0x31; field[2] = 0x32; }
        else if (problem === "negative base-256") field.fill(0xff);
        else field.writeBigUInt64BE((1n << 63n) | (1n << 53n));
      });
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute }), /Invalid TAR number|Negative TAR number|Oversized TAR number/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("supported empty zero and positive base-256 TAR metadata remain valid", async () => {
  const f = await fixture();
  try {
    await lateTarHeader(f, (header) => {
      for (const [start, length] of [[100, 8], [108, 8], [116, 8], [136, 12], [329, 8], [337, 8], [345, 12], [357, 12]]) header.fill(0, start, start + length);
      header.write("ustar ", 257, 6, "ascii");
      header.write(" \0", 263, 2, "ascii");
      header.subarray(108, 116).writeBigUInt64BE((1n << 63n) | 1234n);
    });
    await validateCandidate(f.directory, { execute: f.execute });
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});


test("preparation builds each gateway target once and pins each Compose to its saved target", async () => {
  const f = await fixture();
  try {
    const manifest = await validateCandidate(f.directory, { execute: f.execute, expectedCommit: commit });
    assert.equal(f.builds.length, 3);
    const gatewayBuilds = f.builds.filter((args) => args.includes("docker/gateway.Dockerfile"));
    assert.deepEqual(gatewayBuilds.map((args) => args[args.indexOf("--target") + 1]), ["runtime", "dokploy"]);
    const gateway = manifest.images.find((image) => image.role === "gateway");
    const dokploy = manifest.images.find((image) => image.role === "gateway-dokploy");
    assert.notEqual(gateway.configId, dokploy.configId);
    for (const [file, image] of [["compose.production.yml", gateway], ["compose.dokploy.dev.yml", gateway], ["compose.dokploy.yml", dokploy]]) {
      const compose = await readFile(join(f.directory, file), "utf8");
      assert.ok(compose.includes(`  gateway:\n    image: ${image.tag}\n    pull_policy: never`));
      assert.doesNotMatch(compose, /^\s+build:/m);
    }
    assert.equal(await candidateImageId(f.directory, "gateway-dokploy", { execute: f.execute, expectedCommit: commit }), dokploy.id);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test("new source client versions remain distinct from the actual public compatibility selection", async () => {
  const sourceVersions = { "@vardum/cli": "0.7.0", "@vardum/mcp": "0.3.0", "@vardum/shared": "0.3.0" };
  const f = await fixture({ sourceVersions });
  try {
    const manifest = await validateCandidate(f.directory, { execute: f.execute, expectedCommit: commit });
    assert.deepEqual(manifest.sourceClientVersions, sourceVersions);
    assert.deepEqual(manifest.clientVersions, publicCompatibilityClients);
    assert.deepEqual(Object.fromEntries(publicCompatibilityRelease().packages.map((pkg) => [pkg.name, pkg.version])), manifest.clientVersions);
    assert.equal(manifest.clientVersions["@vardum/cli"], "0.6.0");
    assert.equal(manifest.clientVersions["@vardum/mcp"], "0.2.0");
  } finally { await f.close(); }
});

for (const problem of ["duplicate time", "decreasing time", "zero time", "unsafe time", "fractional time", "string time", "index order", "tag order", "current tag order", "missing 0015", "missing 0016", "missing 0017", "missing 0018", "missing 0019", "missing 0020", "unknown current tag", "duplicate current tag", "unreviewed 0021", "duplicate JSON time"]) {
  test(`migration journal ${problem} fails before Docker mutation despite recomputed hashes`, async () => {
    const f = await fixture();
    try {
      const path = join(f.directory, "migrations/_journal.json");
      const journal = JSON.parse(await readFile(path, "utf8"));
      if (problem === "duplicate time") journal.entries[1].when = journal.entries[0].when;
      else if (problem === "decreasing time") journal.entries[1].when = journal.entries[0].when - 1;
      else if (problem === "zero time") journal.entries[0].when = 0;
      else if (problem === "unsafe time") journal.entries[0].when = Number.MAX_SAFE_INTEGER + 1;
      else if (problem === "fractional time") journal.entries[0].when = 1.5;
      else if (problem === "string time") journal.entries[0].when = String(journal.entries[0].when);
      else if (problem === "index order") journal.entries[1].idx = 0;
      else if (problem === "tag order") [journal.entries[0].tag, journal.entries[1].tag] = [journal.entries[1].tag, journal.entries[0].tag];
      else if (problem === "current tag order") [journal.entries[19].tag, journal.entries[20].tag] = [journal.entries[20].tag, journal.entries[19].tag];
      else if (problem === "missing 0015") journal.entries.splice(15, 1);
      else if (problem === "missing 0016") journal.entries.splice(16, 1);
      else if (problem === "missing 0017") journal.entries.splice(17, 1);
      else if (problem === "missing 0018") journal.entries.splice(18, 1);
      else if (problem === "missing 0019") journal.entries.splice(19, 1);
      else if (problem === "missing 0020") journal.entries.pop();
      else if (problem === "unknown current tag") journal.entries[20].tag = "0020_unreviewed";
      else if (problem === "duplicate current tag") journal.entries[20].tag = journal.entries[19].tag;
      else if (problem === "unreviewed 0021") journal.entries.push({ ...journal.entries.at(-1), idx: 21, tag: "0021_unreviewed", when: journal.entries.at(-1).when + 1 });
      let bytes = JSON.stringify(journal);
      if (problem === "duplicate JSON time") bytes = bytes.replace(/"when":(\d+)/, '"when":$1,"when":$1');
      await writeFile(path, bytes);
      await f.alter((manifest) => { manifest.files["migrations/_journal.json"] = hash(bytes); });
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute, expectedCommit: commit }), /migration|Migration|metadata integer|Duplicate decoded JSON/);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

for (const migrationTag of ["0017_asset_uses", "0018_asset_archive", "0019_upload_object_integrity", "0020_vard_definition_bindings"]) for (const problem of ["missing SQL", "SQL byte drift", "declared hash drift", "recomputed inventory hash"]) {
  test(`${migrationTag} migration ${problem} fails before Docker mutation`, async () => {
    const f = await fixture();
    try {
      const file = `migrations/${migrationTag}.sql`;
      const path = join(f.directory, file);
      if (problem === "missing SQL") await rm(path);
      else if (problem === "declared hash drift") await f.alter((manifest) => { manifest.migrations.find((migration) => migration.file === file).sha256 = "0".repeat(64); });
      else {
        const bytes = `${await readFile(path, "utf8")}\n-- fixture-only SQL drift\n`;
        await writeFile(path, bytes);
        if (problem === "recomputed inventory hash") await f.alter((manifest) => { manifest.files[file] = hash(bytes); });
      }
      await assert.rejects(loadCandidate(f.directory, { execute: f.execute, expectedCommit: commit }), /missing candidate file|checksum|migration hashes/i);
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  });
}

test("candidate Compose rejects later application builds, pulls and policy overrides", () => {
  const previous = process.env.SMOKE_SERVER_CANDIDATE;
  process.env.SMOKE_SERVER_CANDIDATE = "/checked-candidate";
  try {
    for (const args of [["build"], ["pull"], ["up", "--build"], ["run", "--build"], ["up", "--pull=always"], ["run", "--pull", "always"]])
      assert.throws(() => candidateComposeArgs(args), /cannot build or pull|cannot override/);
  } finally {
    if (previous === undefined) delete process.env.SMOKE_SERVER_CANDIDATE; else process.env.SMOKE_SERVER_CANDIDATE = previous;
  }
});

test("only named field projections and hashes leave raw evidence; secret sentinels and raw exports stay local", async () => {
  const f = await fixture();
  const secret = "SECRET_SENTINEL_MUST_STAY_LOCAL";
  try {
    const runtime = join(f.root, "runtime");
    const output = join(f.root, "sanitized");
    await mkdir(runtime);
    const manifest = await validateCandidate(f.directory, { execute: f.execute, expectedCommit: commit });
    const id = (role) => manifest.images.find((image) => image.role === role).id;
    const runtimeReport = { sourceCommit: commit, sourceStatus: secret, status: "scan-complete-requires-vendor-and-finding-assessment",
      scanner: "aquasec/trivy:0.75.0", images: { api: { id: id("api"), Config: { Env: [secret] } }, worker: { id: id("api") }, gateway: { id: id("gateway") } },
      database: { sha256: hash("database"), metadataSha256: hash("metadata"), privateMetadata: secret },
      findings: { api: [{ id: "CVE-2026-35189", package: "openssl", installed: "3.5.8", fixed: "3.5.9", severity: "LOW", source: `https://example.invalid/${secret}` }] },
      invocations: [{ args: [secret] }], error: secret, rawLogs: secret };
    await writeFile(join(runtime, "runtime-evidence.json"), JSON.stringify(runtimeReport));
    await writeFile(join(runtime, "api-scan.json"), JSON.stringify({ Metadata: { ImageConfig: { config: { Env: [secret] } } }, error: secret }));
    await writeFile(join(runtime, "api-runtime.json"), JSON.stringify({ environment: secret }));
    await writeFile(join(f.root, "private.txt"), secret);
    await symlink(join(f.root, "private.txt"), join(runtime, "worker-runtime.json"));
    await writeFile(join(runtime, "images.tar"), secret);
    await writeFile(join(runtime, "trivy.db"), secret);
    await symlink(join(f.root, "private.txt"), join(runtime, "unknown.json"));
    await mkdir(join(runtime, "runtime-tls"));
    await writeFile(join(runtime, "runtime-tls/summary.json"), JSON.stringify({ sourceCommit: commit, status: "passed",
      images: { api: id("api"), worker: id("api"), migrate: id("api"), postgres: id("postgres"), rustfs: id("rustfs") },
      cases: [{ status: "passed", rawError: secret, commands: [secret] }], privateCertificatesRemoved: true, commands: [secret], error: secret }));
    await mkdir(join(runtime, "dokploy-gateway-config"));
    await writeFile(join(runtime, "dokploy-gateway-config/gateway-config-evidence.json"), JSON.stringify({ status: "passed", gatewayImage: id("gateway"),
      apiImage: id("api"), dokployImage: id("gateway-dokploy"), templateSha256: hash("template"),
      modes: { standard: { checks: [{ passed: true, path: secret, upstreamResponse: secret }], passed: true }, [secret]: { secret } },
      commands: [{ args: [secret], error: secret }], error: secret, rawLogs: secret, coldStart: { passed: true, error: secret } }));
    const projected = await writeServerEvidence({ candidateDirectory: f.directory, runtimeDirectory: runtime, outputDirectory: output,
      expectedCommit: commit, acceptanceStatus: "success", execute: f.execute });
    assert.equal(projected.candidate.status, "verified");
    assert.equal(projected.candidate.offlineReplay, false);
    assert.equal(projected.candidate.releaseCertification, "pending");
    assert.deepEqual((await readdir(output)).sort(), [...evidenceFiles].sort());
    for (const file of evidenceFiles) assert.ok(!(await readFile(join(output, file), "utf8")).includes(secret));
    assert.equal(projected.acceptance.reports["runtime-evidence.json"].findings.api[0].id, "CVE-2026-35189");
    assert.equal(projected.acceptance.reports["dokploy-gateway-config/gateway-config-evidence.json"].images["gateway-dokploy"], id("gateway-dokploy"));
    assert.equal(projected.acceptance.reportHashes["api-scan.json"], hash(await readFile(join(runtime, "api-scan.json"))));
    assert.equal(projected.acceptance.reportHashes["worker-runtime.json"], undefined);
    assert.equal(projected.acceptance.reportHashes["images.tar"], undefined);
    assert.equal(projected.acceptance.reportHashes["trivy.db"], undefined);
    assert.equal(projected.acceptance.reportHashes["unknown.json"], undefined);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test("sanitized evidence never promotes an invalid candidate or copies arbitrary validation errors", async () => {
  const f = await fixture();
  try {
    await f.alter((manifest) => { manifest.source.commit = "c".repeat(40); });
    const result = await writeServerEvidence({ candidateDirectory: f.directory, runtimeDirectory: join(f.root, "missing-runtime"), outputDirectory: join(f.root, "sanitized"),
      expectedCommit: commit, acceptanceStatus: "failure", execute: f.execute });
    assert.equal(result.candidate.status, "invalid-or-incomplete");
    assert.equal(result.candidate.manifestSha256, undefined);
    assert.equal(result.acceptance.acceptanceStatus, "failure");
    assert.equal(result.acceptance.reports["runtime-evidence.json"].status, "missing-invalid-or-unsafe");
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});


test("public compatibility consumers never execute new CLI import or guarded MCP editor checks", async () => {
  const attempted = [];
  for (const feature of ["folderVardImport", "vardEditRevision"]) {
    assert.deepEqual(await runInstalledConsumerCheck(feature, { publicRegistry: true }, async () => {
      attempted.push(feature);
      assert.fail("An older public consumer must not attempt an unsupported protocol");
    }), { status: "unsupported-by-public-compatibility" });
  }
  assert.deepEqual(attempted, []);
  for (const feature of ["folderVardImport", "vardEditRevision"]) {
    assert.deepEqual(await runInstalledConsumerCheck(feature, { publicRegistry: false }, async () => { attempted.push(feature); }), { status: "passed" });
  }
  assert.deepEqual(attempted, ["folderVardImport", "vardEditRevision"]);
  await assert.rejects(runInstalledConsumerCheck("folderVardImport", {}, async () => {}), /Explicit installed consumer/);
});
