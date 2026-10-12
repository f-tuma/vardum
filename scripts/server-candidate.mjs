#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { publicCompatibilityClients, run } from "./release-packages.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
export const serverVersion = "server-v0.7.0"; // Provisional; preparation never tags or publishes.
const platform = "linux/amd64";
const clients = publicCompatibilityClients;
const roles = ["api", "gateway", "gateway-dokploy", "postgres", "rustfs", "rustfs-init"];
const migrationTags = [
  "0000_useful_the_enforcers", "0001_open_songbird", "0002_lucky_xorn", "0003_wealthy_mimic",
  "0004_slimy_stellaris", "0005_greedy_magdalene", "0006_robust_fallen_one", "0007_optimal_annihilus",
  "0008_marvelous_centennial", "0009_asset_visibility", "0010_vard_folder_rules", "0011_asset_ingest_recovery",
  "0012_worker_heartbeat", "0013_upload_cleanup", "0014_upload_cleanup_fairness", "0015_upload_request_checksum",
  "0016_known_usage_inventory",
];
const sourcePackagePaths = ["apps/cli", "apps/mcp", "packages/shared"];
const sources = { postgres: "postgres:17-alpine", rustfs: "rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c", "rustfs-init": "amazon/aws-cli:2.36.47" };
const payload = [
  "compose.production.yml", "compose.dokploy.yml", "compose.dokploy.dev.yml",
  ".env.production.example", ".env.dokploy.example", "docker/nginx.conf",
  "docker/nginx.marketing.conf.template", "docker/monitoring/alerts.yml",
  "docs/operations.md", "docs/npm-release.md", "docs/server-release.md",
  "scripts/backup.mjs", "scripts/release-packages.mjs", "scripts/server-candidate.mjs",
];
const safePath = (path) => {
  assert.equal(typeof path, "string", "Invalid artifact path");
  assert.match(path, /^[A-Za-z0-9._/-]+$/, "Invalid artifact path");
  assert.ok(!path.startsWith("/") && !path.split("/").some((part) => !part || part === "." || part === ".."), "Unsafe artifact path");
  return path;
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function inventory(directory, prefix = "") {
  const files = [];
  assert.ok((await lstat(directory)).isDirectory(), "Candidate directory must not be a symlink");
  for (const entry of await readdir(directory)) {
    const path = safePath(prefix + entry);
    const item = await lstat(join(directory, entry));
    assert.ok(!item.isSymbolicLink(), "Candidate must not contain symlinks");
    if (item.isDirectory()) files.push(...await inventory(join(directory, entry), `${path}/`));
    else {
      assert.ok(item.isFile() && item.nlink === 1, "Candidate must contain only ordinary files (no hard links)");
      files.push(path);
    }
  }
  return files.sort();
}

// encoding/json can merge repeated objects and matches struct fields using
// Unicode SimpleFold. Scan decoded keys before JSON.parse can discard them.
// Annotation/label/map keys remain case-sensitive; only known struct fields are
// required to use the canonical spelling understood by this verifier. Structured
// Docker/OCI metadata supports integer number tokens only, before JSON.parse
// can erase decimal/exponent spellings that Go integer fields cannot decode.
// In-toto predicate content is an inert generic JSON blob, not image metadata.
function parseMetadata(bytes, { genericNumbers = false } = {}) {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assert.ok(Buffer.byteLength(text) <= 16 * 1024 ** 2, "Oversized JSON metadata");
  let offset = 0;
  let values = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(text[offset] ?? "")) offset++; };
  const string = () => {
    assert.equal(text[offset++], '"', "Invalid JSON string");
    let decoded = "";
    let start = offset;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') {
        decoded += text.slice(start, offset - 1);
        for (const rune of decoded) assert.ok(rune.codePointAt(0) < 0xd800 || rune.codePointAt(0) > 0xdfff, "Unpaired JSON surrogate");
        return decoded;
      }
      assert.ok(char.charCodeAt(0) >= 32, "Invalid JSON control character");
      if (char !== "\\") continue;
      decoded += text.slice(start, offset - 1);
      const escape = text[offset++];
      if (escape === "u") {
        const hex = text.slice(offset, offset + 4);
        assert.match(hex, /^[a-fA-F0-9]{4}$/, "Invalid JSON Unicode escape");
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
      } else {
        const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        assert.ok(Object.hasOwn(escapes, escape), "Invalid JSON escape");
        decoded += escapes[escape];
      }
      start = offset;
    }
    assert.fail("Unterminated JSON string");
  };
  const primitive = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  const value = (depth) => {
    assert.ok(depth <= 128 && ++values <= 1_000_000, "JSON metadata exceeds nesting or value limit");
    whitespace();
    if (text[offset] === '"') { string(); return; }
    const object = text[offset] === "{";
    if (object || text[offset] === "[") {
      const closing = object ? "}" : "]";
      const keys = new Set();
      offset++;
      whitespace();
      if (text[offset] === closing) { offset++; return; }
      while (true) {
        if (object) {
          const key = string();
          assert.ok(!keys.has(key), "Duplicate decoded JSON key");
          keys.add(key);
          whitespace();
          assert.equal(text[offset++], ":", "Invalid JSON object");
        }
        value(depth + 1);
        whitespace();
        if (text[offset] === closing) { offset++; return; }
        assert.equal(text[offset++], ",", "Invalid JSON separator");
        whitespace();
      }
    }
    primitive.lastIndex = offset;
    const token = primitive.exec(text)?.[0];
    assert.ok(token, "Invalid JSON value");
    if (!genericNumbers && /^[-0-9]/.test(token)) {
      assert.match(token, /^-?(?:0|[1-9][0-9]*)$/, "Invalid JSON metadata integer token type");
      assert.ok(Number.isSafeInteger(Number(token)), "Oversized JSON metadata integer token");
    }
    offset = primitive.lastIndex;
  };
  value(0);
  whitespace();
  assert.equal(offset, text.length, "Unexpected JSON trailing data");
  return JSON.parse(text);
}

// All known structural fields are ASCII. Go's only non-ASCII SimpleFold
// orbits reaching ASCII are long s (S/s/ſ) and Kelvin sign (K/k/K).
const foldField = (key) => key.replace(/[a-zſK]/g, (char) => char === "ſ" ? "S" : char === "K" ? "K" : char.toUpperCase());
function structuralKeys(object, fields, context) {
  assert.ok(object && typeof object === "object" && !Array.isArray(object), `Invalid ${context} object`);
  const canonical = new Map(fields.map((field) => [foldField(field), field]));
  for (const key of Object.keys(object)) {
    const field = canonical.get(foldField(key));
    assert.ok(!field || key === field, `Noncanonical JSON structural key in ${context}`);
  }
}
const platformFields = ["architecture", "os", "os.version", "os.features", "variant"];
const objectValue = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const stringMap = (value) => objectValue(value) && Object.values(value).every((item) => typeof item === "string");
const objectMap = (value) => objectValue(value) && Object.values(value).every((item) => item === null || objectValue(item));
const stringValue = (value) => typeof value === "string";
const booleanValue = (value) => typeof value === "boolean";
const integerValue = (value) => Number.isSafeInteger(value);
const timestampValue = (value) => {
  if (!stringValue(value)) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59 &&
    (!parts[7] || (Number(parts[8]) <= 23 && Number(parts[9]) <= 59)) && Number.isFinite(Date.parse(value));
};
function typedFields(object, fields, context, nullable = false) {
  for (const [field, valid] of Object.entries(fields)) if (object[field] !== undefined && !(nullable && object[field] === null)) {
    assert.ok(valid(object[field]), `Invalid ${context} ${field} type`);
  }
}
const platformTypes = { architecture: stringValue, os: stringValue, "os.version": stringValue, "os.features": stringArray, variant: stringValue };
function descriptorKeys(descriptor) {
  structuralKeys(descriptor, ["mediaType", "digest", "size", "urls", "annotations", "data", "platform", "artifactType"], "OCI descriptor");
  assert.ok(stringValue(descriptor.mediaType) && stringValue(descriptor.digest) && integerValue(descriptor.size) && descriptor.size >= 0, "Invalid OCI descriptor required fields");
  typedFields(descriptor, { urls: stringArray, annotations: stringMap, data: stringValue, artifactType: stringValue }, "OCI descriptor");
  if (descriptor.platform != null) {
    structuralKeys(descriptor.platform, platformFields, "OCI platform");
    typedFields(descriptor.platform, platformTypes, "OCI platform");
  }
}
function graphKeys(graph) {
  structuralKeys(graph, ["schemaVersion", "mediaType", "artifactType", "manifests", "config", "layers", "subject", "annotations", "fsLayers"], "OCI index/manifest");
  assert.ok(!Object.hasOwn(graph, "fsLayers"), "Unsupported schema 1 fsLayers");
  typedFields(graph, { mediaType: stringValue, artifactType: stringValue, annotations: stringMap }, "OCI index/manifest");
  for (const field of ["manifests", "layers"]) if (graph[field] !== undefined) {
    assert.ok(Array.isArray(graph[field]), `Invalid OCI ${field} list`);
    for (const descriptor of graph[field]) descriptorKeys(descriptor);
  }
  for (const field of ["config", "subject"]) if (graph[field] !== undefined) descriptorKeys(graph[field]);
}
function indexShape(index) {
  assert.ok(Array.isArray(index.manifests) && index.manifests.length && index.config === undefined && index.layers === undefined && index.subject === undefined && index.artifactType === undefined,
    "Unsupported OCI index shape");
}
function dockerManifestKeys(images) {
  assert.ok(Array.isArray(images), "Invalid Docker manifest list");
  for (const image of images) {
    structuralKeys(image, ["Config", "RepoTags", "Layers", "Parent", "LayerSources"], "Docker manifest entry");
    assert.ok(stringValue(image.Config) && stringArray(image.RepoTags) && stringArray(image.Layers), "Invalid Docker manifest field types");
    typedFields(image, { Parent: stringValue }, "Docker manifest");
    if (image.LayerSources != null) {
      assert.ok(objectValue(image.LayerSources), "Invalid layer sources map");
      for (const descriptor of Object.values(image.LayerSources)) descriptorKeys(descriptor);
    }
  }
}
function configKeys(config) {
  structuralKeys(config, [...platformFields, "created", "author", "config", "rootfs", "history",
    "id", "parent", "comment", "container", "container_config", "docker_version", "Size", "virtual_size"], "image config");
  typedFields(config, platformTypes, "image config platform");
  typedFields(config, { created: timestampValue, author: stringValue, id: stringValue, parent: stringValue, comment: stringValue,
    container: stringValue, docker_version: stringValue, Size: integerValue, virtual_size: integerValue }, "image config", true);
  if (config.rootfs != null) {
    structuralKeys(config.rootfs, ["type", "diff_ids", "base_layer"], "config RootFS");
    typedFields(config.rootfs, { type: stringValue, diff_ids: stringArray, base_layer: stringValue }, "config RootFS");
  }
  if (config.history != null) {
    assert.ok(Array.isArray(config.history), "Invalid config history");
    for (const entry of config.history) {
      structuralKeys(entry, ["created", "created_by", "author", "comment", "empty_layer"], "config history entry");
      typedFields(entry, { created: timestampValue, created_by: stringValue, author: stringValue, comment: stringValue, empty_layer: booleanValue }, "config history", true);
    }
  }
  for (const field of ["config", "container_config"]) if (config[field] != null) {
    const runtime = config[field];
    structuralKeys(runtime, ["Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr",
      "ExposedPorts", "Tty", "OpenStdin", "StdinOnce", "Env", "Cmd", "Healthcheck", "ArgsEscaped", "Image",
      "Volumes", "WorkingDir", "Entrypoint", "NetworkDisabled", "OnBuild", "Labels", "StopSignal", "StopTimeout", "Shell"], "runtime config");
    typedFields(runtime, { Hostname: stringValue, Domainname: stringValue, User: stringValue, Image: stringValue, WorkingDir: stringValue, StopSignal: stringValue,
      AttachStdin: booleanValue, AttachStdout: booleanValue, AttachStderr: booleanValue, Tty: booleanValue, OpenStdin: booleanValue, StdinOnce: booleanValue,
      ArgsEscaped: booleanValue, NetworkDisabled: booleanValue, Env: stringArray, Cmd: stringArray, Entrypoint: stringArray, OnBuild: stringArray, Shell: stringArray,
      Labels: stringMap, ExposedPorts: objectMap, Volumes: objectMap, StopTimeout: integerValue }, "runtime config", true);
    if (runtime.Healthcheck != null) {
      structuralKeys(runtime.Healthcheck, ["Test", "Interval", "Timeout", "StartPeriod", "StartInterval", "Retries"], "runtime healthcheck");
      typedFields(runtime.Healthcheck, { Test: stringArray, Interval: integerValue, Timeout: integerValue, StartPeriod: integerValue,
        StartInterval: integerValue, Retries: integerValue }, "runtime healthcheck", true);
    }
  }
}

// Strip every build section and pin every service to its archived image. Keep
// environment substitutions, volumes and routing portable across installations.
export function candidateCompose(text, images) {
  const lines = text.split("\n");
  const output = [];
  let service;
  let inServices = false;
  let skipping = false;
  for (const line of lines) {
    if (/^\S/.test(line) && !line.startsWith("#")) inServices = line === "services:";
    if (!inServices) { output.push(line); continue; }
    if (skipping && (/^ {5}/.test(line) || !line.trim())) continue;
    skipping = false;
    if (/^  [a-z][a-z0-9-]*:$/.test(line)) service = line.trim().slice(0, -1);
    if (/^    build:$/.test(line)) { skipping = true; continue; }
    if (/^    image:/.test(line)) continue;
    output.push(line);
    if (/^  [a-z][a-z0-9-]*:$/.test(line) && images[service]) {
      output.push(`    image: ${images[service].tag}`, "    pull_policy: never");
    }
  }
  assert.doesNotMatch(output.join("\n"), /^\s+build:/m);
  return output.join("\n");
}

async function inspectImage(tag, execute) {
  return JSON.parse((await execute("docker", ["image", "inspect", tag])).stdout)[0];
}
async function missingImage(tag, execute) {
  try { return await inspectImage(tag, execute); }
  catch (error) {
    if (error.code === 1 && /No such image/i.test(error.stderr ?? "")) return null;
    throw error;
  }
}
async function checkImage(image, expected, execute = run) {
  assert.equal(`${image.Os}/${image.Architecture}`, platform, "Wrong image platform");
  const identities = expected.verifiedArchive?.ids ?? [expected.id, expected.configId];
  if (identities.includes(image.Id)) return image.Id;
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/, `Wrong image loaded for ${expected.role}`);
  // Legacy import may reuse an already-compressed layer and synthesize a
  // store-dependent descriptor. Do not guess that ID or trust inspect metadata
  // alone: a read-only export must authenticate its graph against the original
  // saved config (whose digest includes runtime metadata and RootFS diff IDs).
  const temporary = await mkdtemp(join(tmpdir(), "vardum-image-identity-"));
  try {
    const archive = join(temporary, "image.tar");
    await execute("docker", ["save", "--output", archive, expected.tag], { timeout: 10 * 60_000 });
    const translated = { ...expected, id: image.Id };
    await readSavedImages(archive, [translated], execute, { requireOci: true });
    const config = translated.verifiedArchive.config;
    assert.deepEqual(image.RootFS, { Type: config.rootfs.type, Layers: config.rootfs.diff_ids }, "Translated image RootFS differs from the saved config");
    identities.push(image.Id); // Only this authenticated host graph adds an ID.
    return image.Id;
  } catch (error) {
    throw new Error(`Wrong image loaded for ${expected.role}: ${error.message}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function normalizeUploadOrigins(value) {
  assert.equal(typeof value, "string", "Pass explicit development upload origins");
  const origins = value.trim().split(/[\s,]+/);
  assert.ok(origins.length && origins.every(Boolean), "Pass explicit development upload origins");
  return [...new Set(origins.map((origin) => {
    const url = new URL(origin);
    assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "Pass HTTP(S) development origins without secrets or paths");
    return url.origin;
  }))].join(",");
}

// Candidate profiles are an explicit test choice, never a deployment default.
// Node26 is Current; this selection does not authorize a production transition.
const apiRuntimeProfiles = Object.freeze({
  node22: Object.freeze({ name: "node22", baseImage: "gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c" }),
  node26: Object.freeze({ name: "node26", baseImage: "gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a3bb283a564754266646d6029c5b6aa4f760b9415dae1398db8d7f8142ee1375" }),
});
const node26Observation = Object.freeze({ node: "26.11.0", openssl: "3.5.9", uid: 65532,
  platform: "linux/amd64", nodeSha256: "c445d85bb8886e15bbc85973134274fb190088233b174841b9999dbabfeef9f8" });
export function candidateApiRuntime(name = "node22") {
  assert.ok(typeof name === "string" && Object.hasOwn(apiRuntimeProfiles, name), "Unknown API runtime candidate profile");
  return { ...apiRuntimeProfiles[name] };
}
export function validateApiRuntimeSelection(value) {
  // Older saved bundles do not declare a profile. Do not infer one from tags.
  if (value === undefined) return null;
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Invalid API runtime selection");
  const profile = candidateApiRuntime(value.profile?.name);
  // Require the fixed profile and only its safe observed fields. Labels alone
  // are not runtime proof; preparation and running acceptance probe the image.
  const expected = { profile, observation: profile.name === "node26" ? { ...node26Observation } : null };
  assert.deepEqual(value, expected, "API runtime selection or observation does not match the verified profile");
  return expected;
}
export async function probeCandidateApiRuntime(imageId, profile, execute = run) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/, "API runtime probe requires an immutable host image ID");
  assert.deepEqual(profile, candidateApiRuntime(profile.name), "Unknown API runtime probe profile");
  if (profile.name !== "node26") return null;
  const source = `
    const { readFileSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    console.log(JSON.stringify({ node: process.versions.node, openssl: process.versions.openssl,
      uid: process.getuid(), platform: process.platform + "/" + (process.arch === "x64" ? "amd64" : process.arch),
      nodeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex") }));
  `;
  const result = await execute("docker", ["run", "--rm", "--platform", platform, "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "256m",
    "--entrypoint", "node", imageId, "-e", source], { timeout: 30_000, maxBuffer: 16_384 });
  const observation = JSON.parse(result.stdout);
  assert.deepEqual(observation, node26Observation, "Observed API runtime does not match the verified Node26 candidate");
  return observation;
}

export async function prepareCandidate(directory, { execute = run, allowDirty = false, uploadOrigins = "http://localhost:19000", apiRuntime = "node22" } = {}) {
  const runtimeProfile = candidateApiRuntime(apiRuntime);
  directory = resolve(directory);
  const git = async (...args) => (await execute("git", args, { cwd: repo })).stdout.trim();
  const commit = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  const dirty = Boolean(await git("status", "--porcelain", "--untracked-files=all"));
  assert.ok(!dirty || allowDirty, "Candidate requires a clean checkout; --allow-dirty is for local implementation proof only");
  uploadOrigins = normalizeUploadOrigins(uploadOrigins);
  // Refuse reuse before any image/tag mutation. No existing artifacts or smoke
  // tags are overwritten; each preparation gets a unique candidate namespace.
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false });
  let contextRoot;
  let buildRepo = repo;
  try {
  if (!dirty) {
    contextRoot = await mkdtemp(join(tmpdir(), "vardum-build-context-"));
    buildRepo = join(contextRoot, "source");
    await mkdir(buildRepo);
    await execute("git", ["archive", "--format=tar", "--output", join(contextRoot, "source.tar"), commit], { cwd: repo });
    await execute("tar", ["-xf", join(contextRoot, "source.tar"), "-C", buildRepo]);
  }
  const sourceClientVersions = {};
  for (const path of sourcePackagePaths) {
    const source = parseMetadata(await readFile(join(buildRepo, path, "package.json")));
    assert.ok(Object.hasOwn(clients, source.name), "Unexpected source client package");
    assert.match(source.version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid source client version");
    sourceClientVersions[source.name] = source.version;
  }
  const suffix = `${serverVersion}-${commit.slice(0, 12)}-${randomBytes(6).toString("hex")}`;
  const images = {};
  let runtimeObservation = null;
  for (const role of roles) {
    const tag = `vardum-candidate-${role}:${suffix}`;
    assert.equal(await missingImage(tag, execute), null, "Refuse to overwrite candidate image tag");
    if (role === "api" || role.startsWith("gateway")) {
      // A fresh config subject avoids subject-linked referrers left by earlier
      // builds in a containerd store. Local labels are isolation metadata, not
      // authenticated provenance; vendor graph verification stays unchanged.
      await execute("docker", ["build", "--platform", platform, "--provenance=false",
        "--label", `org.opencontainers.image.revision=${commit}`,
        "--label", `io.vardum.candidate.namespace=${suffix}`, "--tag", tag,
        "--file", `docker/${role === "api" ? "api" : "gateway"}.Dockerfile`,
        ...(role.startsWith("gateway") ? ["--target", role === "gateway-dokploy" ? "dokploy" : "runtime",
          "--build-arg", `VITE_UPLOAD_ORIGINS=${uploadOrigins}`] : ["--build-arg", `API_RUNTIME_IMAGE=${runtimeProfile.baseImage}`]), "."],
      { cwd: buildRepo, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    } else {
      if (!await missingImage(sources[role], execute))
        await execute("docker", ["pull", "--platform", platform, sources[role]], { timeout: 10 * 60_000 });
      const source = await inspectImage(sources[role], execute);
      assert.equal(`${source.Os}/${source.Architecture}`, platform);
      await execute("docker", ["tag", source.Id, tag]);
    }
    const image = await inspectImage(tag, execute);
    images[role] = { role, tag, id: image.Id, platform, ...(sources[role] ? { source: sources[role] } : {}) };
    await checkImage(image, images[role], execute);
    if (role === "api") runtimeObservation = await probeCandidateApiRuntime(image.Id, runtimeProfile, execute);
  }
  const composeImages = { ...images, migrate: images.api, worker: images.api };
  for (const file of payload) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    if (file.startsWith("compose.")) await writeFile(join(directory, file), candidateCompose(await readFile(join(buildRepo, file), "utf8"),
      file === "compose.dokploy.yml" ? { ...composeImages, gateway: images["gateway-dokploy"] } : composeImages));
    else await copyFile(join(buildRepo, file), join(directory, file));
  }
  const journal = parseMetadata(await readFile(join(buildRepo, "apps/api/drizzle/meta/_journal.json")));
  validateMigrationJournal(journal);
  const migrations = [];
  for (const entry of journal.entries) {
    const file = `migrations/${entry.tag}.sql`;
    await mkdir(join(directory, "migrations"), { recursive: true });
    await copyFile(join(buildRepo, "apps/api/drizzle", `${entry.tag}.sql`), join(directory, file));
    migrations.push({ file, sha256: await hashFile(join(directory, file)) });
  }
  await copyFile(join(buildRepo, "apps/api/drizzle/meta/_journal.json"), join(directory, "migrations/_journal.json"));
  const archive = "images.tar";
  await execute("docker", ["save", "--output", join(directory, archive), ...roles.map((role) => images[role].tag)], { timeout: 10 * 60_000 });
  const saved = parseMetadata((await execute("tar", ["-xOf", join(directory, archive), "manifest.json"])).stdout);
  dockerManifestKeys(saved);
  for (const image of Object.values(images)) {
    const entry = saved.find((item) => item.RepoTags?.includes(image.tag));
    assert.ok(entry, "Saved image missing");
    image.configId = `sha256:${digest((await execute("tar", ["-xOf", join(directory, archive), entry.Config], { maxBuffer: 16 * 1024 * 1024 })).stdout)}`;
  }
  const files = {};
  for (const file of await inventory(directory)) files[file] = await hashFile(join(directory, file));
  assert.equal(await git("rev-parse", "HEAD"), commit, "Source commit changed during preparation");
  assert.equal(await git("rev-parse", "HEAD^{tree}"), tree, "Source tree changed during preparation");
  if (!allowDirty) assert.equal(await git("status", "--porcelain", "--untracked-files=all"), "", "Checkout changed during preparation");
  const manifest = {
    schema: 1, serverVersion, platform, source: { commit, tree, dirty, context: dirty ? "dirty-working-tree" : "tracked-commit" },
    sourceClientVersions, clientVersions: clients, uploadOrigins,
    apiRuntime: { profile: runtimeProfile, observation: runtimeObservation },
    images: roles.map((role) => images[role]), migrations,
    archive: { file: archive, sha256: files[archive] }, files,
  };
  await writeFile(join(directory, "candidate.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateCandidate(directory, { execute });
  return manifest;
  } finally { if (contextRoot) await rm(contextRoot, { recursive: true, force: true }); }
}

export function validateMigrationJournal(journal) {
  assert.ok(objectValue(journal) && Array.isArray(journal.entries), "Invalid migration journal");
  assert.equal(journal.entries.length, migrationTags.length, "Candidate requires migrations through 0016");
  let previous = 0;
  for (const [index, entry] of journal.entries.entries()) {
    assert.equal(entry.idx, index, "Invalid migration index/order");
    assert.equal(entry.tag, migrationTags[index], "Unexpected migration tag/order");
    assert.ok(Number.isSafeInteger(entry.when) && entry.when > previous, "Migration times must be positive safe integers in increasing order");
    previous = entry.when;
  }
}

// No extraction, Docker load, tagging, or Compose operation occurs until all
// paths, inventory, checksums, tar entries and saved image identities pass.
export async function validateCandidate(directory, { execute = run, expectedCommit, requireClean = false } = {}) {
  directory = resolve(directory);
  const actual = await inventory(directory);
  assert.ok(actual.includes("candidate.json"), "Missing candidate manifest");
  const manifest = parseMetadata(await readFile(join(directory, "candidate.json")));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.serverVersion, serverVersion, "Wrong server candidate version");
  assert.equal(manifest.platform, platform, "Only linux/amd64 is certified");
  validateApiRuntimeSelection(manifest.apiRuntime);
  assert.match(manifest.source?.commit ?? "", /^[a-f0-9]{40}$/);
  assert.match(manifest.source?.tree ?? "", /^[a-f0-9]{40}$/);
  assert.equal(typeof manifest.source?.dirty, "boolean");
  assert.equal(manifest.source.context, manifest.source.dirty ? "dirty-working-tree" : "tracked-commit", "Invalid source context");
  if (requireClean) assert.equal(manifest.source.dirty, false, "Dirty preparation artifact cannot certify a server release");
  if (expectedCommit) assert.equal(manifest.source.commit, expectedCommit, "Wrong candidate source commit");
  assert.deepEqual(manifest.clientVersions, clients, "Wrong compatible clients");
  assert.ok(objectValue(manifest.sourceClientVersions), "Missing source client versions");
  assert.deepEqual(Object.keys(manifest.sourceClientVersions).sort(), Object.keys(clients).sort(), "Wrong source client package set");
  for (const version of Object.values(manifest.sourceClientVersions))
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid source client version");
  assert.equal(manifest.archive?.file, "images.tar");
  assert.deepEqual(manifest.images?.map((image) => image.role), roles);
  for (const image of manifest.images) {
    assert.equal(image.platform, platform);
    assert.match(image.id, /^sha256:[a-f0-9]{64}$/);
    assert.match(image.configId, /^sha256:[a-f0-9]{64}$/);
    assert.match(image.tag, new RegExp(`^vardum-candidate-${image.role}:${serverVersion}-${manifest.source.commit.slice(0, 12)}-[a-f0-9]{12}$`));
  }
  const journal = parseMetadata(await readFile(join(directory, "migrations/_journal.json")));
  validateMigrationJournal(journal);
  const migrationFiles = journal.entries.map((entry) => `migrations/${entry.tag}.sql`);
  const expected = [...payload, ...migrationFiles, "migrations/_journal.json", "images.tar"].sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), expected, "Unexpected candidate payload");
  assert.deepEqual(actual, [...expected, "candidate.json"].sort(), "Unexpected or missing candidate file");
  for (const [file, sha256] of Object.entries(manifest.files)) {
    safePath(file);
    assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.equal(await hashFile(join(directory, file)), sha256, `Candidate checksum failed: ${file}`);
  }
  assert.equal(manifest.archive.sha256, manifest.files["images.tar"]);
  assert.deepEqual(manifest.migrations, migrationFiles.map((file) => ({ file, sha256: manifest.files[file] })), "Candidate migration hashes must match the verified file inventory");
  const archive = join(directory, "images.tar");
  await readSavedImages(archive, manifest.images, execute);
  return manifest;
}

// Read the actual headers rather than GNU tar's visual listing: a REGTYPE
// name ending in '/' is printed as a directory but imported as a regular file.
// Only the ordinary USTAR/GNU short-name records emitted by Docker save are
// supported. Reject extension records rather than letting another parser apply
// hidden path/size overrides. Body data is read by its validated byte range.
const maxArchiveSize = 64 * 1024 ** 3;
const maxLayerSize = 16 * 1024 ** 3;
const metadataLimit = 16 * 1024 ** 2;
async function archiveEntries(archive) {
  const handle = await open(archive, "r");
  try {
    const archiveSize = (await handle.stat()).size;
    assert.ok(Number.isSafeInteger(archiveSize) && archiveSize <= maxArchiveSize && archiveSize % 512 === 0, "Invalid or oversized image archive");
    const entries = new Map();
    const block = Buffer.alloc(512);
    const number = (field, allowEmpty = false) => {
      let value;
      if (field[0] & 0x80) {
        assert.equal(field[0] & 0x40, 0, "Negative TAR number");
        value = BigInt(field[0] & 0x7f);
        for (const byte of field.subarray(1)) value = (value << 8n) + BigInt(byte);
        assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), "Oversized TAR number");
        return Number(value);
      }
      assert.ok(field.every((byte) => byte === 0 || byte === 32 || (byte >= 48 && byte <= 55)), "Invalid TAR number");
      const text = field.toString("ascii").replace(/^[\0 ]+|[\0 ]+$/g, "");
      if (allowEmpty && !text) return 0;
      assert.match(text, /^[0-7]+$/, "Invalid TAR number");
      const octal = BigInt(`0o${text}`);
      assert.ok(octal <= BigInt(Number.MAX_SAFE_INTEGER), "Oversized TAR number");
      return Number(octal);
    };
    const string = (field) => field.toString("utf8").replace(/\0.*$/, "");
    let offset = 0;
    while (offset < archiveSize) {
      assert.equal((await handle.read(block, 0, 512, offset)).bytesRead, 512, "Truncated TAR header");
      if (block.every((byte) => byte === 0)) {
        assert.ok(archiveSize - offset >= 1024, "Missing TAR end marker");
        // No appended metadata after the first end marker may reach Docker.
        const padding = Buffer.alloc(1024 * 1024);
        while (offset < archiveSize) {
          const length = Math.min(padding.length, archiveSize - offset);
          assert.equal((await handle.read(padding, 0, length, offset)).bytesRead, length, "Truncated TAR padding");
          assert.ok(padding.subarray(0, length).every((byte) => byte === 0), "Nonzero data after TAR end marker");
          offset += length;
        }
        return entries;
      }
      let checksum = 0;
      for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : block[index];
      assert.ok(!(block[148] & 0x80), "Invalid TAR checksum encoding");
      assert.equal(number(block.subarray(148, 156)), checksum, "TAR header checksum failed");
      const magic = block.subarray(257, 263).toString("latin1");
      const version = block.subarray(263, 265).toString("latin1");
      const supported = magic === "\0".repeat(6) || (magic === "ustar " && version === " \0") ||
        (magic === "ustar\0" && version === "00" && block.subarray(508, 512).toString("latin1") !== "tar\0");
      assert.ok(supported, "Unsupported TAR format");
      // Go archive/tar parses these numbers even for ordinary files. Validate
      // the entire archive before Docker can import any earlier content.
      for (const [start, length] of [[100, 8], [108, 8], [116, 8], [136, 12]]) number(block.subarray(start, start + length), true);
      if (magic !== "\0".repeat(6)) {
        for (const start of [329, 337]) number(block.subarray(start, start + 8), true);
      }
      if (magic === "ustar ") {
        // No legacy Go GNU-prefix fallback: only actual numeric atime/ctime.
        for (const start of [345, 357]) number(block.subarray(start, start + 12), true);
      }
      const prefix = magic === "ustar\0" ? string(block.subarray(345, 500)) : "";
      const name = `${prefix ? `${prefix}/` : ""}${string(block.subarray(0, 100))}`;
      const type = block[156];
      assert.ok([0, 48, 53].includes(type), "Image archive must not contain links, extensions or special files");
      const directory = type === 53;
      assert.ok(directory || !name.endsWith("/"), "Regular TAR file cannot have a trailing slash");
      const canonical = safePath(directory ? name.replace(/\/$/, "") : name);
      assert.ok(!entries.has(canonical), "Duplicate canonical archive paths");
      const size = number(block.subarray(124, 136));
      assert.ok(size <= maxLayerSize && (!directory || size === 0), "Invalid TAR entry size");
      const dataOffset = offset + 512;
      const next = dataOffset + Math.ceil(size / 512) * 512;
      assert.ok(Number.isSafeInteger(next) && next <= archiveSize, "Truncated TAR entry");
      entries.set(canonical, { directory, size, dataOffset });
      assert.ok(entries.size <= 100_000, "Too many TAR entries");
      offset = next;
    }
    assert.fail("Missing TAR end marker");
  } finally { await handle.close(); }
}

async function archiveBytes(archive, entry, length = entry.size) {
  assert.ok(length <= metadataLimit && length <= entry.size, "Oversized image metadata");
  const handle = await open(archive, "r");
  try {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = await handle.read(bytes, offset, length - offset, entry.dataOffset + offset);
      assert.ok(read.bytesRead, "Truncated archive data");
      offset += read.bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}

async function archiveBlob(archive, entry, compression = "none") {
  if (entry.size === 0) {
    assert.equal(compression, "none", "Empty compressed layer");
    return { digest: `sha256:${digest(Buffer.alloc(0))}`, size: 0 };
  }
  const hash = createHash("sha256");
  let size = 0;
  const sink = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maxLayerSize) return callback(new Error("Decoded layer exceeds size limit"));
    hash.update(chunk);
    callback();
  } });
  const source = createReadStream(archive, { start: entry.dataOffset, end: entry.dataOffset + entry.size - 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Archive layer read timed out")), 120_000);
  try {
    await pipeline(source, ...(compression === "gzip" ? [createGunzip()] : []), sink, { signal: controller.signal });
    return { digest: `sha256:${hash.digest("hex")}`, size };
  } finally { clearTimeout(timer); }
}

export function createGraphBudget() {
  const measured = { metadata: 0, encoded: 0, decoded: 0 };
  return { count: 0, active: new Set(), account(kind, size) {
    assert.ok(Object.hasOwn(measured, kind) && Number.isSafeInteger(size) && size >= 0, "Invalid graph byte accounting");
    measured[kind] += size;
    assert.ok(measured[kind] <= (kind === "metadata" ? 64 * 1024 ** 2 : maxArchiveSize), `OCI graph ${kind} byte limit exceeded`);
  } };
}

// Count occurrences, not unique digests: equal native leaves at different paths
// remain ambiguous. A shared budget covers all candidate roots and blob edges.
export async function walkSavedGraph(descriptor, readNode, onLeaf, state = createGraphBudget(), ancestors = []) {
  assert.ok(++state.count <= 1024, "OCI graph reference count exceeds limit");
  assert.ok(ancestors.length <= 16, "OCI graph depth exceeds limit");
  assert.ok(!state.active.has(descriptor.digest), "OCI graph cycle");
  state.active.add(descriptor.digest);
  try {
    const node = await readNode(descriptor, ancestors.length === 0, ancestors);
    if (node === null) return;
    if (node.manifests) {
      for (const child of node.manifests) await walkSavedGraph(child, readNode, onLeaf, state, [...ancestors, descriptor]);
    } else await onLeaf(descriptor, node, ancestors);
  } finally { state.active.delete(descriptor.digest); }
}

function canonicalPlatform(value, allowArtifact = false) {
  structuralKeys(value, platformFields, "image platform");
  assert.ok(Object.keys(value).every((key) => platformFields.includes(key)), "Unsupported platform field");
  const oses = ["aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "nacl", "netbsd", "openbsd", "plan9", "solaris", "windows", "zos"];
  const arches = ["386", "amd64", "amd64p32", "arm", "armbe", "arm64", "arm64be", "ppc64", "ppc64le", "loong64", "mips", "mipsle", "mips64", "mips64le", "mips64p32", "mips64p32le", "ppc", "riscv", "riscv64", "s390", "s390x", "sparc", "sparc64", "wasm"];
  if (allowArtifact && value.os === "unknown" && value.architecture === "unknown") {
    assert.deepEqual(Object.keys(value).sort(), ["architecture", "os"], "Unsupported artifact platform");
    return "unknown/unknown";
  }
  assert.ok(oses.includes(value.os) && arches.includes(value.architecture), "Noncanonical or unsupported image platform");
  let variant = value.variant ?? "";
  if (value.architecture === "arm") {
    assert.ok(["", "v5", "v6", "v7", "v8"].includes(variant), "Unsupported ARM variant");
    variant ||= "v7";
  } else if (value.architecture === "arm64") {
    assert.ok(["", "v8", "v9"].includes(variant), "Unsupported ARM64 variant");
    if (variant === "v8") variant = "";
  } else assert.equal(variant, "", "Unsupported image variant");
  if (value["os.version"] !== undefined) assert.equal(typeof value["os.version"], "string", "Invalid OS version");
  if (value["os.features"] !== undefined) assert.ok(Array.isArray(value["os.features"]) && value["os.features"].every((feature) => typeof feature === "string"), "Invalid OS features");
  if (`${value.os}/${value.architecture}` === platform) {
    assert.ok(!value["os.version"] && !value["os.features"]?.length, "Unsupported certified platform constraints");
  }
  return `${value.os}/${value.architecture}${variant ? `/${variant}` : ""}`;
}
const configPlatform = (config) => canonicalPlatform(Object.fromEntries(platformFields.filter((field) => config[field] !== undefined).map((field) => [field, config[field]])));

async function readSavedImages(archive, expectedImages, execute, { requireOci = false } = {}) {
  const entries = await archiveEntries(archive);
  const entry = (file) => {
    safePath(file);
    assert.ok(entries.has(file) && !entries.get(file).directory, `Missing archive file: ${file}`);
    return entries.get(file);
  };
  const extract = (file) => archiveBytes(archive, entry(file));
  const state = createGraphBudget();
  const metadataSeen = new Set();
  const account = state.account;
  const metadata = async (file) => {
    const bytes = await extract(file);
    if (!metadataSeen.has(file)) { metadataSeen.add(file); account("metadata", bytes.length); }
    return bytes;
  };
  const identities = new Map();
  const blob = async (file) => {
    if (!identities.has(file)) {
      account("encoded", entry(file).size);
      identities.set(file, archiveBlob(archive, entry(file)));
    }
    return identities.get(file);
  };
  const hasOci = entries.has("oci-layout");
  assert.equal(entries.has("index.json"), hasOci, "OCI layout and index must be present together");
  assert.ok(hasOci || !requireOci, "Translated image requires an authenticated OCI descriptor");
  const archiveIndex = hasOci ? parseMetadata(await metadata("index.json")) : null;
  if (hasOci) {
    const layout = parseMetadata(await metadata("oci-layout"));
    structuralKeys(layout, ["imageLayoutVersion"], "OCI layout");
    assert.equal(layout.imageLayoutVersion, "1.0.0", "Unsupported OCI layout version");
    graphKeys(archiveIndex);
    indexShape(archiveIndex);
    assert.equal(archiveIndex.schemaVersion, 2, "Invalid OCI index schema");
    assert.deepEqual(archiveIndex.manifests.map((item) => item.annotations?.["io.containerd.image.name"]).sort(),
      expectedImages.map((item) => `docker.io/library/${item.tag}`).sort(), "Unexpected OCI saved image tags");
  }
  const descriptorPath = (descriptor) => {
    descriptorKeys(descriptor);
    assert.match(descriptor?.digest ?? "", /^sha256:[a-f0-9]{64}$/, "Invalid OCI descriptor digest");
    assert.ok(Number.isSafeInteger(descriptor.size) && descriptor.size >= 0, "Invalid OCI descriptor size");
    return `blobs/sha256/${descriptor.digest.slice(7)}`;
  };
  const indexTypes = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
  const manifestTypes = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
  const configTypes = ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"];
  const layerTypes = new Map([
    ["application/vnd.oci.image.layer.v1.tar", "none"],
    ["application/vnd.docker.image.rootfs.diff.tar", "none"],
    ["application/vnd.oci.image.layer.v1.tar+gzip", "gzip"],
    ["application/vnd.docker.image.rootfs.diff.tar.gzip", "gzip"],
  ]);
  if (archiveIndex?.mediaType !== undefined) assert.ok(indexTypes.includes(archiveIndex.mediaType), "Invalid OCI root index media type");
  const decodedLayers = new Map();
  const layerCompression = async (file) => {
    const bytes = await archiveBytes(archive, entry(file), Math.min(6, entry(file).size));
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
    assert.ok(!["28b52ffd", "fd377a585a00", "425a68", "04224d18"].some((magic) => bytes.toString("hex").startsWith(magic)), "Unsupported layer compression");
    return "none";
  };
  const diffId = async (file, compression) => {
    assert.equal(await layerCompression(file), compression, "Layer compression does not match media type");
    const key = `${compression}:${file}`;
    if (!decodedLayers.has(key)) decodedLayers.set(key, archiveBlob(archive, entry(file), compression).then((layer) => { account("decoded", layer.size); return layer; }));
    return (await decodedLayers.get(key)).digest;
  };
  const verifyBody = async (descriptor, countReference = true) => {
    if (countReference) assert.ok(++state.count <= 1024, "OCI graph reference count exceeds limit");
    const file = descriptorPath(descriptor);
    const packed = await blob(file);
    assert.equal(packed.digest, descriptor.digest, "Saved descriptor checksum failed");
    assert.equal(packed.size, descriptor.size, "Saved descriptor size mismatch");
    if (descriptor.data !== undefined) {
      assert.equal(typeof descriptor.data, "string", "Invalid inline descriptor data");
      assert.ok(descriptor.data.length <= Math.ceil(metadataLimit / 3) * 4, "Oversized inline descriptor data");
      const bytes = Buffer.from(descriptor.data, "base64");
      assert.equal(bytes.toString("base64"), descriptor.data, "Noncanonical inline descriptor data");
      assert.equal(`sha256:${digest(bytes)}`, descriptor.digest, "Inline descriptor checksum mismatch");
      assert.equal(bytes.length, descriptor.size, "Inline descriptor size mismatch");
    }
    return file;
  };
  const attestationType = "application/vnd.docker.attestation.manifest.v1+json";
  const referenceType = "vnd.docker.reference.type";
  const referenceDigest = "vnd.docker.reference.digest";
  const emptyConfigType = "application/vnd.oci.empty.v1+json";
  const emptyConfigId = `sha256:${digest("{}")}`;
  const validateRootFs = (config, layerCount) => {
    configKeys(config);
    const actualPlatform = configPlatform(config);
    assert.equal(config.rootfs?.type, "layers", "Invalid saved config RootFS type");
    assert.ok(Array.isArray(config.rootfs.diff_ids), "Invalid saved config diff IDs");
    assert.equal(config.rootfs.diff_ids.length, layerCount, "Config diff IDs and layer count differ");
    for (const id of config.rootfs.diff_ids) assert.match(id, /^sha256:[a-f0-9]{64}$/, "Invalid config diff ID");
    return actualPlatform;
  };
  const validateImageGraph = async (descriptor, expected) => {
    const matches = [];
    const runnable = new Map();
    const declared = new Map();
    const declareRunnable = (id, actualPlatform) => {
      assert.ok(!declared.has(id) || declared.get(id) === actualPlatform, "Contradictory runnable platform declarations");
      declared.set(id, actualPlatform);
    };
    const ancestorPlatforms = (ancestors, actualPlatform) => {
      for (const ancestor of ancestors) if (ancestor.platform != null) {
        assert.equal(canonicalPlatform(ancestor.platform), actualPlatform, "Nested index and runnable platforms differ");
      }
    };
    const artifacts = [];
    const absentArtifacts = [];
    const readNode = async (current, root, ancestors) => {
      const file = descriptorPath(current);
      assert.ok([...indexTypes, ...manifestTypes].includes(current.mediaType), "Invalid OCI graph media type");
      assert.ok(root || current.platform != null, "Platform-less OCI index child is ambiguous");
      const actualPlatform = current.platform == null ? null : canonicalPlatform(current.platform, true);
      const artifact = actualPlatform === "unknown/unknown";
      if (artifact) {
        assert.ok(manifestTypes.includes(current.mediaType) && current.annotations?.[referenceType] === "attestation-manifest", "Unsupported inert artifact descriptor");
        assert.match(current.annotations?.[referenceDigest] ?? "", /^sha256:[a-f0-9]{64}$/, "Invalid attestation reference digest");
      } else {
        assert.ok(current.annotations?.[referenceType] === undefined && current.annotations?.[referenceDigest] === undefined, "Runnable descriptor cannot be marked as an artifact");
        if (actualPlatform) {
          ancestorPlatforms(ancestors, actualPlatform);
          if (manifestTypes.includes(current.mediaType)) declareRunnable(current.digest, actualPlatform);
        }
      }
      if (!entries.has(file)) {
        assert.ok(current.data === undefined && !root && manifestTypes.includes(current.mediaType) && actualPlatform && actualPlatform !== platform,
          "Missing matching, platform-less or index reference");
        if (artifact) absentArtifacts.push({ descriptor: current, ancestors });
        return null;
      }
      await verifyBody(current, false);
      const decoded = parseMetadata(await metadata(file));
      graphKeys(decoded);
      assert.equal(decoded.schemaVersion, 2, "Invalid OCI manifest schema");
      assert.equal(decoded.mediaType, current.mediaType, "Invalid decoded OCI manifest media type");
      if (indexTypes.includes(current.mediaType)) {
        indexShape(decoded);
      } else {
        assert.ok(decoded.manifests === undefined && decoded.config && Array.isArray(decoded.layers), "Invalid OCI image manifest shape");
        if (artifact) artifacts.push({ descriptor: current, manifest: decoded, ancestors });
      }
      return decoded;
    };
    await walkSavedGraph(descriptor, readNode, async (current, leaf, ancestors) => {
      if (current.platform?.os === "unknown") return; // Validated separately as an inert artifact.
      assert.ok(!leaf.artifactType && leaf.subject === undefined, "Unsupported runnable artifact/subject form");
      assert.ok(configTypes.includes(leaf.config.mediaType), "Invalid OCI config media type");
      const configFile = await verifyBody(leaf.config);
      const config = parseMetadata(await metadata(configFile));
      const actualPlatform = validateRootFs(config, leaf.layers.length);
      if (current.platform != null) assert.equal(canonicalPlatform(current.platform), actualPlatform, "Descriptor and config platforms differ");
      ancestorPlatforms(ancestors, actualPlatform);
      declareRunnable(current.digest, actualPlatform);
      for (const [index, layer] of leaf.layers.entries()) {
        assert.ok(layerTypes.has(layer.mediaType), "Unsupported OCI layer media type");
        const file = await verifyBody(layer);
        assert.equal(await diffId(file, layerTypes.get(layer.mediaType)), config.rootfs.diff_ids[index], "Decoded layer does not match config diff ID");
      }
      const record = { descriptor: current, manifest: leaf, config };
      runnable.set(current.digest, record);
      if (actualPlatform === platform) matches.push(record);
    }, state);
    assert.equal(matches.length, 1, "Saved OCI graph must contain exactly one certified runnable leaf");
    const matching = matches[0];
    assert.equal(matching.manifest.config.digest, expected.configId, "OCI platform manifest points to the wrong config");
    for (const { descriptor: absent, ancestors } of absentArtifacts) {
      const referencedPlatform = declared.get(absent.annotations[referenceDigest]);
      assert.ok(referencedPlatform && referencedPlatform !== platform, "Missing attestation must reference a canonical foreign runnable manifest");
      ancestorPlatforms(ancestors, referencedPlatform);
    }
    for (const artifact of artifacts) {
      const { descriptor: current, manifest: leaf, ancestors } = artifact;
      let subjectDigest;
      if (leaf.artifactType !== undefined) {
        assert.equal(leaf.artifactType, attestationType, "Unsupported inert artifact type");
        assert.equal(leaf.config.mediaType, emptyConfigType, "Attestation must use an empty config");
        assert.equal(leaf.config.digest, emptyConfigId, "Attestation config is not empty");
        assert.equal((await metadata(await verifyBody(leaf.config))).toString("utf8"), "{}", "Attestation config is not empty");
        assert.ok(manifestTypes.includes(leaf.subject?.mediaType), "Attestation requires a runnable subject");
        await verifyBody(leaf.subject);
        const subject = runnable.get(leaf.subject.digest);
        assert.ok(subject && subject.descriptor.mediaType === leaf.subject.mediaType, "Attestation subject is not a validated runnable leaf");
        subjectDigest = leaf.subject.digest;
        assert.equal(current.annotations[referenceDigest], subjectDigest, "Attestation reference and subject differ");
      } else {
        // The retained PostgreSQL official image uses the older BuildKit form:
        // unknown/unknown, no artifactType/subject, empty runtime config and
        // RootFS IDs equal to the raw in-toto JSON layer digests. It is never
        // admitted as a runnable image; every field/content binding is exact.
        assert.equal(leaf.subject, undefined, "Unsupported legacy inert subject");
        assert.equal(leaf.config.mediaType, "application/vnd.oci.image.config.v1+json", "Unsupported legacy inert config media type");
        const config = parseMetadata(await metadata(await verifyBody(leaf.config)));
        configKeys(config);
        assert.ok(isDeepStrictEqual(config, { architecture: "unknown", os: "unknown", config: {}, rootfs: { type: "layers", diff_ids: leaf.layers.map((layer) => layer.digest) } }), "Unsupported legacy inert config");
        subjectDigest = current.annotations[referenceDigest];
        assert.ok(runnable.has(subjectDigest), "Legacy attestation subject is not a validated runnable leaf");
      }
      ancestorPlatforms(ancestors, configPlatform(runnable.get(subjectDigest).config));
      assert.ok(leaf.layers.length > 0, "Attestation requires in-toto content");
      for (const layer of leaf.layers) {
        assert.equal(layer.mediaType, "application/vnd.in-toto+json", "Unsupported inert artifact layer");
        const statement = parseMetadata(await metadata(await verifyBody(layer)), { genericNumbers: true });
        assert.ok(["https://in-toto.io/Statement/v1", "https://in-toto.io/Statement/v0.1"].includes(statement._type), "Invalid in-toto statement");
        assert.equal(statement.predicateType, layer.annotations?.["in-toto.io/predicate-type"], "Attestation predicate type differs");
        assert.ok(typeof statement.predicateType === "string" && statement.subject?.some((entry) => entry.digest?.sha256 === subjectDigest.slice(7)), "Attestation statement has the wrong subject");
      }
    }
    return matching;
  };
  const saved = parseMetadata(await metadata("manifest.json"));
  dockerManifestKeys(saved);
  assert.equal(saved.length, expectedImages.length, "Unexpected saved image set");
  const seen = new Set();
  for (const image of saved) {
    assert.equal(image.RepoTags?.length, 1, "Each saved image must have exactly one candidate tag");
    const expected = expectedImages.find((entry) => entry.tag === image.RepoTags[0]);
    assert.ok(expected && !seen.has(expected.role), "Unexpected or duplicate saved image tag");
    seen.add(expected.role);
    const configBytes = await metadata(image.Config);
    const configId = `sha256:${digest(configBytes)}`;
    assert.equal(configId, expected.configId, "Saved image config ID does not match manifest");
    const config = parseMetadata(configBytes);
    assert.ok(Array.isArray(image.Layers), "Invalid Docker layer list");
    assert.equal(validateRootFs(config, image.Layers.length), platform, "Wrong saved config platform");
    const ids = [configId];
    if (archiveIndex) {
      const descriptor = archiveIndex.manifests.find((item) => item.annotations?.["io.containerd.image.name"] === `docker.io/library/${expected.tag}`);
      const matching = await validateImageGraph(descriptor, expected);
      assert.equal(matching.manifest.layers.length, image.Layers.length, "OCI and Docker layer lists differ");
      for (const [index, layer] of matching.manifest.layers.entries()) {
        assert.deepEqual(await blob(image.Layers[index]), await blob(descriptorPath(layer)), "OCI and Docker layer content differs");
      }
      ids.push(descriptor.digest);
    } else for (const [index, layer] of image.Layers.entries()) {
      assert.equal(await diffId(layer, await layerCompression(layer)), config.rootfs.diff_ids[index], "Decoded layer does not match config diff ID");
    }
    assert.ok(ids.includes(expected.id), "Saved image ID does not match manifest");
    Object.defineProperty(expected, "verifiedArchive", { value: { ids, config }, enumerable: false });
  }
}

export async function loadCandidate(directory, options = {}) {
  const execute = options.execute ?? run;
  const manifest = await validateCandidate(directory, { ...options, requireClean: !options.allowDirty });
  assert.equal((await execute("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])).stdout.trim(), platform, "Candidate load requires the certified Docker host platform");
  for (const image of manifest.images) {
    const existing = await missingImage(image.tag, execute);
    if (existing) await checkImage(existing, image, execute); // Never overwrite a different image.
  }
  await execute("docker", ["load", "--input", join(resolve(directory), "images.tar")], { timeout: 10 * 60_000 });
  for (const image of manifest.images) await checkImage(await inspectImage(image.tag, execute), image, execute);
  return manifest;
}

export function candidateComposeArgs(args) {
  if (!process.env.SMOKE_SERVER_CANDIDATE) return args;
  assert.ok(!["build", "pull"].includes(args[0]), "Candidate acceptance cannot build or pull images");
  if (["up", "run"].includes(args[0]))
    assert.ok(!args.some((arg) => /^--(?:build|pull)(?:=|$)/.test(arg)), "Candidate acceptance cannot override build/pull policy");
  if (args[0] === "up") return ["up", "--no-build", "--pull", "never", ...args.slice(1)];
  // compose run has no --no-build flag. The candidate Compose contains no
  // build definitions, and run builds only with an explicit --build.
  if (args[0] === "run") return ["run", "--pull", "never", ...args.slice(1)];
  return args;
}

export async function candidateImageId(directory, role, options = {}) {
  assert.ok(roles.includes(role), "Unknown candidate image role");
  const execute = options.execute ?? run;
  const manifest = await validateCandidate(directory, { ...options, requireClean: !options.allowDirty });
  const image = manifest.images.find((entry) => entry.role === role);
  return checkImage(await inspectImage(image.tag, execute), image, execute);
}

export async function assertRunningCandidate(directory, project, { execute = run, expectedCommit } = {}) {
  assert.match(project, /^vardum-smoke-\d+(?:-restore)?$/, "Only disposable smoke projects can be inspected");
  const manifest = await validateCandidate(directory, { execute, expectedCommit });
  for (const service of ["postgres", "rustfs", "migrate", "api", "worker", "gateway"]) {
    const id = (await execute("docker", ["compose", "--env-file", "/dev/null", "-p", project, "--profile", "rustfs", "-f", join(resolve(directory), "compose.production.yml"), "ps", "--all", "--quiet", service])).stdout.trim();
    assert.ok(id && !id.includes("\n"), `Expected one ${service} container`);
    const container = JSON.parse((await execute("docker", ["inspect", id])).stdout)[0];
    const image = manifest.images.find((entry) => entry.role === (["migrate", "worker"].includes(service) ? "api" : service));
    const loaded = await inspectImage(image.tag, execute);
    const verifiedId = await checkImage(loaded, image, execute);
    assert.equal(container.Image, verifiedId, `Running ${service} has the wrong image ID`);
    assert.equal(container.Config.Image, image.tag, `Running ${service} has the wrong image tag`);
    if (service !== "migrate") assert.equal(container.State.Running, true, `${service} must be running`);
    else assert.equal(container.State.ExitCode, 0, "Candidate migration must succeed");
  }
  const selection = validateApiRuntimeSelection(manifest.apiRuntime);
  if (selection?.profile.name === "node26") {
    const api = manifest.images.find((image) => image.role === "api");
    const loadedId = await checkImage(await inspectImage(api.tag, execute), api, execute);
    await probeCandidateApiRuntime(loadedId, selection.profile, execute);
  }
  console.log(`Exact candidate image IDs passed for ${project}`);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "allow-dirty": { type: "boolean", default: false },
    "upload-origins": { type: "string", default: "http://localhost:19000" },
    "api-runtime": { type: "string" },
    "expected-commit": { type: "string" }, "require-clean": { type: "boolean", default: false }, project: { type: "string" },
    role: { type: "string" },
  } });
  const [command, directory] = positionals;
  assert.ok(positionals.length === 2 && ["prepare", "check", "load", "running", "image"].includes(command), "Usage: node scripts/server-candidate.mjs prepare|check|load|running|image DIRECTORY [--expected-commit SHA] [--upload-origins ORIGINS] [--api-runtime node22|node26] [--project disposable-project] [--role ROLE]");
  assert.ok(values["api-runtime"] === undefined || command === "prepare", "--api-runtime is only valid for preparation; saved selection cannot be overridden");
  let manifest;
  if (command === "prepare") manifest = await prepareCandidate(directory, { allowDirty: values["allow-dirty"], uploadOrigins: values["upload-origins"], apiRuntime: values["api-runtime"] });
  else if (command === "running") return assertRunningCandidate(directory, values.project, { expectedCommit: values["expected-commit"] });
  else if (command === "image") return console.log(await candidateImageId(directory, values.role, { expectedCommit: values["expected-commit"], allowDirty: values["allow-dirty"] }));
  else manifest = await (command === "load" ? loadCandidate : validateCandidate)(directory, { expectedCommit: values["expected-commit"], allowDirty: values["allow-dirty"], requireClean: values["require-clean"] });
  console.log(`${command}: ${manifest.serverVersion}, ${manifest.source.commit}, ${manifest.platform}${manifest.source.dirty ? " (dirty local implementation proof)" : ""}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
