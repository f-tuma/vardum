import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, verifyFirstProject } from "../examples/first-project/verify.mjs";
import { run } from "./release-packages.mjs";
import { loginCli } from "./smoke-installed-packages.mjs";

const example = fileURLToPath(new URL("../examples/first-project/", import.meta.url));
const version = "0.6.0";
const registry = "https://registry.npmjs.org/";
const sourceFiles = ["README.md", ".gitignore", "package.json", "package-lock.json", "verify.mjs"];

// Only smoke-production's disposable local Compose stack may be mutated.
// This installs the public release, independently of the local candidate smoke.
export async function checkOnboarding({ base, cookie, workspaceId }) {
  assert.match(process.env.SMOKE_COMPOSE_PROJECT ?? "", /^vardum-smoke-\d+$/);
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  const root = await mkdtemp(join(tmpdir(), "vardum-onboarding-"));
  async function api(path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    // Do not include response bodies: key creation responses contain credentials.
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function upload(asset, bytes, filename) {
    const path = `/api/workspaces/${workspaceId}/assets/${asset.id}`;
    const created = await api(`${path}/versions`, {
      filename, mimeType: "image/svg+xml", size: bytes.length,
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(created.upload.fields)) form.append(key, value);
    form.append("file", new Blob([bytes], { type: "image/svg+xml" }), filename);
    const stored = await fetch(created.upload.url, {
      method: created.upload.method, body: form, signal: AbortSignal.timeout(15_000),
    });
    assert.ok(stored.ok, `Onboarding storage upload: ${stored.status}`);
    await api(`${path}/versions/${created.id}/finalize`, undefined, "POST");
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await api(path);
      assert.notEqual(current.status, "failed", "Onboarding ingest failed");
      if (current.status === "ready" && current.currentVersionId === created.id) return created.id;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Onboarding ingest timed out");
  }
  async function createAsset(source, bytes) {
    const asset = await api(`/api/workspaces/${workspaceId}/assets`, {
      key: source, displayName: basename(source),
    });
    assert.equal(asset.isPublic, false);
    await upload(asset, bytes, basename(source));
    return asset;
  }
  try {
    const project = join(root, "first-consumer");
    await mkdir(project);
    for (const file of sourceFiles) await cp(join(example, file), join(project, file));
    await cp(join(example, "sample"), join(project, "sample"), { recursive: true });
    const originalNpmLock = await readFile(join(project, "package-lock.json"));
    const npmConfig = join(root, "npmrc");
    await writeFile(npmConfig, `registry=${registry}\n@vardum:registry=${registry}\n`);
    const npmEnv = { PATH: process.env.PATH, HOME: root };
    const npmArgs = ["--userconfig", npmConfig, "--registry", registry, "--cache", join(root, "npm-cache"), "--ignore-scripts", "--no-audit", "--no-fund"];
    await run("npm", ["install", "--save-dev", "--save-exact", `@vardum/cli@${version}`, ...npmArgs], {
      cwd: project, env: npmEnv, timeout: 120_000,
    });
    assert.deepEqual(await readFile(join(project, "package-lock.json")), originalNpmLock,
      "The original example lock must install unchanged; do not silently repair it");
    const packageJson = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    const npmLock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
    assert.equal(packageJson.devDependencies["@vardum/cli"], version);
    assert.equal(npmLock.packages["node_modules/@vardum/cli"].version, version);
    for (const item of Object.values(npmLock.packages))
      if (item.resolved) assert.equal(new URL(item.resolved).origin, new URL(registry).origin);
    const cli = { binary: join(project, "node_modules/.bin/vardum"), version };
    const configHome = join(root, "credentials");
    await mkdir(join(configHome, "vardum"), { recursive: true });
    await writeFile(join(configHome, "vardum/version-check.json"), JSON.stringify({ latest: version, at: Date.now() }));
    // An empty PATH stops login from opening the user's desktop browser.
    const env = { HOME: root, PATH: join(root, "no-browser"), VARDUM_CONFIG_HOME: configHome };
    const command = (...args) => run(process.execPath, [cli.binary, ...args], { cwd: project, env, timeout: 30_000 });
    assert.equal((await command("version")).stdout.trim(), version);

    const assets = new Map();
    for (const [source] of fixtures)
      assets.set(source, await createAsset(source, await readFile(join(example, source))));
    const vard = await api(`/api/workspaces/${workspaceId}/vards`, {
      name: "First project", isPublic: false,
      folderRules: [{ sourcePrefix: "sample/brand/", outputPrefix: "public/brand/" }],
    });
    assert.equal(vard.isPublic, false);
    await api(`/api/workspaces/${workspaceId}/vards/${vard.id}/items`, {
      items: [{ assetId: assets.get("sample/logo.svg").id, outputPath: "public/logo.svg", writable: false }],
    }, "PUT");
    const manifestPath = `/api/workspaces/${workspaceId}/vards/${vard.id}/manifest`;
    const manifest = await api(manifestPath);
    assert.deepEqual(manifest.items.map((item) => item.outputPath).sort(), fixtures.map(([, path]) => path).sort());
    assert.ok(manifest.items.every((item) => item.writable === false), "Every example output must be read-only");
    assert.equal((await fetch(`${base}/v/${vard.id}`)).status, 404);
    await command("init", "--server", base, "--workspace", workspaceId, "--vard", vard.id, "--json");
    await assert.rejects(command("pull", "--json"), (error) => {
      const failure = JSON.parse(error.stderr);
      assert.ok(/404|private|auth/i.test(failure.error));
      assert.deepEqual(failure.actions, []);
      return true;
    });
    for (const path of ["public", ".vardum.lock"]) await assert.rejects(stat(join(project, path)), { code: "ENOENT" });

    const loginKey = await loginCli({ cli, project, env, base, workspaceId, api, access: "read" });
    const credentialPath = join(configHome, "vardum/credentials.json");
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    assert.ok(!credentialPath.startsWith(`${project}/`));
    const authorizedRead = await fetch(`${base}/api/workspaces/${workspaceId}/sync/assets?prefix=sample/`, {
      headers: { "x-api-key": loginKey },
    });
    assert.equal(authorizedRead.status, 200, "The exact login key must read private assets without a session cookie");
    assert.equal((await authorizedRead.json()).assets.length, 3);
    assert.equal(JSON.parse((await command("pull", "--json")).stdout).changed, 3);
    const deniedWrite = await fetch(`${base}/api/workspaces/${workspaceId}/assets`, {
      method: "POST", headers: { "x-api-key": loginKey, "content-type": "application/json" },
      body: JSON.stringify({ key: "sample/denied.svg", displayName: "Denied" }),
    });
    // API-key action denials are 401 in authorizeAsset; the successful read and
    // private CLI pull above prove this is a known key with insufficient access.
    assert.equal(deniedWrite.status, 401, "The working Pull only key must not grant upload access");
    console.log(await verifyFirstProject(project));
    assert.equal((await run(process.execPath, ["verify.mjs"], { cwd: project, env })).stdout.trim(), await verifyFirstProject(project));
    assert.equal(JSON.parse((await command("push", "--dry-run", "--json")).stdout).changed, 0);

    // These are the exact files a user reviews and commits, with no credentials.
    const saved = new Map();
    for (const file of [...sourceFiles, "vardum.json", ".vardum.lock"])
      saved.set(file, await readFile(join(project, file)));
    for (const bytes of saved.values()) assert.ok(!bytes.includes(loginKey), "Credential found in project input");
    const snapshot = saved.get(".vardum.lock");
    const originalLogoVersion = JSON.parse(snapshot).items;
    const logoSnapshot = Object.values(originalLogoVersion).find((item) => item.path === "public/logo.svg");
    const changedLogo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="orange"/></svg>\n');
    const changedVersion = await upload(assets.get("sample/logo.svg"), changedLogo, "logo.svg");
    assert.notEqual(changedVersion, logoSnapshot.versionId);
    await createAsset("sample/brand/new.svg", await readFile(join(example, "sample/brand/badge.svg")));
    const changedManifest = await api(manifestPath);
    assert.equal(changedManifest.items.length, 4);
    assert.ok(changedManifest.items.some((item) => item.outputPath === "public/brand/new.svg"));
    assert.equal(changedManifest.items.find((item) => item.outputPath === "public/logo.svg").versionId, changedVersion);

    const ciKey = (await api(`/api/workspaces/${workspaceId}/api-keys`, { name: "first-project-ci", access: "read" })).key;
    const second = join(root, "clean-consumer");
    await mkdir(second);
    for (const [file, bytes] of saved) {
      assert.ok(!bytes.includes(ciKey), "CI credential found in project input");
      await writeFile(join(second, file), bytes);
    }
    await cp(join(example, "sample"), join(second, "sample"), { recursive: true });
    await run("npm", ["ci", ...npmArgs], { cwd: second, env: npmEnv, timeout: 120_000 });
    const ciEnv = { HOME: root, PATH: join(root, "no-browser"), VARDUM_CONFIG_HOME: join(root, "empty-credentials"), VARDUM_API_KEY: ciKey };
    const frozen = () => run(process.execPath, [join(second, "node_modules/.bin/vardum"), "pull", "--frozen", "--json"], {
      cwd: second, env: ciEnv, timeout: 30_000,
    });
    assert.equal(JSON.parse((await frozen()).stdout).changed, 3);
    assert.equal(await verifyFirstProject(second), await verifyFirstProject(project));
    await assert.rejects(stat(join(second, "public/brand/new.svg")), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(second, ".vardum.lock")), snapshot);
    assert.equal(JSON.parse((await frozen()).stdout).changed, 0);
    for (const [file, bytes] of saved) assert.deepEqual(await readFile(join(second, file)), bytes);
    console.log("First-project onboarding passed: public npm CLI 0.6.0, private denial, simulated Pull only login (0600 outside project), 3 exact read-only originals, clean npm ci + read-key frozen restore after version/membership changes, unchanged snapshot and changed: 0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
