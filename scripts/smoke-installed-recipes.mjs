import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { publicCompatibilityClients, run } from "./release-packages.mjs";

const expectedTools = [
  "list_assets", "create_asset", "upload_asset_version", "set_asset_visibility",
  "delete_asset", "list_vards", "create_vard", "get_vard", "update_vard",
  "delete_vard", "replace_vard_items",
].sort();
const savedItems = definition => definition.items.map(item => ({
  id: item.id, assetId: item.assetId, versionId: item.pinnedVersionId,
  outputPath: item.outputPath, writable: item.writable, transformation: item.transformation,
}));
const editable = definition => ({
  revision: definition.revision, name: definition.name, isPublic: definition.isPublic,
  folderRules: definition.folderRules, items: savedItems(definition),
});

// Unlike the historical compatibility smoke, publicRegistry selects only the
// installation transport here. Both transports must prove this new contract.
export async function checkInstalledRecipes(installed, {
  base, cookie, workspaceId, otherWorkspaceId,
}) {
  let phase = "disposable server prerequisites";
  const clients = [];
  try {
    const { root, cli, mcp, publicRegistry } = installed;
    assert.equal(typeof publicRegistry, "boolean");
    assert.match(process.env.SMOKE_COMPOSE_PROJECT ?? "", /^vardum-smoke-\d+$/);
    const origin = new URL(base);
    assert.equal(origin.protocol, "http:");
    assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname));
    assert.equal(origin.origin, base);
    assert.match(workspaceId, /^[a-f0-9-]{36}$/i);
    assert.match(otherWorkspaceId, /^[a-f0-9-]{36}$/i);
    assert.notEqual(workspaceId, otherWorkspaceId);
    assert.ok(cookie);
    const inside = (parent, child) => {
      const path = relative(parent, child);
      return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    };
    async function api(path, body, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(new URL(path, base), {
        method, headers: { cookie, origin: base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      // A key-creation response can contain credentials. Never include bodies.
      assert.ok(response.ok, `Recipe API ${method} failed (${response.status})`);
      return response.status === 204 ? null : response.json();
    }
    const capabilities = await api("/api/capabilities");
    assert.equal(capabilities.vardEditRevision, 1, "New recipes require guarded editor support");

    phase = "public installed TypeScript declarations";
    const controls = createRequire(new URL("../package.json", import.meta.url));
    const compiler = controls.resolve("typescript/bin/tsc");
    const consumerSource = `import type { Transformation, VardEditorItemInput } from "@vardum/shared";
const legacy: Transformation = { w: 256, h: 256, fit: "contain", format: "png", bg: "#f4f0e8" };
const vectorRaster: Transformation = { ...legacy, pad: 12.5, render: "v2" };
const selected: Transformation = { format: "svg", layer: "neutral-arm" };
const adaptive: Transformation = { format: "svg", darkLayer: "neutral-arm", darkColor: "#e8e4d9" };
const mapping: VardEditorItemInput = { id: null, assetId: "source", versionId: null, outputPath: "logo.png", writable: false, transformation: vectorRaster };
// @ts-expect-error Public render must remain a literal, not string or any.
const invalid: Transformation = { render: "future-renderer" };
void [legacy, vectorRaster, selected, adaptive, mapping, invalid];
`;
    for (const consumer of [cli, mcp]) {
      const shared = join(consumer.cwd, "node_modules/@vardum/shared");
      assert.ok(!(await lstat(shared)).isSymbolicLink());
      assert.ok(inside(await realpath(consumer.cwd), await realpath(shared)));
      assert.ok(inside(await realpath(root), await realpath(consumer.binary)));
      const source = join(consumer.cwd, "installed-recipe-types.mts");
      await writeFile(source, consumerSource);
      await run(process.execPath, [compiler, "--noEmit", "--strict", "--skipLibCheck",
        "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", source], {
        cwd: consumer.cwd, env: { HOME: root, PATH: process.env.PATH }, timeout: 30_000,
      });
    }

    phase = "installed MCP tools and help";
    const key = async access => (await api(`/api/workspaces/${workspaceId}/api-keys`, {
      name: `recipe-${access}`, access,
    })).key;
    const writeKey = await key("write");
    const readKey = await key("read");
    const require = createRequire(join(mcp.cwd, "node_modules/@vardum/mcp/package.json"));
    const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
    const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
    async function connect(apiKey) {
      const client = new Client({ name: "installed-recipe-smoke", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [mcp.binary], cwd: mcp.cwd,
        env: { VARDUM_SERVER: base, VARDUM_API_KEY: apiKey }, stderr: "pipe",
      }));
      assert.equal(client.getServerVersion().version, mcp.version);
      return client;
    }
    const writer = await connect(writeKey);
    const reader = await connect(readKey);
    const tools = (await writer.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
    const replace = tools.find(tool => tool.name === "replace_vard_items");
    assert.ok(replace.inputSchema.required.includes("expectedRevision"));
    const help = JSON.stringify(replace.inputSchema.properties.items.items.properties.transformation);
    for (const field of ["bg", "pad", "layer", "darkLayer", "darkColor", "render"])
      assert.match(help, new RegExp(`\\b${field}\\b`));
    assert.match(help, /render to v2/);
    assert.match(help, /Omit render on existing recipes to preserve their renderer identity/);
    assert.match(help, /0–45 percent inset/);
    async function tool(name, args, client = writer) {
      const response = await client.callTool({ name, arguments: { workspaceId, ...args } });
      assert.notEqual(response.isError, true, `Installed recipe MCP ${name} failed`);
      const text = response.content[0].text;
      try { return JSON.parse(text); } catch { return text; }
    }

    phase = "passive SVG upload through installed MCP";
    const suffix = randomUUID();
    const prefix = `installed-recipes-${suffix}/`;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64" viewBox="0 0 128 64"><g id="neutral-arm"><rect width="64" height="64" fill="#102030"/></g><g id="accent-arm"><rect x="64" width="64" height="64" fill="#c8553d"/></g></svg>');
    const asset = await tool("create_asset", { key: `${prefix}logo.svg`, displayName: "Installed recipe source" });
    assert.equal(asset.isPublic, false);
    const upload = await tool("upload_asset_version", {
      assetId: asset.id, filename: "logo.svg", mimeType: "image/svg+xml", base64: svg.toString("base64"),
    });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await api(`/api/workspaces/${workspaceId}/assets/${asset.id}`);
      assert.notEqual(current.status, "failed", "Recipe SVG ingest failed");
      if (current.status === "ready" && current.currentVersionId === upload.versionId) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, "Recipe upload did not become the ready current version");

    phase = "guarded recipe save and literal pin preservation";
    const folderRules = [{ sourcePrefix: `${prefix}unused/`, outputPrefix: "recipe-output/folder/" }];
    const vard = await tool("create_vard", { name: `Installed recipes ${suffix}`, folderRules });
    const initial = await tool("get_vard", { vardId: vard.id }, reader);
    assert.match(initial.revision, /^v1:[a-f0-9]{64}$/);
    const pinInput = {
      id: null, assetId: asset.id, versionId: upload.versionId,
      outputPath: "recipe-output/pinned.svg", writable: false, transformation: null,
    };
    const seeded = await tool("replace_vard_items", {
      vardId: vard.id, expectedRevision: initial.revision, items: [pinInput],
    });
    const pin = seeded.items[0];
    assert.equal(pin.pinnedVersionId, upload.versionId);
    // Request lossless palette quality so exact color assertions do not measure
    // the legacy q80 palette quantizer instead of the recipe parameters.
    const raster = { w: 256, h: 256, fit: "contain", format: "png", q: 100, bg: "#f4f0e8" };
    const recipes = [
      ["legacy.png", raster],
      ["safe-area.png", { ...raster, pad: 12.5, render: "v2" }],
      ["layer.svg", { format: "svg", layer: "neutral-arm" }],
      ["adaptive.svg", { format: "svg", darkLayer: "neutral-arm", darkColor: "#e8e4d9" }],
    ];
    const definition = await tool("replace_vard_items", {
      vardId: vard.id, expectedRevision: seeded.revision,
      items: [...savedItems(seeded), ...recipes.map(([name, transformation]) => ({
        id: null, assetId: asset.id, versionId: null, outputPath: `recipe-output/${name}`,
        writable: false, transformation,
      }))],
    });
    assert.equal(definition.items.length, 5);
    assert.deepEqual(definition.folderRules, folderRules);
    assert.deepEqual(definition.items.find(item => item.id === pin.id), pin);
    for (const [name, recipe] of recipes) {
      const item = definition.items.find(item => item.outputPath === `recipe-output/${name}`);
      assert.ok(item);
      assert.equal(item.pinnedVersionId, null);
      assert.equal(item.writable, false);
      assert.deepEqual(item.transformation, recipe);
    }
    const unchanged = await tool("replace_vard_items", {
      vardId: vard.id, expectedRevision: definition.revision, items: savedItems(definition),
    });
    assert.deepEqual(editable(unchanged), editable(definition));
    const resolved = await tool("get_vard", { vardId: vard.id, resolved: true }, reader);
    assert.equal(resolved.items.length, 5);
    const legacy = resolved.items.find(item => item.outputPath === "recipe-output/legacy.png");
    const safe = resolved.items.find(item => item.outputPath === "recipe-output/safe-area.png");
    assert.equal(legacy.transformation.render, undefined);
    assert.equal(new URL(legacy.downloadUrl, base).searchParams.has("render"), false);
    assert.equal(new URL(safe.downloadUrl, base).searchParams.get("render"), "v2");
    assert.notEqual(legacy.fingerprint, safe.fingerprint);

    phase = "HTTP PNG safe area and SVG selection/adaptive output";
    const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
    async function decoded(bytes) {
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { ...info, at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] };
    }
    phase = "HTTP recipe downloads";
    const bytesByPath = new Map();
    for (const item of resolved.items) {
      assert.ok(item.downloadUrl);
      const url = new URL(item.downloadUrl, base);
      assert.equal(url.origin, base, "Private recipe downloads must stay on the disposable origin");
      const response = await fetch(url, {
        headers: { "x-api-key": readKey }, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200, "Recipe HTTP output failed");
      assert.equal(response.headers.get("content-type")?.split(";", 1)[0], item.mimeType);
      bytesByPath.set(item.outputPath, Buffer.from(await response.arrayBuffer()));
    }
    phase = "HTTP PNG dimensions background and safe area";
    const background = [244, 240, 232, 255], neutral = [16, 32, 48, 255], accent = [200, 85, 61, 255];
    const legacyPng = await decoded(bytesByPath.get("recipe-output/legacy.png"));
    const safePng = await decoded(bytesByPath.get("recipe-output/safe-area.png"));
    for (const image of [legacyPng, safePng]) {
      assert.equal(image.width, 256); assert.equal(image.height, 256);
      assert.deepEqual(image.at(0, 0), background);
      assert.deepEqual(image.at(64, 128), neutral);
      assert.deepEqual(image.at(192, 128), accent);
    }
    assert.deepEqual(legacyPng.at(20, 128), neutral);
    assert.deepEqual(safePng.at(20, 128), background, "12.5 percent safe area must change artwork placement");
    assert.deepEqual(safePng.at(128, 70), background);
    assert.deepEqual(safePng.at(128, 90), accent);
    phase = "HTTP SVG layer canvas and selected group";
    const layer = bytesByPath.get("recipe-output/layer.svg");
    assert.match(layer.toString(), /^<svg[^>]*width="128" height="64" viewBox="0 0 128 64"/);
    assert.match(layer.toString(), /id="neutral-arm"/);
    assert.doesNotMatch(layer.toString(), /id="accent-arm"/);
    const selected = await decoded(layer);
    assert.equal(selected.width, 128); assert.equal(selected.height, 64);
    assert.deepEqual(selected.at(20, 32), neutral);
    assert.deepEqual(selected.at(100, 32), [0, 0, 0, 0]);
    phase = "HTTP SVG adaptive media and light colors";
    const adaptive = bytesByPath.get("recipe-output/adaptive.svg");
    assert.match(adaptive.toString(), /@media \(prefers-color-scheme: dark\)\{\.vard-adaptive-fill\{fill:#e8e4d9!important\}\}/);
    assert.match(adaptive.toString(), /fill="#102030"[^>]*class="vard-adaptive-fill"/);
    assert.doesNotMatch(adaptive.toString(), /fill="#c8553d"[^>]*class=/);
    const light = await decoded(adaptive);
    assert.equal(light.width, 128); assert.equal(light.height, 64);
    assert.deepEqual(light.at(20, 32), neutral);
    assert.deepEqual(light.at(100, 32), accent);

    phase = "stale revision, read-only and invalid-recipe guards";
    const stale = await writer.callTool({ name: "replace_vard_items", arguments: {
      workspaceId, vardId: vard.id, expectedRevision: seeded.revision, items: savedItems(unchanged),
    } });
    assert.equal(stale.isError, true);
    const conflict = JSON.parse(stale.content[0].text);
    assert.deepEqual(stale.structuredContent, conflict);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.code, "vard_revision_conflict");
    assert.equal(conflict.currentRevision, unchanged.revision);
    const denied = await reader.callTool({ name: "replace_vard_items", arguments: {
      workspaceId, vardId: vard.id, expectedRevision: unchanged.revision, items: savedItems(unchanged),
    } });
    assert.equal(denied.isError, true);
    const wrongWorkspace = await writer.callTool({ name: "get_vard", arguments: {
      workspaceId: otherWorkspaceId, vardId: vard.id,
    } });
    assert.equal(wrongWorkspace.isError, true);
    for (const transformation of [{ w: 256, format: "png", render: "v2" }, { format: "svg", q: 80 }]) {
      const invalid = await writer.callTool({ name: "replace_vard_items", arguments: {
        workspaceId, vardId: vard.id, expectedRevision: unchanged.revision,
        items: [{ ...savedItems(unchanged)[1], transformation }],
      } });
      assert.equal(invalid.isError, true);
    }
    assert.deepEqual(editable(await tool("get_vard", { vardId: vard.id }, reader)), editable(unchanged));

    phase = "installed CLI normal pull and schema-2 frozen restoration";
    const project = join(root, `recipe-project-${suffix}`);
    const configHome = join(root, `recipe-config-${suffix}`);
    await mkdir(project);
    await mkdir(join(configHome, "vardum"), { recursive: true });
    await writeFile(join(configHome, "vardum/version-check.json"), JSON.stringify({ latest: cli.version, at: Date.now() }));
    const env = { HOME: root, PATH: join(root, "no-browser"), VARDUM_CONFIG_HOME: configHome, VARDUM_API_KEY: readKey };
    const command = async (...args) => JSON.parse((await run(process.execPath, [cli.binary, ...args, "--json"], {
      cwd: project, env, timeout: 30_000,
    })).stdout);
    await command("init", "--server", base, "--workspace", workspaceId, "--vard", vard.id);
    assert.equal((await command("pull")).changed, 5);
    const lockPath = join(project, ".vardum.lock");
    const lock = await readFile(lockPath);
    const snapshot = JSON.parse(lock.toString());
    assert.equal(snapshot.schema, 2);
    assert.equal(Object.keys(snapshot.items).length, 5);
    assert.ok(!lock.includes(readKey) && !lock.includes(writeKey));
    for (const [path, bytes] of bytesByPath) assert.deepEqual(await readFile(join(project, path)), bytes);
    const legacySnapshot = Object.values(snapshot.items).find(item => item.path === "recipe-output/legacy.png");
    assert.ok(legacySnapshot);
    assert.equal(legacySnapshot.fingerprint, legacy.fingerprint);
    assert.equal(new URL(legacySnapshot.downloadUrl, base).searchParams.has("render"), false);
    const changed = await tool("replace_vard_items", {
      vardId: vard.id, expectedRevision: unchanged.revision,
      items: [{ ...savedItems(unchanged).find(item => item.id === pin.id), outputPath: "recipe-output/live-only.svg" }],
    });
    assert.notEqual(changed.revision, unchanged.revision);
    assert.equal(changed.items.length, 1);
    await rm(join(project, "recipe-output"), { recursive: true });
    assert.equal((await command("pull", "--frozen")).changed, 5);
    assert.deepEqual(await readFile(lockPath), lock);
    for (const [path, bytes] of bytesByPath) assert.deepEqual(await readFile(join(project, path)), bytes);
    assert.equal((await command("status", "--frozen")).changed, 0);
    phase = "historical public CLI and new CLI sharing one schema-2 lock";
    const oldVersion = publicCompatibilityClients["@vardum/cli"];
    const oldProject = join(root, `recipe-compatibility-${suffix}`);
    const oldHome = join(root, `recipe-compatibility-home-${suffix}`);
    const oldConfig = join(oldHome, "config");
    await mkdir(oldProject);
    await mkdir(join(oldConfig, "vardum"), { recursive: true });
    await writeFile(join(oldProject, "package.json"), '{"private":true,"type":"module"}\n');
    const npmConfig = join(oldProject, ".npmrc");
    await writeFile(npmConfig, "registry=https://registry.npmjs.org/\n@vardum:registry=https://registry.npmjs.org/\n");
    await run("npm", ["install", "--userconfig", npmConfig, "--cache", join(oldHome, "npm-cache"),
      "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", `@vardum/cli@${oldVersion}`], {
      cwd: oldProject, env: { HOME: oldHome, XDG_CONFIG_HOME: oldConfig, PATH: process.env.PATH }, timeout: 120_000,
    });
    const oldManifest = JSON.parse(await readFile(join(oldProject, "node_modules/@vardum/cli/package.json"), "utf8"));
    assert.equal(oldManifest.version, oldVersion);
    const oldBinary = join(oldProject, "node_modules/.bin/vardum");
    await access(oldBinary, constants.X_OK);
    assert.ok(inside(await realpath(oldProject), await realpath(oldBinary)));
    const compatibilityEnv = {
      HOME: oldHome, PATH: join(oldHome, "no-browser"), VARDUM_CONFIG_HOME: oldConfig, VARDUM_API_KEY: readKey,
    };
    const versionResult = await run(process.execPath, [oldBinary, "version"], {
      cwd: oldProject, env: compatibilityEnv, timeout: 15_000,
    });
    assert.equal(versionResult.stdout.trim(), oldVersion);
    await writeFile(join(oldProject, "vardum.json"), await readFile(join(project, "vardum.json")));
    const oldLockPath = join(oldProject, ".vardum.lock");
    await writeFile(oldLockPath, lock);
    const compatibilityCommand = async (binary, ...args) => JSON.parse((await run(process.execPath,
      [binary, ...args, "--json"], { cwd: oldProject, env: compatibilityEnv, timeout: 30_000 })).stdout);
    const verifyCompatibilityFiles = async () => {
      assert.deepEqual(await readFile(oldLockPath), lock);
      for (const [path, bytes] of bytesByPath) assert.deepEqual(await readFile(join(oldProject, path)), bytes);
    };
    await writeFile(join(oldConfig, "vardum/version-check.json"), JSON.stringify({ latest: oldVersion, at: Date.now() }));
    assert.equal((await compatibilityCommand(oldBinary, "pull", "--frozen")).changed, 5);
    await verifyCompatibilityFiles();
    await rm(join(oldProject, "recipe-output"), { recursive: true });
    await writeFile(join(oldConfig, "vardum/version-check.json"), JSON.stringify({ latest: cli.version, at: Date.now() }));
    assert.equal((await compatibilityCommand(cli.binary, "pull", "--frozen")).changed, 5);
    await verifyCompatibilityFiles();
    assert.equal((await compatibilityCommand(cli.binary, "status", "--frozen")).changed, 0);

    const legacyAgain = await fetch(new URL(legacy.downloadUrl, base), {
      headers: { "x-api-key": readKey }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    assert.equal(legacyAgain.status, 200);
    assert.deepEqual(Buffer.from(await legacyAgain.arrayBuffer()), bytesByPath.get("recipe-output/legacy.png"));
    assert.deepEqual(editable(await tool("get_vard", { vardId: vard.id }, reader)), editable(changed));

    phase = "disposable recipe fixture cleanup";
    await tool("delete_vard", { vardId: vard.id, expectedRevision: changed.revision });
    await tool("delete_asset", { assetId: asset.id });

    const result = {
      registry: publicRegistry ? "public" : "candidate",
      clients: { cli: cli.version, mcp: mcp.version, compatibilityCli: oldVersion },
      checks: { publicTypes: "passed", mcpHelp: "passed", guardedRecipes: "passed", httpOutputs: "passed", guards: "passed", legacyAndFrozen: "passed", crossVersionFrozen: "passed" },
    };
    console.log(`Installed recipe verification: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    const location = typeof error?.stack === "string" ? error.stack.match(/smoke-installed-recipes\.mjs:\d+:\d+/)?.[0] : null;
    if (location) console.error(`Installed recipe assertion location: ${location}`);
    // Assertions/exec errors can carry full objects, lock URLs, or environments.
    // Only this bounded phase is safe for durable CI logs.
    throw new Error(`Installed recipe verification failed during ${phase}`);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
  }
}
