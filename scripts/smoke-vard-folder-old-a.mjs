import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./release-packages.mjs";

const oldAImage = "sha256:54019288d3b2a2ca320523aae4ace3d22a4e8032a330fbf2753b5b2023a44617";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const isAuthOrganizationId = value => typeof value === "string" && /^[A-Za-z0-9]{32}$/.test(value);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const svg = color => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="${color}"/></svg>`);

/** Exact A HTTP binary, with only its real pool observed by a signal wrapper. */
export async function checkVardFolderOldA({ base, cookie, organizationId, oldImage }) {
  assert.equal(oldImage, oldAImage); assert.ok(isAuthOrganizationId(organizationId), "Expected a Better Auth organization ID");
  const project = process.env.SMOKE_COMPOSE_PROJECT; assert.match(project ?? "", /^vardum-smoke-\d+$/);
  const origin = new URL(base); assert.equal(origin.origin, base); assert.equal(origin.protocol, "http:");
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname));
  const token = randomUUID(), name = `${project}-old-a-${token.slice(0, 8)}`, label = "dev.vardum.smoke.old-a";
  const root = await mkdtemp(join(tmpdir(), "vardum-old-a-"));
  const proofPath = `/tmp/vardum-old-a-${token}.json`;
  let phase = "owned prerequisites", workspace, cascadeWorkspace;
  const docker = async (...args) => {
    try { return await run("docker", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }); }
    catch { throw new Error("Old A Docker check failed; command/environment omitted"); }
  };
  const inspect = async id => JSON.parse((await docker("inspect", id)).stdout)[0];
  const containerFor = async service => {
    const id = (await docker("ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.ID}}")).stdout.trim();
    assert.match(id, /^[a-f0-9]{12,64}$/); return id;
  };
  const response = (server, path, body, method = body === undefined ? "GET" : "POST", principal = { cookie }) => fetch(new URL(path, server), {
    method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }), ...principal },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const api = async (server, path, body, method) => {
    const r = await response(server, path, body, method); assert.ok(r.ok, `Old A fixture request failed (${r.status})`);
    return r.status === 204 ? null : r.json();
  };
  const upload = async (server, ws, asset, bytes) => {
    const path = `/api/workspaces/${ws}/assets/${asset.id}/versions`;
    const version = await api(server, path, { filename: "source.svg", mimeType: "image/svg+xml", size: bytes.length });
    const form = new FormData(); for (const [key, value] of Object.entries(version.upload.fields)) form.append(key, value);
    form.append("file", new Blob([bytes], { type: "image/svg+xml" }), "source.svg");
    assert.ok((await fetch(version.upload.url, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) })).ok);
    await api(server, `${path}/${version.id}/finalize`, {});
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      // Only the current B worker is running; an old A worker is never started.
      const current = await api(base, `/api/workspaces/${ws}/assets/${asset.id}`); assert.notEqual(current.status, "failed");
      if (current.status === "ready" && current.currentVersionId === version.id) return version.id;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail("Old A upload did not finish under current B worker");
  };
  try {
    const currentId = await containerFor("api"), postgresId = await containerFor("postgres"), workerId = await containerFor("worker");
    const current = await inspect(currentId), worker = await inspect(workerId), networks = Object.keys(current.NetworkSettings.Networks);
    assert.equal(networks.length, 1); assert.equal(current.Config.Labels["com.docker.compose.project"], project);
    assert.equal(worker.Config.Labels["com.docker.compose.project"], project); assert.equal(worker.Image, current.Image);
    assert.equal(JSON.parse((await docker("network", "inspect", networks[0])).stdout)[0].Labels["com.docker.compose.project"], project);
    const image = JSON.parse((await docker("image", "inspect", oldImage)).stdout)[0]; assert.equal(image.Id, oldAImage);
    assert.deepEqual(image.Config.Cmd, ["node", "dist/server.js"]); assert.ok(!image.Config.Entrypoint?.length); assert.equal(image.Config.User, "65532:65532");
    const env = Object.fromEntries(current.Config.Env.map(value => { assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*=[^\r\n]*$/); const i = value.indexOf("="); return [value.slice(0, i), value.slice(i + 1)]; }));
    const database = new URL(env.DATABASE_URL); assert.equal(database.hostname, "postgres"); assert.equal(database.username, "varda_app"); assert.equal(database.pathname, "/varda");
    assert.equal(env.WEB_URL, base); assert.equal(env.BETTER_AUTH_URL, base); assert.equal(env.NODE_ENV, "production"); assert.equal(new URL(env.S3_ENDPOINT).hostname, "rustfs");
    await writeFile(join(root, "runtime.env"), current.Config.Env.join("\n") + "\n", { mode: 0o600 });
    const sql = async query => (await docker("exec", postgresId, "psql", "-X", "-U", "varda", "-d", "varda", "-At", "-v", "ON_ERROR_STOP=1", "-c", query)).stdout.trim();
    assert.equal(await sql(`SELECT public.vard_folder_rules_fit_definition('[{"includeUses":true}]'::jsonb,2::smallint)=false AND public.vard_folder_rules_fit_definition('[{"includeUses":true}]'::jsonb,3::smallint)=true`), "t");
    workspace = await api(base, `/api/organizations/${organizationId}/workspaces`, { name: "Actual A compatibility", slug: `old-a-${token}` });
    cascadeWorkspace = await api(base, `/api/organizations/${organizationId}/workspaces`, { name: "Actual A cascade", slug: `old-a-cascade-${token}` });
    for (const id of [workspace.id, cascadeWorkspace.id]) assert.match(id, uuid);
    const path = `/api/workspaces/${workspace.id}`, makeSource = async (key, isPublic = false, ws = workspace.id) => {
      const asset = await api(base, `/api/workspaces/${ws}/assets`, { key, displayName: key });
      const versionId = await upload(base, ws, asset, svg("blue"));
      if (isPublic) await api(base, `/api/workspaces/${ws}/assets/${asset.id}/visibility`, { isPublic: true }, "PATCH");
      return { ...asset, versionId };
    };
    const source = await makeSource("source/private.svg"), cascadeSource = await makeSource("source/cascade.svg", false, cascadeWorkspace.id), publicSource = await makeSource("source/public.svg", true);
    let folderUse = await api(base, `${path}/asset-uses`, { sourceAssetId: source.id, key: "folder/only.svg", displayName: "Folder-only Original", transformation: null });
    const directUse = await api(base, `${path}/asset-uses`, { sourceAssetId: source.id, key: "direct/card.png", displayName: "Direct A binding", transformation: { w: 40, format: "png" } });
    const hiddenDirectUse = await api(base, `${path}/asset-uses`, { sourceAssetId: source.id, key: "direct/hidden.png", displayName: "B-only direct binding", transformation: { w: 40, format: "png" } });
    await api(base, `${path}/asset-uses`, { sourceAssetId: publicSource.id, key: "public/card.png", displayName: "Public B binding", transformation: { w: 40, format: "png" } });
    const makeVard = async (ws, name, bindings, prefix, isPublic = false) => {
      const vard = await api(base, `/api/workspaces/${ws}/vards`, { name, isPublic });
      const editorPath = `/api/workspaces/${ws}/vards/${vard.id}/editor`;
      let editor = await api(base, `${editorPath}?definitionSchema=2`);
      if (bindings.length) editor = await api(base, `${editorPath}/items`, { definitionSchema: 2, expectedRevision: editor.revision, items: bindings.map(binding => ({ id: null, outputPath: binding.kind === "use" ? "manual/card.png" : "manual/source.svg", binding })) }, "PUT");
      if (prefix) editor = await api(base, editorPath, { definitionSchema: 2, expectedRevision: editor.revision, folderRules: [{ sourcePrefix: prefix, outputPrefix: "generated/", includeUses: true }] }, "PATCH");
      return { ...vard, editorPath, editor };
    };
    const sourceBinding = assetId => ({ kind: "source", assetId, versionId: null, transformation: null, writable: false });
    const sourceControl = await makeVard(workspace.id, "A source-only", [sourceBinding(source.id)]);
    const directControl = await makeVard(workspace.id, "A direct-use", [{ kind: "use", assetUseId: directUse.id }]);
    const extended = await makeVard(workspace.id, "B private folder", [sourceBinding(source.id), { kind: "use", assetUseId: hiddenDirectUse.id }], "folder/");
    const publicVard = await makeVard(workspace.id, "B public folder", [], "public/", true);
    const cascadeVard = await makeVard(cascadeWorkspace.id, "B cascade", [sourceBinding(cascadeSource.id)], "empty/");
    assert.equal(sourceControl.editor.storedDefinitionSchema, 1); assert.equal(directControl.editor.storedDefinitionSchema, 2);
    for (const v of [extended, publicVard, cascadeVard]) assert.equal(v.editor.storedDefinitionSchema, 3);
    const publicPositive = await response(base, `/v/${publicVard.id}`, undefined, "GET", {}); assert.equal(publicPositive.status, 200);
    assert.ok((await publicPositive.json()).items.some(item => item.assetId === publicSource.id && item.downloadUrl));
    const download = async item => { const r = await fetch(new URL(item.downloadUrl, base), { headers: { cookie }, signal: AbortSignal.timeout(15_000) }); assert.equal(r.status, 200); return Buffer.from(await r.arrayBuffer()); };
    const initialFolderOutput = (await api(base, `${path}/vards/${extended.id}/manifest`)).items.find(item => item.id.startsWith("folder:use:"));
    assert.ok(initialFolderOutput); const initialFolderBytes = await download(initialFolderOutput); assert.deepEqual(initialFolderBytes, svg("blue"));
    const writeKey = (await api(base, `${path}/api-keys`, { name: "old-A-control", access: "write" })).key;
    const wrapper = `
      import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
      import {pool} from './dist/db/index.js';import {inWorkspace} from './dist/db/tenant.js';import {sql} from 'drizzle-orm';
      const ws=${JSON.stringify(workspace.id)},ids=${JSON.stringify([sourceControl.id, directControl.id, extended.id])};
      const baseline=async(destroy=false)=>{const clients=await Promise.all(Array.from({length:3},()=>pool.connect()));try{
        const rows=await Promise.all(clients.map(async c=>(await c.query("SELECT pg_backend_pid() AS pid,current_user AS role,current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '2' AND current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '3' AS safe")).rows[0]));
        assert.equal(new Set(rows.map(x=>x.pid)).size,3);assert.ok(rows.every(x=>x.safe&&x.role==='varda_app'));return rows.map(x=>x.pid).sort();
      }finally{for(const c of clients)c.release(destroy);}};
      process.on('SIGUSR2',()=>void(async()=>{try{const pids=await baseline();
        await inWorkspace(ws,async tx=>{const row=(await tx.execute(sql\`SELECT current_setting('vardum.vard_definition_schema',true) AS capability,current_setting('app.workspace_id',true) AS tenant\`)).rows[0];assert.deepEqual(row,{capability:'2',tenant:ws});
          const rows=(await tx.execute(sql\`SELECT id,definition_schema AS marker FROM vard WHERE id IN (\${ids[0]},\${ids[1]},\${ids[2]}) ORDER BY definition_schema\`)).rows;assert.deepEqual(rows.map(x=>x.marker),[1,2]);
          assert.equal((await tx.execute(sql\`SELECT count(*)::int AS n FROM vard_item WHERE vard_id=\${ids[2]}\`)).rows[0].n,0);});
        assert.deepEqual(await baseline(),pids);const sentinel=new Error('expected');try{await inWorkspace(ws,async()=>{throw sentinel;});assert.fail('rollback expected');}catch(e){assert.equal(e,sentinel);}
        assert.deepEqual(await baseline(),pids);await baseline(true);assert.ok((await baseline()).every(pid=>!pids.includes(pid)));
        await writeFile(${JSON.stringify(proofPath)},JSON.stringify({oldAHttpPoolBaseline1:true,oldAHttpLocalCapability2:true,oldAHttpParentChild3Hidden:true,oldAHttpCommitRollbackBaseline1:true,oldAHttpConcurrentClients:3,oldAHttpReconnectBaseline1:true}),{mode:0o600});
      }catch{await writeFile(${JSON.stringify(proofPath)},JSON.stringify({oldAHttpPoolBaseline1:false}),{mode:0o600});}})());
      await import('./dist/server.js');`;
    phase = "actual A API-only startup";
    const port = process.env.SMOKE_VARD_FOLDER_OLD_A_PORT ?? "18113"; assert.match(port, /^\d{2,5}$/); assert.ok(Number(port) > 1023 && Number(port) < 65536);
    await docker("run", "--detach", "--pull", "never", "--name", name, "--label", `${label}=${token}`, "--network", networks[0], "--env-file", join(root, "runtime.env"),
      "--publish", `127.0.0.1:${port}:3000`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", oldImage, "node", "--input-type=module", "-e", wrapper);
    const old = await inspect(name); assert.equal(old.Image, oldAImage); assert.equal(old.Config.Labels[label], token);
    assert.deepEqual(Object.keys(old.NetworkSettings.Networks), networks); assert.equal(old.NetworkSettings.Ports["3000/tcp"][0].HostIp, "127.0.0.1");
    const oldBase = `http://127.0.0.1:${port}`, deadline = Date.now() + 60_000;
    let healthy = false; while (Date.now() < deadline) { try { healthy = (await fetch(`${oldBase}/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { /* bounded startup */ } if (healthy) break; await new Promise(resolve => setTimeout(resolve, 250)); } assert.equal(healthy, true);
    const capabilities = await api(oldBase, "/api/capabilities"); assert.equal(capabilities.vardDefinitionSchema, 2); assert.equal(capabilities.vardFolderUses, undefined);
    phase = "A stored1 and stored2 positive controls";
    const oldV1 = await api(oldBase, `${path}/vards/${sourceControl.id}/editor`); assert.match(oldV1.revision, /^v1:[a-f0-9]{64}$/);
    await api(oldBase, `${path}/vards/${sourceControl.id}`, { name: "A source control updated" }, "PATCH");
    let oldV2 = await api(oldBase, `${directControl.editorPath}?definitionSchema=2`); assert.equal(oldV2.storedDefinitionSchema, 2);
    await api(oldBase, directControl.editorPath, { definitionSchema: 2, expectedRevision: oldV2.revision, name: "A direct control updated" }, "PATCH");
    assert.equal((await api(oldBase, `${path}/vards/${directControl.id}/manifest`)).items.length, 1);
    assert.equal((await response(oldBase, `${path}/vards/${sourceControl.id}/manifest`, undefined, "GET", { "x-api-key": writeKey })).status, 200);
    const positiveList = await api(oldBase, `${path}/vards`); assert.ok(positiveList.vards.some(v => v.id === sourceControl.id)); assert.ok(positiveList.vards.some(v => v.id === directControl.id));
    assert.ok(!positiveList.vards.some(v => v.id === extended.id || v.id === publicVard.id));
    const publicOld = await response(oldBase, `/v/${publicVard.id}`, undefined, "GET", {}); assert.equal(publicOld.status, 404);
    const workspaceIds = [workspace.id, cascadeWorkspace.id];
    const waitQueue = async () => { const until = Date.now() + 10_000; while (Date.now() < until) { if (await sql(`SELECT count(*) FROM pgboss.job WHERE data->>'workspaceId' IN ('${workspace.id}','${cascadeWorkspace.id}') AND state IN ('created','active','retry')`) === "0") return; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail("Fixture ingest queue did not settle"); };
    const snapshot = async () => JSON.parse(await sql(`SELECT jsonb_build_object(
      'vards',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM vard v WHERE workspace_id=ANY(ARRAY['${workspaceIds.join("','")}'])),
      'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM vard_item i WHERE workspace_id=ANY(ARRAY['${workspaceIds.join("','")}'])),
      'uses',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM asset_use u WHERE workspace_id=ANY(ARRAY['${workspaceIds.join("','")}'])),
      'assets',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM asset a WHERE workspace_id=ANY(ARRAY['${workspaceIds.join("','")}'])),
      'versions',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM asset_version v WHERE workspace_id=ANY(ARRAY['${workspaceIds.join("','")}'])),
      'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM audit_event a WHERE workspace_id=ANY(ARRAY['${workspaceIds.join("','")}'])),
      'organization',(SELECT to_jsonb(o) FROM organization o WHERE id='${organizationId}'),
      'members',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM member m WHERE organization_id='${organizationId}'),
      'workspaces',(SELECT coalesce(jsonb_agg(to_jsonb(w)-'upload_cleanup_at' ORDER BY id),'[]') FROM workspace w WHERE id=ANY(ARRAY['${workspaceIds.join("','")}'])),
      'queue',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]') FROM pgboss.job j WHERE data->>'workspaceId'=ANY(ARRAY['${workspaceIds.join("','")}']))
    )`));
    await waitQueue(); let before = await snapshot();
    assert.ok(before.vards.filter(v => [extended.id, publicVard.id, cascadeVard.id].includes(v.id)).every(v => v.definition_schema === 3));
    assert.ok(before.items.filter(i => [extended.id, cascadeVard.id].includes(i.vard_id)).every(i => i.definition_schema === 3));
    phase = "old A stored3 refusal with exact state preservation";
    const vardPath = `${path}/vards/${extended.id}`, direct = { assetId: source.id, outputPath: "manual/source.svg", versionId: null, transformation: null, writable: false };
    const importFile = { assetId: source.id, key: source.key, outputPath: "generated/only.svg", checksum: digest(svg("blue")), size: svg("blue").length, mimeType: "image/svg+xml" };
    const refusals = [
      [vardPath, "GET"], [`${vardPath}/manifest`, "GET"], [`${vardPath}/editor`, "GET"], [`${vardPath}/editor?definitionSchema=2`, "GET"],
      [vardPath, "PATCH", { name: "Must not save" }], [`${vardPath}/items`, "PUT", { items: [direct] }], [vardPath, "DELETE"],
      [`${vardPath}/editor`, "PATCH", { expectedRevision: oldV1.revision, name: "Must not save" }],
      [`${vardPath}/editor/items`, "PUT", { expectedRevision: oldV1.revision, items: [{ id: null, ...direct }] }],
      [`${vardPath}/editor?expectedRevision=${encodeURIComponent(oldV1.revision)}`, "DELETE"],
      [`${vardPath}/editor`, "PATCH", { definitionSchema: 2, expectedRevision: extended.editor.revision, name: "Must not save" }],
      [`${vardPath}/editor/items`, "PUT", { definitionSchema: 2, expectedRevision: extended.editor.revision, items: [{ id: null, outputPath: "manual/source.svg", binding: sourceBinding(source.id) }] }],
      [`${vardPath}/editor?definitionSchema=2&expectedRevision=${encodeURIComponent(extended.editor.revision)}`, "DELETE"],
      [`${vardPath}/items/import-plan`, "POST", { files: [importFile] }], [`${vardPath}/items/import`, "POST", { files: [{ ...importFile, versionId: source.versionId }] }],
    ];
    const statuses = [];
    for (const [url, method, body] of refusals) { const r = await response(oldBase, url, body, method); assert.equal(r.status, 404, "A must hide stored3 before a valid old writer mutates it"); statuses.push(r.status); assert.deepEqual(await snapshot(), before); }
    const guardedCascade = async (description, url, body) => {
      phase = description;
      let invariant = "fresh-log-cursor", correlated = false;
      const diagnostic = { httpStatus: null, matchingRequestRows: 0, incomingRequestRows: 0, distinctRequestIds: 0, guardErrorRows: 0 };
      try {
        const cursor = await docker("logs", name);
        invariant = "delete-response";
        const r = await response(oldBase, url, body, "DELETE"); diagnostic.httpStatus = r.status;
        invariant = "http-status-500"; assert.equal(r.status, 500);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          invariant = "read-fresh-logs";
          const logs = await docker("logs", name);
          // The unique owned container has no log truncation/rotation. A fresh
          // byte cursor prevents an earlier cascade's guard error satisfying this one.
          invariant = "fresh-log-prefix";
          assert.ok(logs.stdout.startsWith(cursor.stdout)); assert.ok(logs.stderr.startsWith(cursor.stderr));
          const rows = `${logs.stdout.slice(cursor.stdout.length)}\n${logs.stderr.slice(cursor.stderr.length)}`.split("\n").flatMap(line => {
            try { return [JSON.parse(line)]; } catch { return []; }
          });
          const requests = rows.filter(row => row.req?.method === "DELETE" && row.req?.url === url);
          const incoming = requests.filter(row => row.msg === "incoming request");
          diagnostic.matchingRequestRows = requests.length; diagnostic.incomingRequestRows = incoming.length;
          diagnostic.distinctRequestIds = new Set(requests.map(row => row.reqId)).size;
          invariant = "one-exact-incoming-request";
          assert.ok(incoming.length <= 1, "Cascade log window must identify one exact incoming request");
          if (incoming.length) {
            const requestId = incoming[0].reqId;
            invariant = "nonempty-request-id"; assert.equal(typeof requestId, "string"); assert.ok(requestId);
            invariant = "all-matching-rows-share-request-id";
            assert.ok(requests.every(row => row.reqId === requestId), "Every matching request row must belong to this cascade");
            diagnostic.guardErrorRows = rows.filter(row => row.reqId === requestId && /vard_definition_capability_guard|Vard definition requires schema 3 capability/.test(JSON.stringify(row.err ?? {}))).length;
            correlated = diagnostic.guardErrorRows > 0;
            if (correlated) break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        invariant = "one-exact-incoming-request"; assert.equal(diagnostic.incomingRequestRows, 1);
        invariant = "own-request-schema3-guard";
        assert.equal(correlated, true, "This cascade must independently log its own request-correlated schema3 capability guard");
        invariant = "read-state-snapshot"; const after = await snapshot();
        invariant = "exact-state-preservation"; assert.deepEqual(after, before); return r.status;
      } catch {
        console.log(JSON.stringify({ check: "actual-A-cascade-guard", passed: false, phase: description, invariant, ...diagnostic, guardCorrelated: correlated }));
        throw new Error(`Actual A cascade proof failed (${invariant})`);
      }
    };
    const sourceCascadeStatus = await guardedCascade("old A source cascade guard", `/api/workspaces/${cascadeWorkspace.id}/assets/${cascadeSource.id}`);
    const workspaceCascadeStatus = await guardedCascade("old A workspace cascade guard", `/api/workspaces/${cascadeWorkspace.id}`, { confirmation: cascadeWorkspace.slug });
    const directDelete = await response(oldBase, `${path}/asset-uses/${hiddenDirectUse.id}?expectedRevision=${hiddenDirectUse.revision}`, undefined, "DELETE"); assert.equal(directDelete.status, 409); assert.equal((await directDelete.json()).code, "asset_use_in_use"); assert.deepEqual(await snapshot(), before);
    phase = "intended A library edits and upload with current B worker";
    const revision = (await api(base, `${extended.editorPath}?definitionSchema=2`)).revision;
    folderUse = await api(oldBase, `${path}/asset-uses/${folderUse.id}`, { expectedRevision: folderUse.revision, displayName: "Folder-only Original updated", transformation: { w: 48, format: "svg" } }, "PATCH");
    assert.equal((await api(base, `${extended.editorPath}?definitionSchema=2`)).revision, revision);
    const recipeOutput = (await api(base, `${vardPath}/manifest`)).items.find(item => item.id === initialFolderOutput.id);
    assert.ok(recipeOutput); assert.equal(recipeOutput.versionId, source.versionId); assert.notEqual(recipeOutput.fingerprint, initialFolderOutput.fingerprint);
    const recipeBytes = await download(recipeOutput); assert.notEqual(digest(recipeBytes), digest(initialFolderBytes));
    const nextVersion = await upload(oldBase, workspace.id, source, svg("green")); assert.notEqual(nextVersion, source.versionId);
    let live = await api(base, `${vardPath}/manifest`); const uploadedOutput = live.items.find(item => item.id === initialFolderOutput.id);
    assert.ok(uploadedOutput); assert.equal(uploadedOutput.versionId, nextVersion); assert.notEqual(digest(await download(uploadedOutput)), digest(recipeBytes));
    await api(oldBase, `${path}/asset-uses/${folderUse.id}?expectedRevision=${folderUse.revision}`, undefined, "DELETE");
    live = await api(base, `${vardPath}/manifest`); assert.equal(live.items.filter(item => item.id.startsWith("folder:use:")).length, 0);
    assert.equal((await api(base, `${extended.editorPath}?definitionSchema=2`)).revision, revision); assert.equal((await api(base, `${extended.editorPath}?definitionSchema=2`)).storedDefinitionSchema, 3);
    await waitQueue(); before = await snapshot();
    phase = "same serving A HTTP pool observation";
    await docker("kill", "--signal", "SIGUSR2", name);
    let oldProof; const until = Date.now() + 10_000;
    while (Date.now() < until) { try { oldProof = JSON.parse((await docker("exec", name, "node", "--input-type=module", "-e", `import{readFile}from'node:fs/promises';process.stdout.write(await readFile(${JSON.stringify(proofPath)},'utf8'));`)).stdout); } catch { /* signal receipt not published yet */ } if (oldProof) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.deepEqual(oldProof, { oldAHttpPoolBaseline1: true, oldAHttpLocalCapability2: true, oldAHttpParentChild3Hidden: true, oldAHttpCommitRollbackBaseline1: true, oldAHttpConcurrentClients: 3, oldAHttpReconnectBaseline1: true });
    phase = "independent B deployed-helper pool observation";
    const newProof = JSON.parse((await docker("exec", currentId, "node", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';import {pool,closeDatabase} from './dist/db/index.js';import {inWorkspace} from './dist/db/tenant.js';import {sql} from 'drizzle-orm';
      const baseline=async(destroy=false)=>{const clients=await Promise.all(Array.from({length:3},()=>pool.connect()));try{const rows=await Promise.all(clients.map(async c=>(await c.query("SELECT pg_backend_pid() AS pid,current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '2' AND current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '3' AS safe")).rows[0]));assert.equal(new Set(rows.map(x=>x.pid)).size,3);assert.ok(rows.every(x=>x.safe));return rows.map(x=>x.pid).sort();}finally{for(const c of clients)c.release(destroy);}};
      try{const pids=await baseline();await inWorkspace(${JSON.stringify(workspace.id)},async tx=>{assert.equal((await tx.execute(sql\`SELECT current_setting('vardum.vard_definition_schema',true) AS capability\`)).rows[0].capability,'3');});assert.deepEqual(await baseline(),pids);
      const sentinel=new Error('expected');try{await inWorkspace(${JSON.stringify(workspace.id)},async()=>{throw sentinel;});assert.fail('rollback expected');}catch(e){assert.equal(e,sentinel);}assert.deepEqual(await baseline(),pids);await baseline(true);assert.ok((await baseline()).every(pid=>!pids.includes(pid)));
      console.log(JSON.stringify({newBIndependentHelperPoolBaseline1:true,newBIndependentHelperLocalCapability3:true,newBIndependentHelperCommitRollbackBaseline1:true,newBIndependentHelperConcurrentClients:3,newBIndependentHelperReconnectBaseline1:true}));}finally{await closeDatabase();}`)).stdout.trim());
    assert.deepEqual(newProof, { newBIndependentHelperPoolBaseline1: true, newBIndependentHelperLocalCapability3: true, newBIndependentHelperCommitRollbackBaseline1: true, newBIndependentHelperConcurrentClients: 3, newBIndependentHelperReconnectBaseline1: true });
    assert.deepEqual(await snapshot(), before);
    console.log(JSON.stringify({ check: "actual-A-api-folder-boundary", oldApiImage: oldAImage, oldApiOnly: true, source1AndDirect2Positive: true,
      stored3RefusalStatuses: statuses, newAnonymousPublic200: true, oldAnonymousPublic404: true, sourceCascadeStatus, workspaceCascadeStatus, eachCascadeOwnRequestCorrelatedGuard: true,
      literalAuditQueueUnchangedAfterRefusals: true, workspaceComparisonOmitsOnlyUploadCleanupAt: true, directUseRestrict409: true, directUseReferencedOnlyByHidden3: true, oldALibraryRecipeWriteAllowed: true, oldASourceUploadProcessedByCurrentBWorker: true, folderOnlyDeleteAllowed: true,
      newBProbeIsIndependentHelperPool: true, ...oldProof, ...newProof }));
  } catch {
    console.log(JSON.stringify({ check: "actual-A-api-folder-boundary", passed: false, phase }));
    throw new Error(`Actual A API folder acceptance failed during ${phase}`);
  } finally {
    try {
      const owned = await inspect(name).catch(() => null); if (owned) { assert.equal(owned.Config.Labels[label], token); await docker("rm", "--force", name); }
      for (const ws of [workspace, cascadeWorkspace]) if (ws) await api(base, `/api/workspaces/${ws.id}`, { confirmation: ws.slug }, "DELETE");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}
