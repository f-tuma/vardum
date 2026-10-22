import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { run, verifyPublishedRelease } from "./release-packages.mjs";
import { checkVardFolderOldA } from "./smoke-vard-folder-old-a.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const svg = color => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="${color}"/></svg>`);
const cli080Integrity = "sha512-nry3FLJtuWw/P5jyi9WQGxwebE4/m+tG9LjzJJVZDGN1Phdw15wCR9/uGwQvSEg4xHKoIzr7trLeD8kgrvZkWA==";
const isAuthOrganizationId = value => typeof value === "string" && /^[A-Za-z0-9]{32}$/.test(value);

/** Actual public clients; only the numeric, loopback-owned production smoke. */
export async function checkVardFolderPublicClients({ base, cookie }) {
  const release = process.env.SMOKE_VARD_FOLDER_PUBLIC_RELEASE_DIR;
  const oldImage = process.env.SMOKE_VARD_FOLDER_OLD_A_IMAGE;
  if (!release && !oldImage) return;
  assert.ok(release && oldImage, "Folder acceptance needs the original public batch and exact A image");
  const project = process.env.SMOKE_COMPOSE_PROJECT; assert.match(project ?? "", /^vardum-smoke-\d+$/);
  assert.equal(new URL(base).origin, base); assert.equal(new URL(base).protocol, "http:");
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
  const sharp = require("sharp");
  let phase = "public batch verification", activeWorkspace;
  const apiResponse = (path, body, method = body === undefined ? "GET" : "POST") => fetch(new URL(path, base), {
    method, headers: { cookie, origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const api = async (path, body, method) => {
    const r = await apiResponse(path, body, method); assert.ok(r.ok, `Folder fixture request failed (${r.status})`);
    return r.status === 204 ? null : r.json();
  };
  const hashes = async () => Object.fromEntries(await Promise.all((await readdir(release)).sort().map(async file => [file, digest(await readFile(join(release, file)))])));
  const beforeBatch = await hashes();
  assert.deepEqual(Object.keys(beforeBatch).sort(), ["release.json", "vardum-cli-0.8.3.tgz", "vardum-mcp-0.4.2.tgz", "vardum-shared-0.4.2.tgz"]);
  try {
    await verifyPublishedRelease(release, async ({ root, cli, publicRegistry }) => {
      phase = "folder callback prerequisites";
      assert.equal(publicRegistry, true); assert.equal(cli.version, "0.8.3");
      const capabilities = await api("/api/capabilities");
      assert.equal(capabilities.vardDefinitionSchema, 2); assert.equal(capabilities.vardFolderUses, 1);
      // Read only this owned Compose database; never inspect global worker queues.
      const docker = async (...args) => {
        try { return await run("docker", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }); }
        catch { throw new Error("Folder snapshot Docker check failed; command/environment omitted"); }
      };
      const postgresId = (await docker("ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=postgres", "--format", "{{.ID}}")).stdout.trim();
      assert.match(postgresId, /^[a-f0-9]{12,64}$/);
      const postgres = JSON.parse((await docker("inspect", postgresId)).stdout)[0];
      assert.equal(postgres.Config.Labels["com.docker.compose.project"], project); assert.equal(postgres.Config.Labels["com.docker.compose.service"], "postgres");
      const sql = async query => (await docker("exec", postgresId, "psql", "-X", "-U", "varda", "-d", "varda", "-At", "-v", "ON_ERROR_STOP=1", "-c", query)).stdout.trim();
      const organization = await api("/api/auth/organization/create", { name: "Owned folder acceptance", slug: `folder-${randomUUID()}` });
      assert.ok(isAuthOrganizationId(organization.id), "Expected a Better Auth organization ID");
      const literalState = async ws => JSON.parse(await sql(`SELECT jsonb_build_object(
        'vards',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM vard v WHERE workspace_id='${ws}'),
        'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM vard_item i WHERE workspace_id='${ws}'),
        'uses',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM asset_use u WHERE workspace_id='${ws}'),
        'assets',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM asset a WHERE workspace_id='${ws}'),
        'versions',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM asset_version v WHERE workspace_id='${ws}'),
        'folders',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY prefix),'[]') FROM asset_folder f WHERE workspace_id='${ws}'),
        'settings',(SELECT to_jsonb(s) FROM workspace_settings s WHERE workspace_id='${ws}'),
        'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM audit_event a WHERE workspace_id='${ws}'),
        'workspace',(SELECT to_jsonb(w)-'upload_cleanup_at' FROM workspace w WHERE id='${ws}'),
        'organization',(SELECT to_jsonb(o) FROM organization o WHERE id='${organization.id}'),
        'members',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM member m WHERE organization_id='${organization.id}'),
        'ingestQueue',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]') FROM pgboss.job j WHERE data->>'workspaceId'='${ws}')
      )`));
      const waitQueue = async ws => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (await sql(`SELECT count(*) FROM pgboss.job WHERE data->>'workspaceId'='${ws}' AND state IN ('created','active','retry')`) === "0") return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.fail("Folder fixture ingest queue did not settle");
      };
      const upload = async (workspaceId, asset, bytes) => {
        const path = `/api/workspaces/${workspaceId}/assets/${asset.id}/versions`;
        const version = await api(path, { filename: "source.svg", mimeType: "image/svg+xml", size: bytes.length });
        const form = new FormData();
        for (const [name, value] of Object.entries(version.upload.fields)) form.append(name, value);
        form.append("file", new Blob([bytes], { type: "image/svg+xml" }), "source.svg");
        assert.ok((await fetch(version.upload.url, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) })).ok);
        await api(`${path}/${version.id}/finalize`, {});
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const current = await api(`/api/workspaces/${workspaceId}/assets/${asset.id}`); assert.notEqual(current.status, "failed");
          if (current.status === "ready" && current.currentVersionId === version.id) return version.id;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.fail("Folder fixture upload did not become ready");
      };
      const checkClient = async (installed, integrity) => {
        phase = `${installed.version} folder fixture`;
        const workspace = await api(`/api/organizations/${organization.id}/workspaces`, { name: `Folder ${installed.version}`, slug: `folder-${randomUUID()}` });
        activeWorkspace = workspace; assert.match(workspace.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
        const path = `/api/workspaces/${workspace.id}`;
        const writeKey = (await api(`${path}/api-keys`, { name: "folder-client", access: "write" })).key;
        const makeSource = key => api(`${path}/assets`, { key, displayName: key });
        const source = await makeSource("source/canonical.svg"), writable = await makeSource("source/writable.svg"), original = await makeSource("uses/plain.svg");
        const initialVersion = await upload(workspace.id, source, svg("blue"));
        const writableVersion = await upload(workspace.id, writable, svg("red"));
        await upload(workspace.id, original, svg("blue"));
        const recipe = { w: 40, h: 32, fit: "contain", format: "png", bg: "#ffffff", pad: 25, render: "v2" };
        const originalUse = await api(`${path}/asset-uses`, { sourceAssetId: source.id, key: "uses/canonical.svg", displayName: "Original folder use", transformation: null });
        let transformedUse = await api(`${path}/asset-uses`, { sourceAssetId: source.id, key: "uses/card", displayName: "Transformed folder use", transformation: recipe });
        const vard = await api(`${path}/vards`, { name: `Public folder ${installed.version}` });
        const vardPath = `${path}/vards/${vard.id}`, editorPath = `${vardPath}/editor`;
        const editor = () => api(`${editorPath}?definitionSchema=2`), manifest = () => api(`${vardPath}/manifest`);
        const initial = await editor();
        const manual = await api(`${editorPath}/items`, { definitionSchema: 2, expectedRevision: initial.revision,
          items: [{ id: null, outputPath: "outputs/writable.svg", binding: { kind: "source", assetId: writable.id, versionId: null, transformation: null, writable: true } }] }, "PUT");
        const saved = await api(editorPath, { definitionSchema: 2, expectedRevision: manual.revision,
          folderRules: [{ sourcePrefix: "uses/", outputPrefix: "outputs/", includeUses: true }] }, "PATCH");
        assert.equal(saved.storedDefinitionSchema, 3);
        const capturedManifest = await manifest(); assert.equal(capturedManifest.items.length, 4);
        const originalOutput = capturedManifest.items.find(item => item.outputPath === "outputs/canonical.svg");
        const transformedOutput = capturedManifest.items.find(item => item.outputPath === "outputs/card.png");
        assert.ok(originalOutput.id.startsWith("folder:use:")); assert.ok(transformedOutput.id.startsWith("folder:use:"));
        assert.ok(capturedManifest.items.some(item => item.assetId === original.id && item.id.startsWith("folder:") && !item.id.startsWith("folder:use:")));
        for (const item of [originalOutput, transformedOutput]) {
          assert.equal(item.assetId, source.id); assert.equal(item.key, source.key); assert.equal(item.versionId, initialVersion); assert.equal(item.writable, false);
          assert.equal(item.sourceChecksum, digest(svg("blue"))); assert.ok(item.downloadUrl.includes(initialVersion)); assert.ok(item.fingerprint);
        }
        const project = join(root, `folder-project-${installed.version}`), clientRoot = join(root, `folder-client-${installed.version}`), config = join(clientRoot, "config");
        await mkdir(project); await mkdir(join(config, "vardum"), { recursive: true });
        await writeFile(join(config, "vardum/version-check.json"), JSON.stringify({ latest: installed.version, at: Date.now() }));
        await writeFile(join(project, "vardum.json"), JSON.stringify({ schema: 1, server: base, workspace: workspace.id, vard: vard.id }));
        const command = async (...args) => {
          try {
            const result = await run(process.execPath, [installed.binary, ...args, "--json"], { cwd: project, timeout: 40_000,
              env: { PATH: process.env.PATH, VARDUM_CONFIG_HOME: config, VARDUM_API_KEY: writeKey } });
            return { code: 0, data: JSON.parse(result.stdout) };
          } catch (error) {
            let data = {}; try { data = JSON.parse(error.stderr); } catch { /* No raw subprocess diagnostics. */ }
            return { code: typeof error.code === "number" ? error.code : -1, data };
          }
        };
        phase = `${installed.version} capture and mapped push`;
        const pulled = await command("pull"); assert.equal(pulled.code, 0); assert.equal(pulled.data.changed, 4);
        const lockPath = join(project, ".vardum.lock"), lock = await readFile(lockPath, "utf8"), parsed = JSON.parse(lock);
        assert.equal(parsed.schema, 2);
        const files = new Map();
        for (const item of capturedManifest.items) {
          const entry = parsed.items[item.id]; assert.ok(entry); assert.equal(entry.versionId, item.versionId); assert.equal(entry.fingerprint, item.fingerprint); assert.equal(entry.downloadUrl, new URL(item.downloadUrl, base).href);
          const bytes = await readFile(join(project, entry.path)); assert.equal(entry.checksum, digest(bytes)); files.set(entry.path, bytes);
        }
        const decoded = await sharp(files.get("outputs/card.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(decoded.info.width, 40); assert.equal(decoded.info.height, 32);
        assert.deepEqual([...decoded.data.subarray(0, 4)], [255, 255, 255, 255]);
        const state = async () => ({ editor: await editor(), manifest: await manifest(), literal: await literalState(workspace.id) });
        await waitQueue(workspace.id); const before = await state();
        await writeFile(join(project, originalOutput.outputPath), svg("green")); await writeFile(join(project, transformedOutput.outputPath), Buffer.from("local-only"));
        for (const flags of [[], ["--force"]]) {
          const pushed = await command("push", ...flags); assert.equal(pushed.code, 0); assert.equal(pushed.data.changed, 0); assert.deepEqual(pushed.data.actions, []);
          assert.equal(await readFile(lockPath, "utf8"), lock); assert.deepEqual(await state(), before);
        }
        for (const [file, bytes] of files) await writeFile(join(project, file), bytes);
        phase = `${installed.version} generated Original import before keep`;
        await mkdir(join(project, "input")); await writeFile(join(project, "input/canonical.svg"), svg("blue"));
        const namesBefore = (await readdir(project)).sort();
        const imported = await command("push-folder", "input", "source/", "--output", "outputs/");
        assert.notEqual(imported.code, 0); assert.match(imported.data.error ?? "", /read.only|linked|use|mapping/i);
        assert.deepEqual(await state(), before); assert.equal(await readFile(lockPath, "utf8"), lock); assert.deepEqual((await readdir(project)).sort(), namesBefore);
        phase = `${installed.version} writable positive and live generated changes`;
        await writeFile(join(project, "outputs/writable.svg"), svg("purple"));
        const pushed = await command("push"); assert.equal(pushed.code, 0); assert.equal(pushed.data.changed, 1);
        assert.notEqual((await api(`${path}/assets/${writable.id}/versions`)).currentVersionId, writableVersion);
        transformedUse = await api(`${path}/asset-uses/${transformedUse.id}`, { expectedRevision: transformedUse.revision, displayName: "Transformed folder use", transformation: { ...recipe, w: 64, h: 48, pad: 12.5 } }, "PATCH");
        const nextVersion = await upload(workspace.id, source, svg("green")); assert.notEqual(nextVersion, initialVersion);
        let live = await manifest(); let card = live.items.find(item => item.outputPath === "outputs/card.png");
        assert.equal(card.id, transformedOutput.id); assert.equal(card.versionId, nextVersion); assert.equal((await editor()).revision, saved.revision);
        const liveBytes = Buffer.from(await (await fetch(new URL(card.downloadUrl, base), { headers: { cookie } })).arrayBuffer());
        const liveDecoded = await sharp(liveBytes).raw().toBuffer({ resolveWithObject: true }); assert.equal(liveDecoded.info.width, 64); assert.equal(liveDecoded.info.height, 48); assert.notEqual(digest(liveBytes), digest(files.get("outputs/card.png")));
        transformedUse = await api(`${path}/asset-uses/${transformedUse.id}`, { expectedRevision: transformedUse.revision, displayName: "Transformed folder use", transformation: { ...recipe, format: "webp" } }, "PATCH");
        live = await manifest(); card = live.items.find(item => item.outputPath === "outputs/card.webp");
        assert.ok(card); assert.notEqual(card.id, transformedOutput.id); assert.equal((await editor()).revision, saved.revision);
        const extra = await api(`${path}/asset-uses`, { sourceAssetId: source.id, key: "uses/extra.svg", displayName: "Folder-only extra", transformation: null });
        assert.equal((await manifest()).items.length, 5);
        await api(`${path}/asset-uses/${extra.id}?expectedRevision=${extra.revision}`, undefined, "DELETE");
        await api(`${path}/asset-uses/${originalUse.id}?expectedRevision=${originalUse.revision}`, undefined, "DELETE");
        assert.equal((await manifest()).items.length, 3); assert.equal((await editor()).revision, saved.revision);
        await api(`${editorPath}?definitionSchema=2&expectedRevision=${encodeURIComponent(saved.revision)}`, undefined, "DELETE");
        assert.equal((await apiResponse(`${vardPath}/manifest`)).status, 404);
        phase = `${installed.version} frozen restoration and tamper`;
        await writeFile(lockPath, lock); await rm(join(project, "outputs"), { recursive: true });
        const frozen = await command("pull", "--frozen"); assert.equal(frozen.code, 0); assert.equal(frozen.data.changed, 4);
        assert.equal(await readFile(lockPath, "utf8"), lock);
        for (const [file, bytes] of files) assert.deepEqual(await readFile(join(project, file)), bytes);
        const bad = structuredClone(parsed), entry = bad.items[originalOutput.id]; entry.checksum = "0".repeat(64);
        const badLock = JSON.stringify(bad, null, 2) + "\n"; await writeFile(lockPath, badLock); await rm(join(project, entry.path));
        const denied = await command("pull", "--frozen"); assert.notEqual(denied.code, 0); assert.match(denied.data.error ?? "", /checksum|integrity/i);
        assert.equal(await readFile(lockPath, "utf8"), badLock); await assert.rejects(readFile(join(project, entry.path)), { code: "ENOENT" });
        for (const [file, bytes] of files) if (file !== entry.path) assert.deepEqual(await readFile(join(project, file)), bytes);
        await writeFile(lockPath, lock);
        const repaired = await command("pull", "--frozen"); assert.equal(repaired.code, 0); assert.equal(repaired.data.changed, 1);
        const shared = JSON.parse(await readFile(join(installed.cwd, "node_modules/@vardum/shared/package.json")));
        console.log(JSON.stringify({ check: "actual-public-folder-client", cli: installed.version, shared: shared.version, integrity,
          ordinaryCapture: true, generatedOriginalAndTransformedReadOnly: true, matchingCanonicalImportRefused: true, directWritablePositive: true,
          refusalDomainAuditScopedIngestUnchanged: true, workspaceComparisonOmitsOnlyUploadCleanupAt: true,
          liveRecipeSourceFormatMembership: true, frozenAfterVardDeletion: true, frozenTamperRefused: true, frozenLockUnchanged: true,
          frozenFiles: Object.fromEntries([...files].map(([file, bytes]) => [file, digest(bytes)])) }));
        await api(path, { confirmation: workspace.slug }, "DELETE"); activeWorkspace = undefined;
      };
      phase = "actual public0.8.0 installation";
      const metadataResponse = await fetch("https://registry.npmjs.org/@vardum%2fcli/0.8.0", { signal: AbortSignal.timeout(15_000) });
      assert.ok(metadataResponse.ok); const metadata = await metadataResponse.json(); assert.equal(metadata.version, "0.8.0"); assert.equal(metadata.dist.integrity, cli080Integrity);
      const old = join(root, "public080"), npmRoot = join(root, "public080-client"); await mkdir(old); await mkdir(npmRoot);
      await writeFile(join(old, "package.json"), '{"private":true,"type":"module"}\n');
      const npmrc = join(old, ".npmrc"); await writeFile(npmrc, "registry=https://registry.npmjs.org/\n@vardum:registry=https://registry.npmjs.org/\n");
      await run("npm", ["install", "--userconfig", npmrc, "--cache", join(npmRoot, "cache"), "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "@vardum/cli@0.8.0"],
        { cwd: old, env: { PATH: process.env.PATH }, timeout: 120_000 });
      const oldPackage = JSON.parse(await readFile(join(old, "node_modules/@vardum/cli/package.json"))); assert.equal(oldPackage.version, "0.8.0");
      const oldCli = { cwd: old, binary: join(old, "node_modules/.bin/vardum"), version: oldPackage.version };
      assert.equal((await run(process.execPath, [oldCli.binary, "version"], { cwd: old })).stdout.trim(), "0.8.0");
      await checkClient(oldCli, cli080Integrity);
      const batch = JSON.parse(await readFile(join(release, "release.json")));
      await checkClient(cli, batch.packages.find(item => item.name === "@vardum/cli").integrity);
      phase = "actual old A API";
      await checkVardFolderOldA({ base, cookie, organizationId: organization.id, oldImage });
    });
    assert.deepEqual(await hashes(), beforeBatch);
    console.log(JSON.stringify({ check: "folder-public-batch", original112FilesUnchanged: true, passed: true }));
  } catch {
    console.log(JSON.stringify({ check: "actual-public-folder-client", passed: false, phase }));
    throw new Error(`Folder public acceptance failed during ${phase}`);
  } finally {
    if (activeWorkspace) await api(`/api/workspaces/${activeWorkspace.id}`, { confirmation: activeWorkspace.slug }, "DELETE");
    assert.deepEqual(await hashes(), beforeBatch, "Original published112 batch must remain immutable even after a failure");
  }
}
