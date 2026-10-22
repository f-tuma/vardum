import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run, verifyPublishedRelease } from "./release-packages.mjs";
import { checkVardUseOldApi } from "./smoke-vard-use-old-api.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

/** Real public clients against only smoke-production's disposable API/RustFS. */
export async function checkVardUsePublicClients({ base, cookie, workspaceId, otherWorkspaceId }) {
  const releaseDir = process.env.SMOKE_VARD_USE_PUBLIC_RELEASE_DIR;
  const oldImage = process.env.SMOKE_VARD_USE_OLD_API_IMAGE;
  if (!releaseDir && !oldImage) return;
  assert.ok(releaseDir && oldImage, "Public-use acceptance requires both the original release and exact old API image");
  assert.match(process.env.SMOKE_COMPOSE_PROJECT ?? "", /^vardum-smoke-\d+$/);
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  let phase = "public registry verification";
  try {
    await verifyPublishedRelease(releaseDir, async ({ root, cli, mcp, publicRegistry }) => {
      assert.equal(publicRegistry, true);
      assert.equal(cli.version, "0.8.3");
      assert.equal(mcp.version, "0.4.2");
      const apiResponse = (path, body, method = body === undefined ? "GET" : "POST", headers = { cookie }) =>
        fetch(new URL(path, base), { method, headers: { origin: base, "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
      const api = async (path, body, method) => {
        const response = await apiResponse(path, body, method);
        assert.ok(response.ok, `Live-use API request failed (${response.status})`);
        return response.status === 204 ? null : response.json();
      };
      assert.equal((await api("/api/capabilities")).vardDefinitionSchema, 2);
      const key = async access => (await api(`/api/workspaces/${workspaceId}/api-keys`, { name: `live-use-${access}`, access })).key;
      const writeKey = await key("write"), readKey = await key("read");
      const require = createRequire(join(mcp.cwd, "node_modules/@vardum/mcp/package.json"));
      const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
      const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
      const client = new Client({ name: "public-live-use-acceptance", version: "1.0.0" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcp.binary], cwd: mcp.cwd,
        env: { VARDUM_SERVER: base, VARDUM_API_KEY: writeKey }, stderr: "pipe" }));
      try {
        assert.equal(client.getServerVersion().version, "0.4.2");
        const call = (name, args) => client.callTool({ name, arguments: { workspaceId, ...args } });
        const tool = async (name, args) => {
          const result = await call(name, args);
          assert.notEqual(result.isError, true, `Public MCP ${name} failed`);
          try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
        };
        const prefix = `live-use-public-${randomUUID()}`;
        const svg = color => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="${color}"/></svg>`);
        phase = "public MCP fixture upload";
        const source = await tool("create_asset", { key: `${prefix}/source.svg`, displayName: "Public live-use source" });
        const cascadeSource = await tool("create_asset", { key: `${prefix}/cascade.svg`, displayName: "Old API cascade control" });
        const upload = async (asset, bytes, mimeType = "image/svg+xml") => {
          const result = await tool("upload_asset_version", { assetId: asset.id, filename: mimeType === "image/png" ? "source.png" : "source.svg",
            mimeType, base64: bytes.toString("base64") });
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const current = await api(`/api/workspaces/${workspaceId}/assets/${asset.id}`);
            assert.notEqual(current.status, "failed", "Public MCP upload failed ingest");
            if (current.status === "ready" && current.currentVersionId === result.versionId) return result.versionId;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          assert.fail("Public MCP upload did not become ready");
        };
        const originalVersion = await upload(source, svg("blue"));
        await upload(cascadeSource, svg("blue"));
        const recipe = { w: 40, h: 32, fit: "contain", format: "png", bg: "#ffffff", pad: 25, render: "v2" };
        const makeUse = suffix => api(`/api/workspaces/${workspaceId}/asset-uses`, {
          key: `${prefix}/${suffix}.png`, sourceAssetId: source.id, displayName: suffix, transformation: recipe,
        });
        const firstUse = await makeUse("first"), sameRecipeUse = await makeUse("same-recipe");
        const vard = await tool("create_vard", { name: "Public live-use Vard" });
        const oldDefinition = await tool("get_vard", { vardId: vard.id });
        const editorPath = `/api/workspaces/${workspaceId}/vards/${vard.id}/editor`;
        const editor = () => api(`${editorPath}?definitionSchema=2`);
        const put = (revision, items) => api(`${editorPath}/items`, { definitionSchema: 2, expectedRevision: revision, items }, "PUT");
        const initial = await editor();
        const saved = await put(initial.revision, [
          { id: null, outputPath: "images/linked.png", binding: { kind: "use", assetUseId: firstUse.id } },
          { id: null, outputPath: "images/direct.svg", binding: { kind: "source", assetId: cascadeSource.id, versionId: null, transformation: null, writable: false } },
        ]);
        assert.equal(saved.storedDefinitionSchema, 2);
        const linkedItem = saved.items.find(item => item.outputPath === "images/linked.png");
        const manifestPath = `/api/workspaces/${workspaceId}/vards/${vard.id}/manifest`;
        const manifest = () => api(manifestPath);
        const capturedManifest = await manifest();
        const capturedItem = capturedManifest.items.find(item => item.id === linkedItem.id);
        assert.equal(capturedItem.versionId, originalVersion);
        assert.equal(capturedItem.assetId, source.id);
        assert.equal(capturedItem.writable, false);
        assert.match(capturedItem.downloadUrl, new RegExp(`/__v/${originalVersion}/`));
        assert.ok(!capturedItem.downloadUrl.includes(firstUse.id));
        phase = "public MCP guarded editor refusal";
        assert.deepEqual(await tool("get_vard", { vardId: vard.id, resolved: true }), capturedManifest);
        for (const [name, args] of [
          ["get_vard", { vardId: vard.id }],
          ["update_vard", { vardId: vard.id, expectedRevision: oldDefinition.revision, name: "Must not save" }],
          ["replace_vard_items", { vardId: vard.id, expectedRevision: oldDefinition.revision, items: [] }],
          ["delete_vard", { vardId: vard.id, expectedRevision: oldDefinition.revision }],
        ]) {
          const result = await call(name, args);
          assert.equal(result.isError, true, `Public MCP ${name} must refuse a format2 edit`);
          assert.match(JSON.stringify(result.content), /schema.?2|definition|upgrade/i);
          assert.deepEqual(await editor(), saved);
          assert.deepEqual(await manifest(), capturedManifest);
        }
        phase = "independent old API binary";
        // Public discovery needs its own published source; keep the main
        // source private for the subsequent authentication/scope assertions.
        const publicSource = await tool("create_asset", { key: `${prefix}/public-control.svg`, displayName: "Disposable public rollout control" });
        await upload(publicSource, svg("blue"));
        await tool("set_asset_visibility", { assetId: publicSource.id, isPublic: true });
        const publicUse = await api(`/api/workspaces/${workspaceId}/asset-uses`, {
          key: `${prefix}/public-control.png`, sourceAssetId: publicSource.id,
          displayName: "Disposable public rollout use", transformation: recipe,
        });
        await checkVardUseOldApi({ base, cookie, workspaceId, vardId: vard.id, useId: firstUse.id,
          sourceId: source.id, cascadeSourceId: cascadeSource.id, publicSourceId: publicSource.id, publicUseId: publicUse.id,
          writeKey, oldImage, oldRevision: oldDefinition.revision });

        phase = "public CLI linked snapshot";
        const project = join(root, "live-use-project"), home = join(root, "live-use-home");
        await mkdir(project); await mkdir(join(home, "vardum"), { recursive: true });
        await writeFile(join(home, "vardum/version-check.json"), JSON.stringify({ latest: cli.version, at: Date.now() }));
        await writeFile(join(project, "vardum.json"), JSON.stringify({ schema: 1, server: base, workspace: workspaceId, vard: vard.id }));
        const command = async (...args) => JSON.parse((await run(process.execPath, [cli.binary, ...args, "--json"], {
          cwd: project, timeout: 30_000, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, VARDUM_API_KEY: readKey },
        })).stdout);
        assert.equal((await command("pull")).changed, 2);
        const lockPath = join(project, ".vardum.lock"), lock = await readFile(lockPath, "utf8");
        const frozen = JSON.parse(lock), capturedBytes = await readFile(join(project, "images/linked.png"));
        const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
        const decoded = async bytes => {
          const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          return { ...info, at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] };
        };
        const originalPng = await decoded(capturedBytes);
        assert.equal(originalPng.width, 40); assert.equal(originalPng.height, 32);
        assert.deepEqual(originalPng.at(7, 16), [255, 255, 255, 255]);
        assert.deepEqual(originalPng.at(8, 16), [0, 0, 255, 255]);
        assert.equal(frozen.schema, 2);
        assert.equal(frozen.items[linkedItem.id].checksum, digest(capturedBytes));
        assert.equal(frozen.items[linkedItem.id].versionId, originalVersion);
        assert.equal(frozen.items[linkedItem.id].fingerprint, capturedItem.fingerprint);

        phase = "known usage binding identity and private scope";
        const destinationId = randomUUID(), bindingId = randomUUID();
        let consumer = await api(`/api/workspaces/${workspaceId}/known-usages`, {
          name: "Live-use manual evidence", kind: "first_party",
          destinations: [{ id: destinationId, label: "Disposable acceptance", url: "https://example.invalid/acceptance" }],
          bindings: [{ id: bindingId, destinationId, mode: "manual_frozen",
            target: { kind: "vard_output", vardId: vard.id, outputPath: linkedItem.outputPath, assetId: source.id } }],
        });
        const usagePath = `/api/workspaces/${workspaceId}/known-usages/${consumer.id}`;
        consumer = await api(`${usagePath}/bindings/${bindingId}/checks`, {
          expectedRevision: consumer.revision, expectedScopeToken: consumer.bindings[0].current.scopeToken,
          checkedAt: new Date().toISOString(), reportedVersionId: originalVersion, note: "Disposable manual fixture only",
        });
        assert.equal(consumer.bindings[0].status, "recorded_match");
        const evidence = consumer.bindings[0].latestEvidence;
        const beforeScope = consumer.bindings[0].current.scopeToken;
        assert.equal(JSON.parse(evidence.scope.outputConfiguration)[1], firstUse.id);
        const rebound = await put(saved.revision, saved.items.map(({ id, outputPath, binding }) => ({
          id, outputPath, binding: id === linkedItem.id ? { kind: "use", assetUseId: sameRecipeUse.id } : binding,
        })));
        const reboundManifest = await manifest();
        const sameOutput = reboundManifest.items.find(item => item.id === linkedItem.id);
        assert.deepEqual(sameOutput, capturedItem, "same recipe/source produces identical captured output while binding identity changes");
        const changedScope = await api(usagePath);
        assert.equal(changedScope.bindings[0].status, "scope_changed");
        assert.notEqual(changedScope.bindings[0].current.scopeToken, beforeScope);
        assert.deepEqual(changedScope.bindings[0].current.source, consumer.bindings[0].current.source);
        assert.deepEqual(changedScope.bindings[0].latestEvidence, evidence);
        const page = await api(`/api/workspaces/${workspaceId}/known-usages`);
        assert.deepEqual(page.consumers.find(item => item.id === consumer.id), changedScope);
        assert.equal((await apiResponse(usagePath, undefined, "GET", {})).status, 401);
        assert.equal((await apiResponse(`/api/workspaces/${otherWorkspaceId}/known-usages`, undefined, "GET", { "x-api-key": readKey })).status, 401);
        assert.equal((await apiResponse(capturedItem.downloadUrl, undefined, "GET", {})).status, 401);
        assert.equal((await apiResponse(usagePath, undefined, "GET", { "x-api-key": readKey })).status, 200);

        phase = "live recipe dimensions and safe area";
        await api(`/api/workspaces/${workspaceId}/asset-uses/${sameRecipeUse.id}`, {
          displayName: "same-recipe", transformation: { ...recipe, w: 64, h: 48, pad: 12.5 }, expectedRevision: sameRecipeUse.revision,
        }, "PATCH");
        const resized = (await manifest()).items.find(item => item.id === linkedItem.id);
        assert.equal(resized.versionId, originalVersion);
        assert.equal(resized.transformation.w, 64); assert.equal(resized.transformation.h, 48);
        assert.equal(resized.transformation.pad, 12.5);
        assert.notEqual(resized.downloadUrl, capturedItem.downloadUrl);
        assert.notEqual(resized.fingerprint, capturedItem.fingerprint);
        assert.equal((await editor()).revision, rebound.revision);
        assert.equal((await command("pull")).changed, 1);
        const recipeBytes = await readFile(join(project, "images/linked.png")), recipePng = await decoded(recipeBytes);
        assert.equal(recipePng.width, 64); assert.equal(recipePng.height, 48);
        assert.deepEqual(recipePng.at(5, 24), [255, 255, 255, 255]);
        assert.deepEqual(recipePng.at(6, 24), [0, 0, 255, 255]);
        assert.notDeepEqual(recipeBytes, capturedBytes);
        phase = "live current source update";
        const nextVersion = await upload(source, svg("green"));
        assert.equal((await editor()).revision, rebound.revision);
        const updated = (await manifest()).items.find(item => item.id === linkedItem.id);
        assert.equal(updated.versionId, nextVersion);
        assert.notEqual(updated.downloadUrl, resized.downloadUrl);
        assert.notEqual(updated.fingerprint, resized.fingerprint);
        assert.equal((await command("pull")).changed, 1);
        const nextBytes = await readFile(join(project, "images/linked.png"));
        assert.notDeepEqual(nextBytes, recipeBytes);
        assert.deepEqual((await decoded(nextBytes)).at(32, 24), [0, 128, 0, 255]);

        phase = "unavailable binding stays unresolved";
        const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "blue" } }).png().toBuffer();
        const pngSource = await decoded(png);
        assert.equal(pngSource.width, 1); assert.equal(pngSource.height, 1);
        await upload(source, png, "image/png");
        const unavailable = (await manifest()).items.find(item => item.id === linkedItem.id);
        assert.equal(unavailable.downloadUrl, null);
        assert.equal(unavailable.versionId, null);
        const unavailableDefinition = await editor();
        assert.ok(unavailableDefinition.items.find(item => item.id === linkedItem.id).resolved.availabilityError);
        const unresolved = await api(usagePath);
        assert.equal(unresolved.bindings[0].status, "unresolved");
        assert.equal(unresolved.bindings[0].current.resolved, false);
        assert.equal(unresolved.bindings[0].current.source, null);
        assert.deepEqual(unresolved.bindings[0].latestEvidence, evidence);
        assert.deepEqual(unavailableDefinition.items.find(item => item.id === linkedItem.id).binding,
          { kind: "use", assetUseId: sameRecipeUse.id });

        phase = "public frozen restoration after Vard deletion";
        await api(`${editorPath}?definitionSchema=2&expectedRevision=${encodeURIComponent(rebound.revision)}`, undefined, "DELETE");
        assert.equal((await apiResponse(manifestPath)).status, 404);
        await writeFile(lockPath, lock);
        await rm(join(project, "images"), { recursive: true });
        assert.equal((await command("pull", "--frozen")).changed, 2);
        assert.equal(await readFile(lockPath, "utf8"), lock);
        assert.deepEqual(await readFile(join(project, "images/linked.png")), capturedBytes);
        assert.equal((await command("status", "--frozen")).changed, 0);
        console.log(JSON.stringify({ check: "public-live-use-clients", publicRegistry: true, cli: cli.version, mcp: mcp.version,
          guardedEditorRefusal: true, liveRecipeAndSource: true, knownUsageRebindScope: true, unavailableUnresolved: true,
          privateScope: true, frozenAfterVardDeletion: true, lockUnchanged: true, frozenOutputSha256: digest(capturedBytes) }));
      } finally { await client.close(); }
    });
  } catch {
    // Never retain client credentials, signed URLs or child-process arguments.
    throw new Error(`Public live-use acceptance failed during ${phase}`);
  }
}
