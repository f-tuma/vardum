import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertRunningCandidate, candidateComposeArgs } from "./server-candidate.mjs";
import { run, smokeClientOptions, withInstalledRelease } from "./release-packages.mjs";

// Never accepts a deployed project. The outer smoke owns both disposable stacks.
export async function checkBackupRestore({
  base,
  cookie,
  workspaceId,
  otherWorkspaceId,
  assetId,
  versionId,
}) {
  const source = process.env.SMOKE_COMPOSE_PROJECT;
  assert.match(source ?? "", /^vardum-smoke-\d+$/);
  const target = `${source}-restore`;
  const compose = (project, ...args) =>
    run(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "--profile",
        "rustfs",
        "-p",
        project,
        "-f",
        process.env.SMOKE_COMPOSE_FILE ?? "compose.production.yml",
        ...candidateComposeArgs(args),
      ],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
    );
  const sql = async (project, text) =>
    (
      await compose(
        project,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-X",
        "-U",
        "varda",
        "-d",
        "varda",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        text,
      )
    ).stdout.trim();
  const queryCounts = `SELECT json_build_object(${["user", "session", "account", "verification", "organization", "member", "invitation", "workspace", "workspace_settings", "asset", "asset_version", "asset_folder", "asset_use", "vard", "vard_item", "apikey", "audit_event", "delivery_event"].map((name) => `'${name}',(SELECT count(*) FROM "${name}")`).join(",")})`;
  const tables = (project) =>
    sql(
      project,
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'",
    );
  const apiResponse = (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: { cookie, origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const api = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await apiResponse(path, body, method);
    assert.ok(
      response.ok,
      `${method} ${path}: ${response.status} ${await response.clone().text()}`,
    );
    return response.json();
  };
  const storageCommand = (project, code) =>
    compose(
      project,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "api",
      "node",
      "--input-type=module",
      "-e",
      `const {storage}=await import('./dist/storage.js');const {config}=await import('./dist/config.js');try{${code}}finally{storage.destroy();}`,
    );
  const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const pendingState = async (project, fixture) => {
    // These IDs are generated locally and checked against the API response.
    assert.match(fixture.assetId, /^[a-f0-9-]{36}$/);
    assert.match(fixture.intent.id, /^[a-f0-9-]{36}$/);
    return JSON.parse(await sql(project, `SELECT json_build_object(
      'asset', (SELECT row_to_json(a) FROM asset a WHERE id='${fixture.assetId}'),
      'versions', (SELECT coalesce(json_agg(v ORDER BY v.number),'[]'::json) FROM asset_version v WHERE asset_id='${fixture.assetId}'),
      'audit', (SELECT coalesce(json_agg(e ORDER BY e.id),'[]'::json) FROM audit_event e WHERE (target_type='asset' AND target_id='${fixture.assetId}') OR (target_type='asset_version' AND target_id='${fixture.intent.id}')),
      'reservation', (SELECT json_build_object('bytes',coalesce(sum(size) FILTER (WHERE upload_cleaned_at IS NULL),0),'pending',count(*) FILTER (WHERE status IN ('pending','processing'))) FROM asset_version WHERE asset_id='${fixture.assetId}'),
      'counts', json_build_object('assets',(SELECT count(*) FROM asset),'versions',(SELECT count(*) FROM asset_version))
    )`));
  };
  const storePending = async (fixture, upload, bytes) => {
    assert.equal(upload.method, "POST");
    assert.equal(upload.fields.key, fixture.storageKey);
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields))
      form.append(name, value);
    form.append("file", new Blob([bytes], { type: fixture.intent.mimeType }), fixture.intent.filename);
    const response = await fetch(upload.url, {
      method: "POST", body: form, signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, `Pending storage upload: ${response.status} ${await response.text()}`);
  };
  const assertPendingObject = async (project, fixture, bytes) => {
    const result = await storageCommand(project, `
      const {default:assert}=await import('node:assert/strict');
      const {GetObjectCommand}=await import('@aws-sdk/client-s3');
      const object=await storage.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:${JSON.stringify(fixture.storageKey)}}));
      assert.equal(object.ContentLength,${bytes.length});
      assert.equal(object.ContentType,${JSON.stringify(fixture.intent.mimeType)});
      assert.deepEqual(Buffer.from(await object.Body.transformToByteArray()),Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64'));
      const headers=Object.fromEntries(Object.entries({ContentType:object.ContentType,CacheControl:object.CacheControl,ContentDisposition:object.ContentDisposition,ContentEncoding:object.ContentEncoding,ContentLanguage:object.ContentLanguage,Expires:object.Expires?.toISOString(),Metadata:object.Metadata}).filter(([,value])=>value!==undefined));
      const expectedHeaders=${JSON.stringify(fixture.objectHeaders ?? null)};
      if(expectedHeaders)assert.deepEqual(headers,expectedHeaders);
      console.log(JSON.stringify(headers));
    `);
    return JSON.parse(result.stdout.trim());
  };
  const assertWritersStopped = async (project) => {
    const running = (await compose(project, "ps", "--services", "--status", "running")).stdout.trim().split("\n");
    assert.ok(!running.some((service) => ["api", "worker", "gateway"].includes(service)), "snapshot/restore assertions require stopped application writers");
  };
  let targetCreated = false;
  try {
    await withInstalledRelease(
      process.env.SMOKE_RELEASE_DIR,
      async ({ root, cli }) => {
        const key = (
          await api(`/api/workspaces/${workspaceId}/api-keys`, {
            name: "restore-read",
            access: "read",
          })
        ).key;
        const vard = await api(`/api/workspaces/${workspaceId}/vards`, {
          name: "Recovery fixture",
          folderRules: [],
        });
        const items = [
          { assetId, outputPath: "assets/current.svg", transformation: null },
          {
            assetId,
            versionId,
            outputPath: "assets/pinned.svg",
            transformation: null,
          },
          {
            assetId,
            versionId,
            outputPath: "assets/preview.png",
            transformation: { w: 16, format: "png" },
          },
        ];
        await api(
          `/api/workspaces/${workspaceId}/vards/${vard.id}/items`,
          { items },
          "PUT",
        );
        const project = join(root, "project");
        const configHome = join(root, "config");
        await mkdir(project);
        await mkdir(join(configHome, "vardum"), { recursive: true });
        await writeFile(
          join(configHome, "vardum/version-check.json"),
          JSON.stringify({ latest: cli.version, at: Date.now() }),
        );
        const command = (...args) =>
          run(process.execPath, [cli.binary, ...args, "--json"], {
            cwd: project,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              VARDUM_CONFIG_HOME: configHome,
              VARDUM_API_KEY: key,
            },
            timeout: 30_000,
          });
        await command(
          "init",
          "--server",
          base,
          "--workspace",
          workspaceId,
          "--vard",
          vard.id,
        );
        assert.equal(JSON.parse((await command("pull")).stdout).changed, 3);
        const lock = await readFile(join(project, ".vardum.lock"), "utf8");
        const files = new Map();
        for (const item of Object.values(JSON.parse(lock).items))
          files.set(item.path, await readFile(join(project, item.path)));
        const historyBefore = await api(
          `/api/workspaces/${workspaceId}/assets/${assetId}/versions`,
        );
        const signed = await api(
          `/api/workspaces/${workspaceId}/assets/${assetId}/transform-url`,
          { w: 24, format: "png" },
        );
        const signedBytes = Buffer.from(
          await (
            await fetch(new URL(signed.url, base), { headers: { cookie } })
          ).arrayBuffer(),
        );

        const linkedUse = await api(`/api/workspaces/${workspaceId}/asset-uses`, {
          sourceAssetId: assetId, key: "reuse/restored-logo.png", displayName: "Restored linked logo",
          transformation: { format: "png", w: 24 },
        });
        const linkedBefore = await api(`/api/workspaces/${workspaceId}/asset-uses?sourceAssetId=${assetId}`);
        assert.equal(linkedBefore.uses[0].id, linkedUse.id);
        const linkedPath = new URL(linkedBefore.uses[0].previewUrl, base).pathname.replace(/\/__v\/[^/]+\/.*$/, "/reuse/restored-logo.png");
        const linkedBytes = Buffer.from(await (await fetch(`${base}${linkedPath}`, { headers: { cookie } })).arrayBuffer());
        assert.deepEqual(linkedBytes, signedBytes);

        // Include a real durable job that cannot finish until the restored worker starts.
        await compose(source, "stop", "worker");
        const queuedAsset = await api(`/api/workspaces/${workspaceId}/assets`, {
          key: "restored-queue",
          displayName: "Restored queue",
        });
        const file = new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
          ],
          { type: "image/svg+xml" },
        );
        const queued = await api(
          `/api/workspaces/${workspaceId}/assets/${queuedAsset.id}/versions`,
          { filename: "queued.svg", mimeType: file.type, size: file.size },
        );
        const form = new FormData();
        for (const [name, value] of Object.entries(queued.upload.fields))
          form.append(name, value);
        form.append("file", file, "queued.svg");
        assert.ok(
          (await fetch(queued.upload.url, { method: "POST", body: form })).ok,
        );
        await api(
          `/api/workspaces/${workspaceId}/assets/${queuedAsset.id}/versions/${queued.id}/finalize`,
          {},
          "POST",
        );
        // These requests remain pending, with original objects but no ingest jobs.
        // They exercise the server contract even when installed public clients
        // predate resumable folder uploads.
        const pendingBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>');
        const changedBytes = Buffer.from(pendingBytes.toString().replace('fill="blue"', 'fill="pink"'));
        assert.equal(changedBytes.length, pendingBytes.length);
        assert.notEqual(checksum(changedBytes), checksum(pendingBytes));
        const pendingFixtures = [];
        for (const outcome of ["ready", "failed"]) {
          const id = randomUUID();
          const assetKey = `restored-pending-${outcome}`;
          const created = await api(`/api/workspaces/${workspaceId}/assets`, {
            id, key: assetKey, displayName: `Restored pending ${outcome}`,
          });
          assert.equal(created.id, id);
          const intent = {
            id: randomUUID(), filename: "pending.svg", mimeType: "image/svg+xml",
            size: pendingBytes.length, expectedChecksum: checksum(pendingBytes),
            expectedCurrentVersionId: null,
          };
          const path = `/api/workspaces/${workspaceId}/assets/${id}/versions`;
          const response = await apiResponse(path, intent);
          assert.equal(response.status, 201, await response.clone().text());
          const { upload, ...initialVersion } = await response.json();
          assert.equal(initialVersion.id, intent.id);
          assert.equal(initialVersion.status, "pending");
          assert.equal(initialVersion.expectedChecksum, intent.expectedChecksum);
          assert.equal(initialVersion.checksum, null);
          assert.ok(Date.parse(initialVersion.expiresAt) > Date.now());
          const fixture = {
            assetId: id, key: assetKey, intent, path, outcome, initialVersion,
            storageKey: `originals/${workspaceId}/${id}/${intent.id}/source`,
          };
          await storePending(fixture, upload, pendingBytes);
          pendingFixtures.push(fixture);
        }
        for (const fixture of pendingFixtures) {
          fixture.before = await pendingState(source, fixture);
          assert.equal(fixture.before.versions.length, 1);
          const [row] = fixture.before.versions;
          assert.equal(row.id, fixture.intent.id);
          assert.equal(row.status, "pending");
          assert.equal(row.expected_checksum, fixture.intent.expectedChecksum);
          assert.equal(row.checksum, null);
          assert.equal(row.ingest_job_id, null);
          assert.equal(row.upload_expired_at, null);
          assert.equal(row.upload_cleaned_at, null);
          assert.equal(fixture.before.asset.current_version_id, null);
          assert.deepEqual(fixture.before.reservation, { bytes: pendingBytes.length, pending: 1 });
          assert.equal(fixture.before.audit.filter((event) => event.action === "asset.version_created").length, 1);
        }
        // Zero-byte and path-like S3 keys prove backup layout is independent of keys.
        await storageCommand(
          source,
          "const {PutObjectCommand}=await import('@aws-sdk/client-s3');await storage.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:'fixture/empty/',Body:Buffer.alloc(0),ContentType:'application/x-vardum-fixture',CacheControl:'private, max-age=30',ContentDisposition:'attachment; filename=empty.dat',ContentLanguage:'cs',ContentEncoding:'identity',Expires:new Date('2030-01-01T00:00:00Z'),Metadata:{purpose:'restore-test'}}));",
        );
        const backup = join(root, "backup");
        const backupCommand = (action, projectName) =>
          run(
            process.execPath,
            [
              "scripts/backup.mjs",
              action,
              "--compose-file",
              process.env.SMOKE_COMPOSE_FILE ?? "compose.production.yml",
              "--project",
              projectName,
              "--env-file",
              "/dev/null",
              "--directory",
              backup,
            ],
            { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
          );
        const backupStarted = Date.now();
        console.log((await backupCommand("create", source)).stdout.trim());
        const backupMs = Date.now() - backupStarted;
        const before = JSON.parse(await sql(source, queryCounts));
        const manifest = JSON.parse(
          await readFile(join(backup, "backup.json"), "utf8"),
        );
        await assertWritersStopped(source);
        for (const fixture of pendingFixtures) {
          assert.deepEqual(await pendingState(source, fixture), fixture.before, "snapshot preserves the unfinalized request without creating an ingest job");
          fixture.objectHeaders = await assertPendingObject(source, fixture, pendingBytes);
          const savedObject = manifest.objects.find((item) => item.key === fixture.storageKey);
          assert.ok(savedObject, "pending original must be present in the object backup");
          assert.equal(savedObject.size, pendingBytes.length);
          assert.equal(savedObject.sha256, fixture.intent.expectedChecksum);
          assert.deepEqual(savedObject.headers, fixture.objectHeaders, "backup preserves pending object metadata without relying on ETag or LastModified");
          assert.deepEqual(await readFile(join(backup, savedObject.file)), pendingBytes);
        }
        assert.ok(
          manifest.objects.some(
            (item) => item.key === "fixture/empty/" && item.size === 0,
          ),
        );
        await compose(source, "stop", "postgres", "rustfs");
        targetCreated = true;
        const restoreStarted = Date.now();
        await compose(
          target,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "120",
          "postgres",
          "rustfs",
        );
        await compose(target, "run", "--rm", "--no-deps", "rustfs-init");
        assert.equal(await tables(target), "0");

        const objectPath = join(
          backup,
          manifest.objects.find((item) => item.size > 0).file,
        );
        const originalBytes = await readFile(objectPath);
        await writeFile(objectPath, Buffer.alloc(originalBytes.length, 1));
        await assert.rejects(backupCommand("restore", target), /integrity/);
        assert.equal(
          await tables(target),
          "0",
          "corrupt backup must not write database state",
        );
        await writeFile(objectPath, originalBytes);
        await storageCommand(
          target,
          "const {PutObjectCommand}=await import('@aws-sdk/client-s3');await storage.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:'keep-me',Body:'unchanged'}));",
        );
        await assert.rejects(
          backupCommand("restore", target),
          /empty destination bucket/,
        );
        assert.equal(
          await tables(target),
          "0",
          "occupied bucket must be rejected before database writes",
        );
        await storageCommand(
          target,
          "const {GetObjectCommand,DeleteObjectCommand}=await import('@aws-sdk/client-s3');const object=await storage.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:'keep-me'}));if(await object.Body.transformToString()!=='unchanged')throw new Error('Existing object changed');await storage.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:'keep-me'}));",
        );

        console.log((await backupCommand("restore", target)).stdout.trim());
        assert.deepEqual(
          JSON.parse(await sql(target, queryCounts)),
          before,
          "all application table counts survive restore",
        );
        assert.equal(
          await sql(target, "SELECT count(*) FROM worker_heartbeat"),
          "0",
          "old liveness must not survive restore",
        );
        await assertWritersStopped(target);
        for (const fixture of pendingFixtures) {
          assert.deepEqual(await pendingState(target, fixture), fixture.before, "exact pending row, checksum binding, reservation and audit survive before worker startup");
          await assertPendingObject(target, fixture, pendingBytes);
        }
        console.log(JSON.stringify({
          check: "checksum-bound-pending-restore", phase: "before-worker-startup",
          versions: pendingFixtures.map((fixture) => fixture.initialVersion),
          preserved: ["exact rows", "reservations", "audits", "object bytes", "saved metadata"],
        }));
        await assert.rejects(
          backupCommand("restore", target),
          /empty destination database/,
        );
        assert.deepEqual(
          JSON.parse(await sql(target, queryCounts)),
          before,
          "existing restored database must remain untouched",
        );
        await compose(
          target,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "150",
          "api",
          "worker",
          "gateway",
        );

        if (process.env.SMOKE_SERVER_CANDIDATE)
          await assertRunningCandidate(process.env.SMOKE_SERVER_CANDIDATE, target);

        const linkedAfter = await api(`/api/workspaces/${workspaceId}/asset-uses?sourceAssetId=${assetId}`);
        assert.deepEqual(linkedAfter, linkedBefore, "linked use identity, settings and source relation survive restore");
        assert.deepEqual(Buffer.from(await (await fetch(`${base}${linkedPath}`, { headers: { cookie } })).arrayBuffer()), linkedBytes);

        // A new signature may be issued, but identity, reservation and the
        // original expiry must stay fixed. Denied content changes do no work.
        for (const fixture of pendingFixtures) {
          assert.deepEqual(await api(`${fixture.path}/${fixture.intent.id}`), fixture.initialVersion);
          const beforeReplay = await pendingState(target, fixture);
          assert.deepEqual(beforeReplay, fixture.before);
          const rejected = await apiResponse(fixture.path, {
            ...fixture.intent, expectedChecksum: checksum(changedBytes),
          });
          assert.equal(rejected.status, 409, await rejected.clone().text());
          const conflict = await rejected.json();
          assert.match(conflict.error, /different content or metadata/);
          assert.equal(conflict.upload, undefined);
          assert.deepEqual(await pendingState(target, fixture), beforeReplay, "changed-checksum replay must not alter rows, audits, reservations or counts");
          await assertPendingObject(target, fixture, pendingBytes);

          const replayed = await apiResponse(fixture.path, fixture.intent);
          assert.equal(replayed.status, 200, await replayed.clone().text());
          const { upload, ...version } = await replayed.json();
          assert.deepEqual(version, fixture.initialVersion, "same UUID replay preserves number, metadata, checksum and expiry");
          assert.equal(upload.fields.key, fixture.storageKey);
          assert.deepEqual(await pendingState(target, fixture), beforeReplay, "same UUID replay must not create another reservation, version or audit");
          fixture.resumeUpload = upload;
          fixture.replayStatus = { changedChecksum: rejected.status, sameIntent: replayed.status };
        }
        for (const fixture of pendingFixtures) {
          const bytes = fixture.outcome === "ready" ? pendingBytes : changedBytes;
          // The altered source deliberately has the same size/type. Finalize
          // admits its durable job; the worker must reject its actual SHA-256.
          await storePending(fixture, fixture.resumeUpload, bytes);
          const finalized = await apiResponse(`${fixture.path}/${fixture.intent.id}/finalize`, {});
          assert.equal(finalized.status, 202, await finalized.clone().text());
          assert.deepEqual(await finalized.json(), { id: fixture.intent.id, status: "processing" });
          const deadline = Date.now() + 60_000;
          let completed;
          do {
            completed = await api(`${fixture.path}/${fixture.intent.id}`);
            if (["ready", "failed"].includes(completed.status)) break;
            await new Promise((yes) => setTimeout(yes, 500));
          } while (Date.now() < deadline);
          assert.equal(completed.status, fixture.outcome, "restored worker resolves the exact resumed version");
          assert.equal(completed.id, fixture.intent.id);
          assert.equal(completed.expectedChecksum, fixture.intent.expectedChecksum);
          assert.equal(completed.expiresAt, fixture.initialVersion.expiresAt);
          assert.equal(completed.retryable, false);
          const after = await pendingState(target, fixture);
          assert.deepEqual(after.counts, fixture.before.counts, "resuming must not create another asset or version");
          assert.equal(after.versions.length, 1);
          const [row] = after.versions;
          assert.equal(row.status, completed.status);
          assert.equal(row.checksum, completed.checksum);
          assert.equal(row.retryable, false);
          for (const field of ["id", "workspace_id", "asset_id", "number", "storage_key", "filename", "mime_type", "size", "expected_checksum", "created_at", "created_by", "upload_expired_at", "upload_cleaned_at"])
            assert.equal(row[field], fixture.before.versions[0][field], `resumed version preserves ${field}`);
          assert.deepEqual(after.reservation, { bytes: pendingBytes.length, pending: 0 });
          const auditActions = after.audit.filter((event) => event.target_type === "asset_version").map((event) => event.action).sort();
          assert.deepEqual(
            auditActions,
            ["asset.version_created", "asset.version_queued", fixture.outcome === "ready" ? "asset.version_processed" : "asset.version_failed"].sort(),
            "same version has one creation, queue and terminal audit, with no publishing audit on checksum failure",
          );
          if (fixture.outcome === "ready") {
            assert.equal(completed.checksum, fixture.intent.expectedChecksum);
            assert.equal(completed.error, null);
            assert.equal(after.asset.current_version_id, fixture.intent.id);
            const delivered = await fetch(`${base}/w/smoke/${fixture.key}`, {
              headers: { cookie }, signal: AbortSignal.timeout(10_000),
            });
            assert.equal(delivered.status, 200);
            assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), pendingBytes);
          } else {
            assert.equal(completed.checksum, null);
            assert.match(completed.error, /uploaded bytes do not match the planned checksum/i);
            assert.equal(after.asset.current_version_id, fixture.before.asset.current_version_id);
            const blocked = await fetch(`${base}/w/smoke/__v/${fixture.intent.id}/${fixture.key}`, {
              headers: { cookie }, signal: AbortSignal.timeout(10_000),
            });
            assert.equal(blocked.status, 404, "checksum-failed bytes must not be deliverable by exact version URL");
            const retry = await apiResponse(`${fixture.path}/${fixture.intent.id}/retry`, {});
            assert.equal(retry.status, 409, await retry.clone().text());
            fixture.retryStatus = retry.status;
            assert.deepEqual(await pendingState(target, fixture), after, "checksum failure cannot be retried into a new job or version");
          }
          await assertPendingObject(target, fixture, bytes);
          // Only synthetic version state is logged: never upload forms or keys.
          console.log(JSON.stringify({
            check: "checksum-bound-pending-restore", phase: "completed",
            replayStatus: fixture.replayStatus, finalizeStatus: finalized.status,
            version: completed, auditActions, reservation: after.reservation,
            retryStatus: fixture.retryStatus,
          }));
        }
        console.log("Restored pending upload replay kept UUIDs, checksums, deadlines and reservations; original bytes became ready and altered bytes failed without publishing");

        const historyAfter = await api(
          `/api/workspaces/${workspaceId}/assets/${assetId}/versions`,
        );
        assert.deepEqual(
          historyAfter,
          historyBefore,
          "versions/current pointer and session survive restore",
        );
        assert.equal((await fetch(`${base}/w/smoke/logo`)).status, 401);
        const transformed = await fetch(new URL(signed.url, base), {
          headers: { cookie },
        });
        assert.equal(transformed.status, 200);
        assert.deepEqual(
          Buffer.from(await transformed.arrayBuffer()),
          signedBytes,
          "pre-backup signed transform still works",
        );
        assert.equal(
          (
            await fetch(`${base}/api/workspaces/${otherWorkspaceId}/assets`, {
              headers: { "x-api-key": key },
            })
          ).status,
          401,
        );
        const login = await fetch(`${base}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            email: "smoke@example.com",
            password: "password123",
          }),
        });
        assert.equal(
          login.status,
          200,
          "password login survives database restore",
        );
        await rm(join(project, "assets"), { recursive: true });
        assert.equal(
          JSON.parse((await command("pull", "--frozen")).stdout).changed,
          3,
        );
        assert.equal(
          await readFile(join(project, ".vardum.lock"), "utf8"),
          lock,
        );
        for (const [path, bytes] of files)
          assert.deepEqual(await readFile(join(project, path)), bytes);
        assert.equal(
          JSON.parse((await command("pull")).stdout).changed,
          0,
          "saved Vard is available after restore",
        );
        const deadline = Date.now() + 60_000;
        let restoredJob;
        do {
          restoredJob = await api(
            `/api/workspaces/${workspaceId}/assets/${queuedAsset.id}`,
          );
          if (restoredJob.status === "ready") break;
          await new Promise((yes) => setTimeout(yes, 500));
        } while (Date.now() < deadline);
        assert.equal(
          restoredJob.currentVersionId,
          queued.id,
          "restored queued upload finishes in the new worker",
        );
        assert.equal(restoredJob.status, "ready");
        console.log(
          `Backup/restore drill passed: ${manifest.objects.length} objects, ${manifest.objects.reduce((sum, item) => sum + item.size, 0)} object bytes; backup ${backupMs}ms, clean-stack restore and acceptance ${Date.now() - restoreStarted}ms. Auth, private delivery, signed transforms, version history, Vard, API key, installed frozen CLI, queued ingest and checksum-bound pending uploads survived.`,
        );
      },
      smokeClientOptions(),
    );
  } catch (error) {
    if (targetCreated)
      console.error(
        (
          await compose(target, "logs", "--no-color").catch(() => ({
            stdout: "",
          }))
        ).stdout,
      );
    throw error;
  } finally {
    try {
      if (targetCreated) await compose(target, "down", "-v", "--remove-orphans");
    } finally {
      // A target cleanup failure must still attempt to restart the source.
      await compose(
        source,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "120",
        "postgres",
        "rustfs",
      );
      await compose(
        source,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "150",
        "api",
        "worker",
        "gateway",
      );
    }
  }
}
