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
  const compose = (...args) => run("docker", [
    "compose", "--env-file", "/dev/null", "-p", project,
    "-f", process.env.SMOKE_COMPOSE_FILE ?? "compose.production.yml",
    ...candidateComposeArgs(args),
  ], { timeout: 60_000 });
  const container = source => compose("exec", "-T", "api", "node", "--input-type=module", "-e", source);
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
  async function postUpload(upload, data) {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    form.append("file", new Blob([data], { type: "image/svg+xml" }), "replay.svg");
    const response = await fetch(upload.url, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `Actual signed POST failed: ${response.status} ${await response.text()}`);
    return response.status;
  }
  const replay = data => postUpload(version.upload, data);
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
  await container(storedProof(3));
  const replayAfterSweep = await replay(changed);
  await assertDelivery();
  await container(storedProof(5)); // late recreation also gets swept; same ready bytes

  // No durable job is created for this fixture: pause reconciliation while a
  // separate runtime-role process holds the processor exactly before its PUT.
  // The ordinary finalized/queued worker path was exercised above.
  await compose("stop", "worker");
  try {
    const processingAsset = await api(`/api/workspaces/${workspaceId}/assets`, {
      key: "upload-integrity-processing", displayName: "Upload integrity during processing",
    });
    const processingPath = `/api/workspaces/${workspaceId}/assets/${processingAsset.id}`;
    const processingVersion = await api(`${processingPath}/versions`, {
      id: randomUUID(), filename: "replay.svg", mimeType: "image/svg+xml", size: bytes.length,
      expectedChecksum: digest(bytes), expectedCurrentVersionId: null,
    });
    assert.equal(processingVersion.status, "pending");
    const processingInitialPost = await postUpload(processingVersion.upload, bytes);
    const processingResult = await container(`
      import assert from 'node:assert/strict';
      import {createHash} from 'node:crypto';
      const {processAsset}=await import('./dist/asset-processor.js');
      const {storage,getObject}=await import('./dist/storage.js');
      const {config}=await import('./dist/config.js');
      const {inWorkspace}=await import('./dist/db/tenant.js');
      const {pool,closeDatabase}=await import('./dist/db/index.js');
      const {assertRuntimeDatabaseRole}=await import('./dist/db/runtime-role.js');
      const {sql}=await import('drizzle-orm');
      const workspaceId=${JSON.stringify(workspaceId)}, assetId=${JSON.stringify(processingAsset.id)}, versionId=${JSON.stringify(processingVersion.id)};
      const upload=${JSON.stringify(processingVersion.upload)};
      const expectedSha=${JSON.stringify(digest(bytes))}, changedSha=${JSON.stringify(digest(changed))};
      const original=Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64');
      const changed=Buffer.from(${JSON.stringify(changed.toString("base64"))},'base64');
      const digest=data=>createHash('sha256').update(data).digest('hex');
      const state=()=>inWorkspace(workspaceId,async tx=>(await tx.execute(sql\`SELECT status,storage_key,checksum,ingest_attempt_id,ingest_job_id FROM asset_version WHERE id=\${versionId}\`)).rows[0]);
      const sealedPrefix='originals/'+workspaceId+'/'+assetId+'/'+versionId+'/sealed/';
      let phase='runtime-role', intercepted=false, processingPost, sealedKey;
      try {
        await assertRuntimeDatabaseRole(pool);
        assert.equal((await pool.query('SELECT current_user AS role')).rows[0].role,'varda_app');
        const pending=await state();
        assert.equal(pending.status,'pending');
        assert.equal(pending.ingest_job_id,null);
        storage.middlewareStack.add((next,context)=>async args=>{
          if(context.commandName==='PutObjectCommand'&&args.input.Key.startsWith(sealedPrefix)) {
            phase='verified-buffer';
            assert.equal(intercepted,false);
            intercepted=true;
            const before=await state();
            assert.equal(before.status,'processing');
            assert.equal(before.storage_key,upload.fields.key);
            assert.equal(before.checksum,null);
            assert.equal(before.ingest_job_id,null);
            assert.ok(before.ingest_attempt_id);
            assert.equal(args.input.Key,sealedPrefix+before.ingest_attempt_id+'/source');
            sealedKey=args.input.Key;
            const verifiedBody=args.input.Body;
            assert.ok(Buffer.isBuffer(verifiedBody));
            assert.equal(digest(verifiedBody),expectedSha);
            assert.deepEqual(verifiedBody,original);
            phase='signed-processing-post';
            const postUrl=new URL(upload.url), internal=new URL(config.S3_ENDPOINT);
            postUrl.protocol=internal.protocol;
            postUrl.host=internal.host;
            const form=new FormData();
            for(const [key,value] of Object.entries(upload.fields))form.append(key,value);
            form.append('file',new Blob([changed],{type:'image/svg+xml'}),'replay.svg');
            const posted=await fetch(postUrl,{method:'POST',body:form,signal:AbortSignal.timeout(15_000)});
            processingPost=posted.status;
            assert.equal(posted.ok,true);
            phase='replaced-stage';
            const stage=await getObject(upload.fields.key);
            const stageBytes=Buffer.from(await stage.Body.transformToByteArray());
            assert.equal(digest(stageBytes),changedSha);
            assert.deepEqual(stageBytes,changed);
            assert.deepEqual(await state(),before);
            assert.equal(args.input.Body,verifiedBody);
            assert.equal(digest(args.input.Body),expectedSha);
            phase='sealed-put';
          }
          return next(args);
        },{step:'initialize',name:'actualProcessingReplay'});
        phase='process-asset';
        await processAsset({workspaceId,assetId,versionId,requestId:'smoke:processing-replay'});
        phase='published-original';
        assert.equal(intercepted,true);
        const ready=await state();
        assert.equal(ready.status,'ready');
        assert.equal(ready.checksum,expectedSha);
        assert.notEqual(ready.storage_key,upload.fields.key);
        assert.equal(ready.storage_key,sealedKey);
        const published=await getObject(ready.storage_key);
        const publishedBytes=Buffer.from(await published.Body.transformToByteArray());
        assert.equal(digest(publishedBytes),expectedSha);
        assert.deepEqual(publishedBytes,original);
        console.log(JSON.stringify({processingReplay:true,runtimeRole:true,processingPost,stageSha:changedSha,publishedSha:digest(publishedBytes),databaseSha:ready.checksum,sealed:true}));
      } catch {
        console.log(JSON.stringify({processingReplay:false,phase}));
        process.exitCode=1;
      } finally { storage.destroy(); await closeDatabase(); }
    `).catch(error => {
      // execFile errors include the full node -e source and its valid POST form.
      // Forward only our deliberately bounded phase, never cmd/stdout/stderr.
      const phase = error.stdout?.match(/"processingReplay":false,"phase":"([a-z-]+)"/)?.[1] ?? "container";
      throw new Error(`Actual processing replay failed during ${phase}; signed upload command omitted`);
    });
    const processed = await api(`${processingPath}/versions/${processingVersion.id}`);
    assert.equal(processed.status, "ready");
    assert.equal(processed.id, processingVersion.id);
    assert.equal(processed.checksum, digest(bytes));
    const delivered = await request(`/w/${workspaceSlug}/__v/${processingVersion.id}/${processingAsset.key}`);
    assert.equal(delivered.status, 200);
    const deliveredBytes = Buffer.from(await delivered.arrayBuffer());
    assert.deepEqual(deliveredBytes, bytes);
    assert.equal(digest(deliveredBytes), processed.checksum);
    console.log(processingResult.stdout.trim());
    console.log(JSON.stringify({processingInitialPost,processingDeliveredSha:digest(deliveredBytes),processingDelivery:true}));
  } finally {
    await compose("start", "worker");
  }
  console.log(`Upload integrity smoke passed: actual POST ${initialPost}/${readyReplay}/${archiveReplay}/${replayAfterSweep}; ready/archive/processing/late stage replay, delivered SHA-256, DB identity, repeated cleanup and retained quota.`);
}
