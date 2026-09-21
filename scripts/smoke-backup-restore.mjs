import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, withInstalledRelease } from "./release-packages.mjs";

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
        "compose.production.yml",
        ...args,
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
  const queryCounts = `SELECT json_build_object(${["user", "session", "account", "verification", "organization", "member", "invitation", "workspace", "workspace_settings", "asset", "asset_version", "asset_folder", "vard", "vard_item", "apikey", "audit_event", "delivery_event"].map((name) => `'${name}',(SELECT count(*) FROM "${name}")`).join(",")})`;
  const tables = (project) =>
    sql(
      project,
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'",
    );
  const api = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
          `Backup/restore drill passed: ${manifest.objects.length} objects, ${manifest.objects.reduce((sum, item) => sum + item.size, 0)} object bytes; backup ${backupMs}ms, clean-stack restore and acceptance ${Date.now() - restoreStarted}ms. Auth, private delivery, signed transforms, version history, Vard, API key, installed frozen CLI and queued ingest survived.`,
        );
      },
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
    if (targetCreated) await compose(target, "down", "-v", "--remove-orphans");
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
