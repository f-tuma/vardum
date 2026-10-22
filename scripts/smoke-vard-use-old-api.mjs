import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./release-packages.mjs";

// Retained pre-102/public-112 API, independently built from 2cd410486e7a7493.
const pre102Image = "sha256:0e377138f2606e29382a0902137bf632fa1c6eb30d45f5a88e249bcdabe3a9c8";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Execute an unchanged historical API against only the owned disposable DB. */
export async function checkVardUseOldApi({
  base, cookie, workspaceId, vardId, useId, sourceId, cascadeSourceId, publicSourceId, publicUseId,
  writeKey, oldImage, oldRevision,
}) {
  const project = process.env.SMOKE_COMPOSE_PROJECT;
  assert.match(project ?? "", /^vardum-smoke-\d+$/);
  assert.equal(oldImage, pre102Image);
  for (const id of [workspaceId, vardId, useId, sourceId, cascadeSourceId, publicSourceId, publicUseId]) assert.match(id, uuid);
  const origin = new URL(base);
  assert.equal(origin.protocol, "http:");
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname));
  assert.equal(origin.origin, base);
  assert.match(oldRevision, /^v1:[a-f0-9]{64}$/);
  const token = randomUUID();
  const name = `${project}-old-api-${token.slice(0, 8)}`;
  const label = "dev.vardum.smoke.old-api";
  const proofPath = `/tmp/vardum-old-api-${token}.json`;
  const root = await mkdtemp(join(tmpdir(), "vardum-old-api-"));
  let phase = "disposable prerequisites", controlId, publicId;
  const docker = async (...args) => {
    try { return await run("docker", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }); }
    catch { throw new Error("Old API Docker check failed; command and environment omitted"); }
  };
  const containerFor = async service => {
    const id = (await docker("ps", "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.ID}}")).stdout.trim();
    assert.match(id, /^[a-f0-9]{12,64}$/);
    return id;
  };
  const inspect = async id => JSON.parse((await docker("inspect", id)).stdout)[0];
  const apiResponse = (server, path, body, method = body === undefined ? "GET" : "POST") => fetch(new URL(path, server), {
    method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }), "x-api-key": writeKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const api = async (server, path, body, method) => {
    const response = await apiResponse(server, path, body, method);
    assert.ok(response.ok, "Old API control request failed");
    return response.status === 204 ? null : response.json();
  };
  const vardPath = `/api/workspaces/${workspaceId}/vards/${vardId}`;
  try {
    const currentId = await containerFor("api"), postgresId = await containerFor("postgres");
    const current = await inspect(currentId);
    assert.equal(current.Config.Labels["com.docker.compose.project"], project);
    assert.equal(current.Config.Labels["com.docker.compose.service"], "api");
    const networks = Object.keys(current.NetworkSettings.Networks);
    assert.equal(networks.length, 1);
    const network = JSON.parse((await docker("network", "inspect", networks[0])).stdout)[0];
    assert.equal(network.Labels["com.docker.compose.project"], project);
    const image = JSON.parse((await docker("image", "inspect", oldImage)).stdout)[0];
    assert.equal(image.Id, pre102Image);
    assert.deepEqual(image.Config.Cmd, ["node", "dist/server.js"]);
    assert.ok(!image.Config.Entrypoint?.length);
    assert.equal(image.Config.User, "65532:65532");
    const environment = current.Config.Env;
    assert.ok(environment.every(value => /^[A-Za-z_][A-Za-z0-9_]*=[^\r\n]*$/.test(value)));
    const env = Object.fromEntries(environment.map(value => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)]));
    const database = new URL(env.DATABASE_URL);
    assert.equal(database.hostname, "postgres");
    assert.equal(database.username, "varda_app");
    assert.equal(database.pathname, "/varda");
    assert.equal(new URL(env.S3_ENDPOINT).hostname, "rustfs");
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.BETTER_AUTH_URL, base);
    assert.equal(env.WEB_URL, base);
    const envPath = join(root, "runtime.env");
    await writeFile(envPath, `${environment.join("\n")}\n`, { mode: 0o600 });

    // Probe the exact HTTP process's own old pool after the HTTP assertions.
    // The wrapper adds no routes and imports only the unmodified API entrypoint.
    const wrapper = `
      import {writeFile} from 'node:fs/promises';
      import assert from 'node:assert/strict';
      import {pool} from './dist/db/index.js';
      import {inWorkspace} from './dist/db/tenant.js';
      import {sql} from 'drizzle-orm';
      const workspaceId=${JSON.stringify(workspaceId)}, vardId=${JSON.stringify(vardId)};
      const baseline=async(destroy=false)=>{
        const clients=await Promise.all(Array.from({length:3},()=>pool.connect()));
        try {
          const rows=await Promise.all(clients.map(async client=>(await client.query("SELECT pg_backend_pid() AS pid,current_user AS role,current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '2' AS baseline1")).rows[0]));
          assert.equal(new Set(rows.map(row=>row.pid)).size,3);
          assert.ok(rows.every(row=>row.baseline1&&row.role==='varda_app'));
          return rows.map(row=>row.pid).sort();
        } finally { for(const client of clients)client.release(destroy); }
      };
      process.on('SIGUSR2',()=>void(async()=>{
        try {
          const initialPids=await baseline();
          const context=await inWorkspace(workspaceId,async tx=>(await tx.execute(sql\`SELECT current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '2' AS baseline1,current_setting('app.workspace_id',true)=\${workspaceId} AS tenant,(SELECT count(*)::int FROM vard WHERE id=\${vardId}) AS parents,(SELECT count(*)::int FROM vard_item WHERE vard_id=\${vardId}) AS children\`)).rows[0]);
          assert.deepEqual(context,{baseline1:true,tenant:true,parents:0,children:0});
          assert.deepEqual(await baseline(),initialPids);
          await baseline(true);
          assert.ok((await baseline()).every(pid=>!initialPids.includes(pid)));
          await writeFile(${JSON.stringify(proofPath)},JSON.stringify({oldRuntimeBaseline1:true,oldHelperBaseline1:true,oldParentChildHidden:true,oldConcurrentClients:3,oldReconnectBaseline1:true}),{mode:0o600});
        } catch { await writeFile(${JSON.stringify(proofPath)},JSON.stringify({oldRuntimeBaseline1:false}),{mode:0o600}); }
      })());
      await import('./dist/server.js');
    `;
    phase = "old API-only startup";
    await docker("run", "--detach", "--pull", "never", "--name", name, "--label", `${label}=${token}`,
      "--network", networks[0], "--env-file", envPath, "--publish", "127.0.0.1::3000",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", oldImage,
      "node", "--input-type=module", "-e", wrapper);
    const running = await inspect(name);
    assert.equal(running.Image, pre102Image);
    assert.equal(running.Config.Labels[label], token);
    assert.deepEqual(Object.keys(running.NetworkSettings.Networks), networks);
    const binding = running.NetworkSettings.Ports["3000/tcp"];
    assert.equal(binding.length, 1);
    assert.equal(binding[0].HostIp, "127.0.0.1");
    assert.match(binding[0].HostPort, /^\d+$/);
    const oldBase = `http://127.0.0.1:${binding[0].HostPort}`;
    let ready = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { ready = (await fetch(`${oldBase}/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { /* bounded startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(ready, true);
    const capabilities = await api(oldBase, "/api/capabilities");
    assert.equal(capabilities.vardEditRevision, 1);
    assert.equal(capabilities.vardDefinitionSchema, undefined);

    phase = "old source-only control";
    const control = await api(base, `/api/workspaces/${workspaceId}/vards`, { name: `Old binary control ${token}` });
    controlId = control.id;
    assert.match(controlId, uuid);
    const controlPath = `/api/workspaces/${workspaceId}/vards/${controlId}`;
    await api(oldBase, controlPath, { name: `Old binary updated ${token}` }, "PATCH");
    const direct = { assetId: cascadeSourceId, outputPath: "control.svg", versionId: null, transformation: null, writable: false };
    await api(oldBase, `${controlPath}/items`, { items: [direct] }, "PUT");
    const oldControl = await api(oldBase, controlPath);
    assert.equal(oldControl.items.length, 1);
    assert.equal(oldControl.items[0].assetId, cascadeSourceId);
    assert.match((await api(oldBase, `${controlPath}/editor`)).revision, /^v1:[a-f0-9]{64}$/);
    assert.equal((await api(oldBase, `${controlPath}/manifest`)).items.length, 1);
    const listed = await api(oldBase, `/api/workspaces/${workspaceId}/vards`);
    assert.ok(listed.vards.some(row => row.id === controlId));
    assert.ok(!listed.vards.some(row => row.id === vardId));

    phase = "public marker2 positive control";
    const publicVard = await api(base, `/api/workspaces/${workspaceId}/vards`, { name: `Public old binary control ${token}`, isPublic: true });
    publicId = publicVard.id;
    assert.match(publicId, uuid);
    const publicPath = `/api/workspaces/${workspaceId}/vards/${publicId}/editor`;
    const publicDefinition = await api(base, `${publicPath}?definitionSchema=2`);
    const publicSaved = await api(base, `${publicPath}/items`, {
      definitionSchema: 2, expectedRevision: publicDefinition.revision,
      items: [{ id: null, outputPath: "linked.png", binding: { kind: "use", assetUseId: publicUseId } }],
    }, "PUT");
    assert.equal(publicSaved.storedDefinitionSchema, 2);
    const newPublic = await fetch(`${base}/v/${publicId}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(newPublic.status, 200, "Capable anonymous discovery must reach the public marker2 parent");
    const newPublicManifest = await newPublic.json();
    assert.equal(newPublicManifest.id, publicId);
    assert.equal(newPublicManifest.items[0].assetId, publicSourceId);
    assert.ok(newPublicManifest.items[0].downloadUrl);
    assert.ok(!(await api(oldBase, `/api/workspaces/${workspaceId}/vards`)).vards.some(row => row.id === publicId));

    const snapshot = async () => JSON.parse((await docker("exec", postgresId, "psql", "-X", "-U", "varda", "-d", "varda", "-At", "-v", "ON_ERROR_STOP=1", "-c", `SELECT json_build_object(
      'vards',(SELECT json_agg(v ORDER BY id) FROM vard v WHERE id IN ('${vardId}','${controlId}','${publicId}')),
      'items',(SELECT json_agg(i ORDER BY id) FROM vard_item i WHERE vard_id IN ('${vardId}','${controlId}','${publicId}')),
      'uses',(SELECT json_agg(u ORDER BY id) FROM asset_use u WHERE source_asset_id IN ('${sourceId}','${publicSourceId}')),
      'assets',(SELECT json_agg(a ORDER BY id) FROM asset a WHERE id IN ('${sourceId}','${cascadeSourceId}','${publicSourceId}')),
      'versions',(SELECT json_agg(v ORDER BY id) FROM asset_version v WHERE asset_id IN ('${sourceId}','${cascadeSourceId}','${publicSourceId}')),
      'audits',(SELECT coalesce(json_agg(e ORDER BY id),'[]'::json) FROM audit_event e WHERE target_id IN ('${vardId}','${controlId}','${publicId}','${sourceId}','${cascadeSourceId}','${publicSourceId}','${useId}','${publicUseId}'))
    )`)).stdout.trim());
    const before = await snapshot();
    const definitionBefore = await api(base, `${vardPath}/editor?definitionSchema=2`);
    const manifestBefore = await api(base, `${vardPath}/manifest`);
    assert.equal(before.vards.find(row => row.id === vardId).definition_schema, 2);
    assert.ok(before.items.filter(row => row.vard_id === vardId).every(row => row.definition_schema === 2));
    assert.equal(before.vards.find(row => row.id === publicId).definition_schema, 2);
    assert.ok(before.items.filter(row => row.vard_id === publicId).every(row => row.definition_schema === 2));
    assert.equal(before.assets.find(row => row.id === publicSourceId).is_public, true);
    assert.equal(before.assets.find(row => row.id === sourceId).is_public, false);
    const unchanged = async () => {
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await api(base, `${vardPath}/editor?definitionSchema=2`), definitionBefore);
      assert.deepEqual(await api(base, `${vardPath}/manifest`), manifestBefore);
    };
    phase = "old extended reads and writes refuse";
    const statuses = [];
    for (const [path, method, body] of [
      [vardPath, "GET"], [`${vardPath}/manifest`, "GET"], [`${vardPath}/editor`, "GET"],
      [`${vardPath}/editor?definitionSchema=2`, "GET"],
      [vardPath, "PATCH", { name: "Old writer must not save" }],
      [`${vardPath}/items`, "PUT", { items: [direct] }],
      [vardPath, "DELETE"],
      [`${vardPath}/editor`, "PATCH", { expectedRevision: oldRevision, name: "Old v1 must not save" }],
      [`${vardPath}/editor/items`, "PUT", { expectedRevision: oldRevision, items: [{ id: null, ...direct }] }],
      [`${vardPath}/editor?expectedRevision=${encodeURIComponent(oldRevision)}`, "DELETE"],
      [`/v/${vardId}`, "GET"],
    ]) {
      const response = await apiResponse(oldBase, path, body, method);
      assert.ok([404, 409, 500].includes(response.status), "Old API must refuse an extended definition");
      statuses.push(response.status);
      await unchanged();
    }
    const oldPublic = await fetch(`${oldBase}/v/${publicId}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(oldPublic.status, 404, "Historical anonymous discovery must hide a public marker2 definition");
    await unchanged();
    phase = "old source cascade rollback";
    const cascade = await apiResponse(oldBase, `/api/workspaces/${workspaceId}/assets/${cascadeSourceId}`, undefined, "DELETE");
    assert.equal(cascade.status, 500);
    await unchanged();
    const logs = await docker("logs", name);
    assert.match(`${logs.stdout}${logs.stderr}`, /vard_definition_capability_guard|Vard definition requires schema 2 capability/, "Actual old source cascade must reach the capability trigger");
    const linkedUse = before.uses.find(row => row.id === useId);
    const useDelete = await apiResponse(oldBase, `/api/workspaces/${workspaceId}/asset-uses/${useId}?expectedRevision=${linkedUse.revision}`, undefined, "DELETE");
    assert.equal(useDelete.status, 500);
    await unchanged();

    phase = "old runtime physical sessions";
    await docker("kill", "--signal", "SIGUSR2", name);
    let oldProof;
    const proofDeadline = Date.now() + 10_000;
    while (Date.now() < proofDeadline) {
      try {
        oldProof = JSON.parse((await docker("exec", name, "node", "--input-type=module", "-e", `import {readFile} from 'node:fs/promises';process.stdout.write(await readFile(${JSON.stringify(proofPath)},'utf8'));`)).stdout);
      } catch { /* receipt is published only when the same-process probe finishes */ }
      if (oldProof) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(oldProof, { oldRuntimeBaseline1: true, oldHelperBaseline1: true, oldParentChildHidden: true,
      oldConcurrentClients: 3, oldReconnectBaseline1: true });
    // This independent helper process loads the deployed new modules. It does
    // not inspect the already serving new HTTP process's private pool.
    phase = "independent new helper transaction-local capability";
    const newProof = JSON.parse((await docker("exec", currentId, "node", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {pool,closeDatabase} from './dist/db/index.js';
      import {inWorkspace} from './dist/db/tenant.js';
      import {sql} from 'drizzle-orm';
      const workspaceId=${JSON.stringify(workspaceId)};
      const baseline=async(destroy=false)=>{
        const clients=await Promise.all(Array.from({length:3},()=>pool.connect()));
        try {
          const rows=await Promise.all(clients.map(async client=>(await client.query("SELECT pg_backend_pid() AS pid,current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '2' AS baseline1")).rows[0]));
          assert.equal(new Set(rows.map(row=>row.pid)).size,3);assert.ok(rows.every(row=>row.baseline1));
          return rows.map(row=>row.pid).sort();
        } finally { for(const client of clients)client.release(destroy); }
      };
      try {
        const initialPids=await baseline();
        await inWorkspace(workspaceId,async tx=>{
          const row=(await tx.execute(sql\`SELECT current_setting('vardum.vard_definition_schema',true) AS capability,current_setting('app.workspace_id',true) AS tenant\`)).rows[0];
          assert.deepEqual(row,{capability:'2',tenant:workspaceId});
        });
        assert.deepEqual(await baseline(),initialPids);
        let rolledBack=false;
        const expectedError=new Error('expected');
        try { await inWorkspace(workspaceId,async tx=>{assert.equal((await tx.execute(sql\`SELECT current_setting('vardum.vard_definition_schema',true) AS capability\`)).rows[0].capability,'2');throw expectedError;}); }
        catch(error) { assert.equal(error,expectedError);rolledBack=true; }
        assert.equal(rolledBack,true);assert.deepEqual(await baseline(),initialPids);
        await baseline(true);assert.ok((await baseline()).every(pid=>!initialPids.includes(pid)));
        console.log(JSON.stringify({newHelperPoolBaseline1:true,newHelperLocalCapability2:true,newHelperCommitBaseline1:true,newHelperRollbackBaseline1:true,newHelperConcurrentClients:3,newHelperReconnectBaseline1:true}));
      } finally { await closeDatabase(); }
    `)).stdout.trim());
    assert.deepEqual(newProof, { newHelperPoolBaseline1: true, newHelperLocalCapability2: true, newHelperCommitBaseline1: true,
      newHelperRollbackBaseline1: true, newHelperConcurrentClients: 3, newHelperReconnectBaseline1: true });
    await unchanged();
    console.log(JSON.stringify({ check: "actual-pre102-api", oldApiImage: oldImage, oldApiOnly: true,
      sourceOnlyReadsAndWrites: true, extendedRefusalStatuses: statuses, sourceCascadeStatus: cascade.status,
      newAnonymousPublicStatus: newPublic.status, oldAnonymousPublicStatus: oldPublic.status, oldPublicListOmitted: true,
      useDeleteStatus: useDelete.status, sourceCascadeTrigger: true, persistedRowsUnchanged: true,
      newProbeIsIndependentHelperPool: true, ...oldProof, ...newProof }));
  } catch {
    console.log(JSON.stringify({ check: "actual-pre102-api", passed: false, phase }));
    throw new Error(`Old API acceptance failed during ${phase}`);
  } finally {
    try {
      // Check ownership even after a partially successful docker run. Never
      // remove a coincidentally named container belonging to another task.
      const owned = await inspect(name).catch(() => null);
      if (owned) {
        assert.equal(owned.Config.Labels[label], token);
        await docker("rm", "--force", name);
      }
      if (controlId) await api(base, `/api/workspaces/${workspaceId}/vards/${controlId}`, undefined, "DELETE");
      if (publicId) {
        const currentPublic = await api(base, `/api/workspaces/${workspaceId}/vards/${publicId}/editor?definitionSchema=2`);
        await api(base, `/api/workspaces/${workspaceId}/vards/${publicId}/editor?definitionSchema=2&expectedRevision=${encodeURIComponent(currentPublic.revision)}`, undefined, "DELETE");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}
