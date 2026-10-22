import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { candidateComposeArgs } from "./server-candidate.mjs";
import { run } from "./release-packages.mjs";

/** Actual app grants + RustFS signature validation, not a permissive HTTP mock. */
export async function checkUploadIntegrity({ request, workspaceId, workspaceSlug }) {
  const project = process.env.SMOKE_COMPOSE_PROJECT;
  assert.match(project ?? "", /^vardum-smoke-\d+$/);
  const api = (path, body, method = body === undefined ? "GET" : "POST") => request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).then(response => response.json());
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>');
  const changed = Buffer.from(bytes.toString().replace("red", "tan"));
  const digest = data => createHash("sha256").update(data).digest("hex");
  assert.equal(bytes.length, changed.length);
  const asset = await api(`/api/workspaces/${workspaceId}/assets`, { key: "upload-integrity", displayName: "Upload integrity" });
  const path = `/api/workspaces/${workspaceId}/assets/${asset.id}`;
  const version = await api(`${path}/versions`, {
    id: randomUUID(), filename: "replay.svg", mimeType: "image/svg+xml", size: bytes.length,
    expectedChecksum: digest(bytes), expectedCurrentVersionId: null,
  });
  async function replay(data) {
    const form = new FormData();
    for (const [key, value] of Object.entries(version.upload.fields)) form.append(key, value);
    form.append("file", new Blob([data], { type: "image/svg+xml" }), "replay.svg");
    const response = await fetch(version.upload.url, { method: "POST", body: form });
    assert.ok(response.ok, `Actual signed POST failed: ${response.status} ${await response.text()}`);
    return response.status;
  }
  const initialPost = await replay(bytes);
  await api(`${path}/versions/${version.id}/finalize`, {});
  const deadline = Date.now() + 60_000;
  let ready;
  do {
    ready = await api(`${path}/versions/${version.id}`);
    assert.notEqual(ready.status, "failed", ready.error);
    if (ready.status === "ready") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(ready.status, "ready");
  assert.equal(ready.checksum, digest(bytes));
  const deliveryPath = `/w/${workspaceSlug}/__v/${version.id}/${asset.key}`;
  async function assertDelivery() {
    const response = await request(deliveryPath);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(bytes));
    assert.equal((await api(`${path}/versions/${version.id}`)).checksum, digest(bytes));
  }
  const readyReplay = await replay(changed);
  await assertDelivery();
  await api(`${path}/archive`, { archived: true, expectedArchivedAt: null, expectedCurrentVersionId: version.id }, "PATCH");
  const archiveReplay = await replay(changed);
  await assertDelivery();

  const compose = source => run("docker", [
    "compose", "--env-file", "/dev/null", "-p", project,
    "-f", process.env.SMOKE_COMPOSE_FILE ?? "compose.production.yml",
    ...candidateComposeArgs(["exec", "-T", "api", "node", "--input-type=module", "-e", source]),
  ], { timeout: 60_000 });
  const storedProof = days => `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    const {storage,getObject,headObject}=await import('./dist/storage.js');
    const {inWorkspace}=await import('./dist/db/tenant.js');
    const {sql}=await import('drizzle-orm');
    const {cleanupUploadObjects}=await import('./dist/upload-objects.js');
    const {workspaceUsage}=await import('./dist/upload-lifecycle.js');
    const {closeDatabase}=await import('./dist/db/index.js');
    try {
      const workspaceId=${JSON.stringify(workspaceId)}, versionId=${JSON.stringify(version.id)};
      const state=await inWorkspace(workspaceId,async tx=>(await tx.execute(sql\`SELECT status,storage_key,checksum,upload_cleaned_at FROM asset_version WHERE id=\${versionId}\`)).rows[0]);
      assert.equal(state.status,'ready');
      assert.notEqual(state.storage_key,${JSON.stringify(version.upload.fields.key)});
      assert.equal(state.checksum,${JSON.stringify(digest(bytes))});
      const before=await inWorkspace(workspaceId,tx=>workspaceUsage(tx,workspaceId));
      await cleanupUploadObjects(new Date(Date.now()+${days}*86400_000));
      const object=await getObject(state.storage_key);
      const actual=createHash('sha256').update(await object.Body.transformToByteArray()).digest('hex');
      assert.equal(actual,state.checksum);
      let absent=false;
      try { await headObject(${JSON.stringify(version.upload.fields.key)}); }
      catch(error) { if(error.$metadata?.httpStatusCode===404) absent=true; else throw error; }
      assert.equal(absent,true,'replayed stage was not swept');
      const after=await inWorkspace(workspaceId,tx=>workspaceUsage(tx,workspaceId));
      assert.equal(after.reservedBytes,before.reservedBytes);
      assert.equal(state.upload_cleaned_at,null);
      console.log(JSON.stringify({publishedSha:actual,databaseSha:state.checksum,stageRemoved:true,reservationPreserved:true}));
    } finally { storage.destroy(); await closeDatabase(); }
  `;
  await compose(storedProof(3));
  const replayAfterSweep = await replay(changed);
  await assertDelivery();
  await compose(storedProof(5)); // late recreation also gets swept; same ready bytes
  console.log(`Upload integrity smoke passed: actual POST ${initialPost}/${readyReplay}/${archiveReplay}/${replayAfterSweep}; ready/archive/late stage replay, delivered SHA-256, DB identity, repeated cleanup and retained quota.`);
}
