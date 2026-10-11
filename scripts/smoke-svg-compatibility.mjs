import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicCompatibilityClients, run } from "./release-packages.mjs";
import {
  assertSvgPngVariant,
  sha256,
  svgCompatibilityFixtures,
  svgFixtureDimensions,
  svgVariantDimensions,
} from "./fixtures/svg-compatibility.mjs";

// Only smoke-production's existing disposable local workspace may be mutated.
// Upload through the pinned public CLI, which exercises real S3 and the worker.
export async function checkSvgCompatibilityLifecycle({ base, cookie, workspaceId, workspaceSlug }) {
  assert.match(process.env.SMOKE_COMPOSE_PROJECT ?? "", /^vardum-smoke-\d+$/);
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  const root = await mkdtemp(join(tmpdir(), "vardum-svg-compatibility-"));
  const fixtures = svgCompatibilityFixtures();
  const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
  const clientVersion = publicCompatibilityClients["@vardum/cli"];
  const prefix = "svg-compatibility/";
  async function response(path, options = {}) {
    const result = await fetch(`${base}${path}`, {
      ...options,
      headers: { cookie, origin: base, ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    // No response bodies in errors: API-key creation can contain credentials.
    assert.ok(result.ok, `SVG compatibility ${options.method ?? "GET"} ${new URL(path, base).pathname}: ${result.status}`);
    return result;
  }
  async function api(path, body, method = body === undefined ? "GET" : "POST") {
    const result = await response(path, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return result.json();
  }
  try {
    await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}\n');
    const npmConfig = join(root, "npmrc");
    await writeFile(npmConfig, "registry=https://registry.npmjs.org/\n@vardum:registry=https://registry.npmjs.org/\n");
    await run("npm", ["install", "--userconfig", npmConfig, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `@vardum/cli@${clientVersion}`], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root }, timeout: 120_000,
    });
    const manifest = JSON.parse(await readFile(join(root, "node_modules/@vardum/cli/package.json"), "utf8"));
    assert.equal(manifest.version, clientVersion);
    const key = (await api(`/api/workspaces/${workspaceId}/api-keys`, { name: "svg-compatibility-cli", access: "write" })).key;
    const vard = await api(`/api/workspaces/${workspaceId}/vards`, { name: "SVG compatibility", isPublic: false });
    const configHome = join(root, "credentials");
    await mkdir(join(configHome, "vardum"), { recursive: true });
    await writeFile(join(configHome, "vardum/version-check.json"), JSON.stringify({ latest: clientVersion, at: Date.now() }));
    const env = { HOME: root, PATH: join(root, "no-browser"), VARDUM_CONFIG_HOME: configHome, VARDUM_API_KEY: key };
    const binary = join(root, "node_modules/.bin/vardum");
    async function command(...args) {
      try {
        return await run(process.execPath, [binary, ...args], { cwd: root, env, timeout: 45_000 });
      } catch {
        // Do not rethrow exec errors carrying its environment or CLI output.
        throw new Error(`SVG compatibility public CLI ${args[0]} failed`);
      }
    }
    assert.equal((await command("version")).stdout.trim(), clientVersion);
    // Writable Vard mappings keep asset keys ASCII while the original filename
    // is ordinary non-ASCII metadata. Folder upload derives keys from names.
    const seed = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="blue"/></svg>');
    const items = [];
    for (const fixture of fixtures) {
      const asset = await api(`/api/workspaces/${workspaceId}/assets`, { key: `${prefix}${fixture.name}`, displayName: fixture.name });
      const path = `/api/workspaces/${workspaceId}/assets/${asset.id}`;
      const version = await api(`${path}/versions`, { filename: "seed.svg", mimeType: "image/svg+xml", size: seed.length });
      const form = new FormData();
      for (const [name, value] of Object.entries(version.upload.fields)) form.append(name, value);
      form.append("file", new Blob([seed], { type: "image/svg+xml" }), "seed.svg");
      const stored = await fetch(version.upload.url, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
      assert.ok(stored.ok, `SVG compatibility seed storage upload: ${stored.status}`);
      await api(`${path}/versions/${version.id}/finalize`, undefined, "POST");
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const current = await api(path);
        assert.notEqual(current.status, "failed", "SVG compatibility seed ingest failed");
        if (current.status === "ready" && current.currentVersionId === version.id) { ready = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(ready, "SVG compatibility seed ingest timed out");
      items.push({ assetId: asset.id, outputPath: `fixtures/${fixture.filename}`, writable: true, transformation: null });
    }
    await api(`/api/workspaces/${workspaceId}/vards/${vard.id}/items`, { items }, "PUT");
    await command("init", "--server", base, "--workspace", workspaceId, "--vard", vard.id, "--json");
    assert.equal(JSON.parse((await command("pull", "--json")).stdout).changed, fixtures.length);
    const source = join(root, "fixtures");
    for (const fixture of fixtures) await writeFile(join(source, fixture.filename), fixture.bytes);
    assert.equal(JSON.parse((await command("push", "--json")).stdout).changed, fixtures.length);

    let assets;
    for (let attempt = 0; attempt < 80; attempt++) {
      const page = await api(`/api/workspaces/${workspaceId}/sync/assets?prefix=${encodeURIComponent(prefix)}`);
      assets = page.assets;
      if (assets.length === fixtures.length && fixtures.every((fixture) => assets.some((asset) => asset.checksum === sha256(fixture.bytes)))) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(assets?.length, fixtures.length, "SVG compatibility worker readiness");
    const reports = [];
    for (const fixture of fixtures) {
      const digest = sha256(fixture.bytes);
      const asset = assets.find((candidate) => candidate.checksum === digest);
      assert.ok(asset, `${fixture.name}: worker checksum`);
      assert.equal(asset.mimeType, "image/svg+xml", `${fixture.name}: worker MIME type`);
      assert.deepEqual([asset.width, asset.height], [svgFixtureDimensions.width, svgFixtureDimensions.height], `${fixture.name}: worker dimensions`);
      assert.equal(asset.size, fixture.bytes.length, `${fixture.name}: worker input size`);
      const assetPath = `/api/workspaces/${workspaceId}/assets/${asset.id}`;
      const history = await api(`${assetPath}/versions`);
      const version = history.versions.find((candidate) => candidate.id === asset.versionId);
      assert.ok(version, `${fixture.name}: exact ready version`);
      assert.equal(version.status, "ready", `${fixture.name}: worker ready status`);
      assert.equal(version.filename, fixture.filename, `${fixture.name}: non-ASCII filename remains metadata`);
      assert.equal(version.checksum, digest, `${fixture.name}: version checksum`);
      const originalPath = `/w/${workspaceSlug}/__v/${asset.versionId}/${asset.key}`;
      async function exactOriginal() {
        const delivered = await response(originalPath);
        assert.ok(delivered.headers.get("content-type")?.startsWith("image/svg+xml"));
        const bytes = Buffer.from(await delivered.arrayBuffer());
        assert.equal(sha256(bytes), digest, `${fixture.name}: original delivery SHA-256`);
        assert.deepEqual(bytes, fixture.bytes, `${fixture.name}: exact delivered original bytes`);
      }
      await exactOriginal();
      const signed = await api(`${assetPath}/transform-url`, { w: svgVariantDimensions.width, format: "png" });
      const url = new URL(signed.url, base);
      assert.equal(url.origin, new URL(base).origin);
      const transformedPath = `${url.pathname}${url.search}`;
      const delivered = await response(transformedPath);
      assert.ok(delivered.headers.get("content-type")?.startsWith("image/png"));
      const png = Buffer.from(await delivered.arrayBuffer());
      // The API produced these PNG bytes; host decoding checks their exact
      // pixels. smoke-production separately probes actual image-native codecs.
      const variant = await assertSvgPngVariant(sharp, png, fixture, `lifecycle ${fixture.name}`);
      const cached = Buffer.from(await (await response(transformedPath)).arrayBuffer());
      assert.deepEqual(cached, png, `${fixture.name}: cached PNG bytes`);
      await exactOriginal();
      assert.equal(sha256(await readFile(join(source, fixture.filename))), digest, `${fixture.name}: local input unchanged`);
      const after = await api(`${assetPath}/versions`);
      assert.equal(after.currentVersionId, asset.versionId, `${fixture.name}: original version unchanged by transform`);
      assert.equal(after.versions.find((candidate) => candidate.id === asset.versionId)?.checksum, digest);
      reports.push({ name: fixture.name, filename: fixture.filename, inputSha256: digest, originalBytesUnchanged: true, workerChecksumVerified: true, ...variant });
    }
    assert.equal(JSON.parse((await command("push", "--json")).stdout).changed, 0, "SVG public CLI unchanged repeat upload");
    console.log(`SVG compatibility lifecycle: ${JSON.stringify({ publicCliVersion: clientVersion, uploadWorkflow: "writable-vard-push", fixtures: reports })}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
