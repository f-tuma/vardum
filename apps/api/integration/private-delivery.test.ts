import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const execFile = promisify(execFileCallback);
const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
const vardImportCliPath = process.env.VARDUM_TEST_CLI_PATH;

// Explicit integration command only. Never reads .env or connects to configured services.
// Requires unprivileged execution and native PostgreSQL binaries in PG_BINDIR.
test("private delivery: disposable PostgreSQL, real auth/routes, fake object HTTP, frozen CLI", {
  timeout: 180_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "varda-private-test-"));
  const data = join(root, "data");
  const pgBin = process.env.PG_BINDIR ?? "/usr/bin";
  let started = false;
  let admin: Pool | undefined;
  let closeApp: (() => Promise<unknown>) | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;
  let stopQueue: (() => Promise<unknown>) | undefined;
  let destroyStorage: (() => void) | undefined;
  const objects = new Map<string, Buffer>();
  const objectTypes = new Map<string, string>();
  let storageReads = 0;
  let storageFailure = false;
  let deleteFailure: boolean | ((key: string) => boolean) = false;
  let beforeObjectRead: (key: string) => Promise<void> = async () => {};
  let beforeObjectCopy: (key: string) => Promise<boolean> = async () => false;
  const objectServer = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://objects.invalid");
    const key = decodeURIComponent(url.pathname.replace(/^\/fixture\//, ""));
    if (req.method === "POST" && url.searchParams.has("delete")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const keys = [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map(match => match[1]!);
      res.setHeader("content-type", "application/xml");
      if (typeof deleteFailure === "function" ? keys.some(deleteFailure) : deleteFailure) return res.end(`<DeleteResult><Error><Key>${keys[0]}</Key><Code>AccessDenied</Code></Error></DeleteResult>`);
      for (const key of keys) objects.delete(key);
      return res.end("<DeleteResult/>");
    }
    if (req.method === "POST" && req.headers["content-type"]?.startsWith("multipart/form-data")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = await new Request("http://objects.invalid/fixture", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] },
        body: Buffer.concat(chunks),
      }).formData();
      const uploadKey = form.get("key");
      const file = form.get("file");
      if (typeof uploadKey !== "string" || !file || typeof file === "string") {
        res.statusCode = 400;
        return res.end("Invalid fixture upload");
      }
      objects.set(uploadKey, Buffer.from(await file.arrayBuffer()));
      objectTypes.set(uploadKey, String(form.get("Content-Type") ?? file.type));
      res.statusCode = 204;
      return res.end();
    }
    if (url.searchParams.has("list-type")) {
      res.setHeader("content-type", "application/xml");
      return res.end(
        "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>incoming/import.png</Key><Size>4</Size></Contents></ListBucketResult>",
      );
    }
    if (req.method === "PUT") {
      const source = req.headers["x-amz-copy-source"];
      if (source) {
        if (await beforeObjectCopy(key)) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/xml");
          return res.end("<Error><Code>AccessDenied</Code></Error>");
        }
        objects.set(key, Buffer.from("copy"));
        res.setHeader("content-type", "application/xml");
        return res.end(
          '<CopyObjectResult><ETag>"copy"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></CopyObjectResult>',
        );
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      if (req.headers["content-type"]) objectTypes.set(key, req.headers["content-type"]);
      return res.end();
    }
    storageReads++;
    await beforeObjectRead(key);
    if (storageFailure) {
      res.statusCode = 503;
      return res.end();
    }
    const bytes = objects.get(key);
    if (!bytes) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/xml");
      return res.end("<Error><Code>NoSuchKey</Code></Error>");
    }
    let body = bytes;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)!;
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : bytes.length - 1;
      body = bytes.subarray(start, end + 1);
      res.statusCode = 206;
      res.setHeader("content-range", `bytes ${start}-${end}/${bytes.length}`);
    }
    res.setHeader("content-type", objectTypes.get(key) ?? "application/octet-stream");
    res.setHeader("content-length", body.length);
    res.setHeader("etag", '"fixture"');
    res.end(body);
  });
  t.after(async () => {
    await closeApp?.();
    await stopQueue?.();
    destroyStorage?.();
    await closeDatabase?.();
    await admin?.end();
    await new Promise<void>((resolve) => objectServer.close(() => resolve()));
    if (started)
      await execFile(join(pgBin, "pg_ctl"), [
        "-D",
        data,
        "-m",
        "fast",
        "-w",
        "stop",
      ]);
    await rm(root, { recursive: true, force: true });
    console.log(`Cleaned disposable cluster and fixtures: ${root}`);
  });
  const cleanEnv = { PATH: process.env.PATH, LANG: "C" };
  await execFile(
    join(pgBin, "initdb"),
    ["-D", data, "-A", "trust", "-U", "postgres", "--no-locale"],
    { env: cleanEnv },
  );
  await execFile(
    join(pgBin, "pg_ctl"),
    [
      "-D",
      data,
      "-l",
      join(root, "postgres.log"),
      "-o",
      `-k ${root} -c listen_addresses=''`,
      "-w",
      "start",
    ],
    { env: cleanEnv },
  );
  started = true;
  const connection = (user: string) =>
    `postgresql://${user}@localhost/postgres?host=${encodeURIComponent(root)}`;
  admin = new Pool({ connectionString: connection("postgres") });
  const sql = (text: string, values: unknown[] = []) =>
    admin!.query(text, values);
  await new Promise<void>((resolve) =>
    objectServer.listen(0, "127.0.0.1", resolve),
  );
  const objectAddress = objectServer.address();
  assert.ok(objectAddress && typeof objectAddress !== "string");
  // Replace, rather than merge, ambient configuration before importing application modules.
  process.env = {
    ...cleanEnv,
    NODE_ENV: "test",
    // The auth matrix deliberately exceeds production traffic budgets. Admission has dedicated tests.
    DELIVERY_REQUESTS_PER_SECOND: "10000",
    DATABASE_URL: connection("varda_app"),
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "isolated-test-auth-secret-at-least-32-characters",
    TRANSFORM_SECRET: "isolated-test-transform-secret-at-least-32-characters",
    S3_ENDPOINT: `http://127.0.0.1:${objectAddress.port}`,
    S3_BUCKET: "fixture",
    S3_ACCESS_KEY_ID: "fixture",
    S3_SECRET_ACCESS_KEY: "fixture",
    S3_FORCE_PATH_STYLE: "true",
    AWS_EC2_METADATA_DISABLED: "true",
  };
  const oldId = randomUUID();
  const oldVardId = randomUUID();
  const migratedKey = "varda_migrated-disposable-key-for-private-downloads";
  const bulkKeys: Array<{ name: string; key: string }> = [
    { name: "migrated", key: migratedKey },
  ];
  const bulkAssets: string[] = [];
  await t.test(
    "migration preserves old public rows, defaults new private, and migrator reruns safely",
    async () => {
      const previous = join(root, "previous");
      await cp(migrations, previous, { recursive: true });
      const journalPath = join(previous, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.entries = journal.entries.slice(0, 9);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(admin!), { migrationsFolder: previous });
      await sql(
        "INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',now()),('other','Other','other',now())",
      );
      await sql(
        "INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ('ws','org','Workspace','demo','fixture','fixture'),('other-ws','other','Other','other','fixture','fixture')",
      );
      await sql(
        "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws','old.png','Old','fixture','fixture')",
        [oldId],
      );
      await sql(
        "INSERT INTO vard(id,workspace_id,name,is_public,created_by,updated_by) VALUES ($1,'ws','Pre-folder Vard',true,'fixture','fixture')",
        [oldVardId],
      );
      await sql(
        "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,writable,created_by,updated_by) VALUES ('ws',$1,$2,'old.png',true,'fixture','fixture')",
        [oldVardId, oldId],
      );
      const oldVard = (await sql("SELECT * FROM vard WHERE id=$1", [oldVardId]))
        .rows[0];
      const oldItems = (
        await sql("SELECT * FROM vard_item WHERE vard_id=$1", [oldVardId])
      ).rows;
      const { defaultKeyHasher } = await import("@better-auth/api-key");
      for (const [id, enabled, limited, max, window, config] of [
        ["migrated", true, true, 10, 86400000, "workspace"],
        ["disabled-key", false, true, 10, 86400000, "workspace"],
        ["disabled-limit", true, false, 10, 86400000, "workspace"],
        ["custom-max", true, true, 5, 86400000, "workspace"],
        ["custom-window", true, true, 10, 60000, "workspace"],
        ["other-config", true, true, 10, 86400000, "other"],
      ]) {
        await sql(
          "INSERT INTO apikey(id,key,reference_id,config_id,enabled,rate_limit_enabled,rate_limit_max,rate_limit_time_window,request_count,last_request,expires_at,permissions,created_at,updated_at) VALUES ($1,$2,'ws',$3,$4,$5,$6,$7,3,now(),now()+interval '1 day',$8,now(),now())",
          [
            id,
            await defaultKeyHasher(
              id === "migrated" ? migratedKey : `fixture-${id}`,
            ),
            config,
            enabled,
            limited,
            max,
            window,
            JSON.stringify({ asset: ["read"] }),
          ],
        );
      }
      const beforeKeys = (await sql("SELECT * FROM apikey ORDER BY id")).rows;
      await migrate(drizzle(admin!), { migrationsFolder: migrations });
      assert.deepEqual(
        (await sql("SELECT * FROM vard WHERE id=$1", [oldVardId])).rows[0],
        {
          ...oldVard,
          folder_rules: [],
        },
      );
      assert.deepEqual(
        (await sql("SELECT * FROM vard_item WHERE vard_id=$1", [oldVardId]))
          .rows,
        oldItems,
      );
      const afterKeys = (await sql("SELECT * FROM apikey ORDER BY id")).rows;
      assert.deepEqual(
        afterKeys,
        beforeKeys.map((key) =>
          key.id === "migrated"
            ? { ...key, rate_limit_max: 10000, rate_limit_time_window: 60000 }
            : key,
        ),
        "only matching enabled historical defaults change; custom/disabled limits, key state and counters stay intact",
      );
      assert.equal(
        (await sql("SELECT is_public FROM asset WHERE id=$1", [oldId])).rows[0]
          .is_public,
        true,
      );
      const row = await sql(
        "INSERT INTO asset(workspace_id,key,display_name,created_by,updated_by) VALUES ('ws','default.png','Default','fixture','fixture') RETURNING is_public",
      );
      assert.equal(row.rows[0].is_public, false);
      await migrate(drizzle(admin!), { migrationsFolder: migrations });
      assert.equal(
        (
          await sql(
            "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
          )
        ).rows[0].count,
        JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8")).entries.length,
      );
      await assert.rejects(
        sql(
          await readFile(join(migrations, "0009_asset_visibility.sql"), "utf8"),
        ),
        /already exists/,
      );
      assert.equal(
        (await sql("SELECT is_public FROM asset WHERE key='default.png'"))
          .rows[0].is_public,
        false,
      );
      console.log(
        "Forward migration and tracked rerun passed; raw SQL rerun fails without changing visibility.",
      );
    },
  );
  const { migrateQueue } = await import("../src/queue-migrate.js");
  const { provisionRuntimeRole, assertRuntimeDatabaseRole } = await import("../src/db/runtime-role.js");
  await migrateQueue(connection("postgres"));
  await provisionRuntimeRole(admin!, "isolated-private-test-runtime-password");
  const { buildApp } = await import("../src/app.js");
  const database = await import("../src/db/index.js");
  closeDatabase = database.closeDatabase;
  await assertRuntimeDatabaseRole(database.pool);
  const queue = await import("../src/queue.js");
  stopQueue = queue.stopQueue;
  await queue.startQueue();
  const { storage } = await import("../src/storage.js");
  destroyStorage = () => storage.destroy();
  const { transformedVersionUrl } = await import("../src/transformation.js");
  const app = await buildApp();
  closeApp = () => app.close();
  assert.equal(
    (await database.pool.query("select * from asset")).rowCount,
    0,
    "real app connection cannot bypass tenant RLS",
  );

  await t.test("image pipeline under the production database role", async (imageTest) => {
    const { checkImagePipeline } = await import("./image-pipeline.fixture.js");
    await checkImagePipeline(imageTest, admin!, objects);
  });

  const cookies: Record<string, string> = {};
  await t.test(
    "real signed sessions for owner, editor, viewer and unrelated member",
    async () => {
      for (const role of ["owner", "editor", "viewer", "outsider"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/sign-up/email",
          payload: {
            name: role,
            email: `${role}@example.test`,
            password: "disposable-password-123",
          },
        });
        assert.equal(response.statusCode, 200, response.body);
        cookies[role] = response.cookies
          .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
          .join("; ");
        const userId = response.json().user.id;
        await sql(
          "INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ($1,$2,$3,$4,now())",
          [
            randomUUID(),
            role === "outsider" ? "other" : "org",
            userId,
            role === "outsider" ? "owner" : role,
          ],
        );
      }
    },
  );
  const keyHeaders: Record<string, Record<string, string>> = {};
  await t.test(
    "workspace-scoped read, write, insufficient and revoked keys",
    async () => {
      for (const [name, space, access, role] of [
        ["read", "ws", "read", "owner"],
        ["write", "ws", "write", "owner"],
        ["other", "other-ws", "read", "outsider"],
        ["insufficient", "ws", "write", "owner"],
        ["revoked", "ws", "read", "owner"],
      ]) {
        const result = await app.inject({
          method: "POST",
          url: `/api/workspaces/${space}/api-keys`,
          headers: { cookie: cookies[role!]! },
          payload: { name, access },
        });
        assert.equal(result.statusCode, 200, result.body);
        keyHeaders[name!] = { "x-api-key": result.json().key };
        // Keep the stress matrix independent from the finite production allowance.
        // Default issuance and migrated keys are tested without this fixture bypass below.
        await sql("UPDATE apikey SET rate_limit_enabled=false WHERE id=$1", [
          result.json().id,
        ]);
        if (name === "insufficient")
          await sql("UPDATE apikey SET permissions=$1 WHERE id=$2", [
            JSON.stringify({ asset: ["publish"] }),
            result.json().id,
          ]);
        if (name === "revoked")
          await sql("UPDATE apikey SET enabled=false WHERE id=$1", [
            result.json().id,
          ]);
      }
    },
  );
  const versionId = randomUUID();
  const privateId = randomUUID();
  const publicVersion = randomUUID();
  const historicalVersion = randomUUID();
  const privateKey = "brand/secret.svg";
  const bytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
  );
  objects.set("private-source", bytes);
  objects.set("public-source", bytes);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await sql(
    "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws',$2,'Secret','fixture','fixture')",
    [privateId, privateKey],
  );
  for (const [id, assetId, storageKey] of [
    [versionId, privateId, "private-source"],
    [publicVersion, oldId, "public-source"],
  ]) {
    await sql(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1,'ws',$2,1,'ready',$3,'secret.svg','image/svg+xml',$4,$5,'fixture','fixture')",
      [id, assetId, storageKey, bytes.length, checksum],
    );
    await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
      id,
      assetId,
    ]);
  }
  await sql(
    "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1,'ws',$2,2,'ready','historical-source','old.svg','image/svg+xml',$3,$4,'fixture','fixture')",
    [historicalVersion, privateId, bytes.length, checksum],
  );
  objects.set("historical-source", bytes);
  await sql(
    "INSERT INTO workspace_settings(workspace_id,custom_domain,custom_domain_verified_at,created_by,updated_by) VALUES ('ws','cdn.example.test',now(),'fixture','fixture')",
  );
  const immutable = `/w/demo/__v/${versionId}/${privateKey}`;
  const signed = transformedVersionUrl("demo", privateKey, versionId, {
    w: 8,
    format: "png",
  });
  const shapes = [
    { url: immutable, status: 200 },
    { url: immutable.replace(versionId, historicalVersion), status: 200 },
    { url: `/w/demo/${privateKey}`, status: 302 },
    {
      url: `/w/__v/${versionId}/${privateKey}`,
      host: "cdn.example.test",
      status: 200,
    },
    { url: `/w/${privateKey}`, host: "cdn.example.test", status: 302 },
    { url: `/assets/demo/${privateKey}`, status: 308 },
    { url: signed, status: 200 },
    { url: signed.replace(`/__v/${versionId}`, ""), status: 302 },
    {
      url: signed.replace("/w/demo/__v/", "/w/__v/"),
      host: "cdn.example.test",
      status: 200,
    },
    {
      url: signed.replace(`/demo/__v/${versionId}`, ""),
      host: "cdn.example.test",
      status: 302,
    },
    { url: immutable.replace("/w/", "/assets/"), status: 308 },
    { url: signed.replace("/w/", "/assets/"), status: 308 },
  ];
  const principals = [
    { name: "anonymous", headers: {}, status: 401 },
    ...["owner", "editor", "viewer"].map((role) => ({
      name: role,
      headers: { cookie: cookies[role]! },
      status: 200,
    })),
    { name: "outsider", headers: { cookie: cookies.outsider! }, status: 403 },
    ...Object.entries(keyHeaders).map(([name, headers]) => ({
      name,
      headers,
      status: ["read", "write"].includes(name) ? 200 : 401,
    })),
  ];
  function privateHeaders(response: Awaited<ReturnType<typeof app.inject>>) {
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(
      response.headers["cross-origin-resource-policy"],
      "same-origin",
    );
    assert.match(String(response.headers.vary), /Cookie/);
    assert.match(String(response.headers.vary), /X-API-Key/);
  }
  await t.test(
    "all route shapes, HEAD and ranges gate storage and redirect metadata with real auth",
    async () => {
      for (const shape of shapes)
        for (const principal of principals)
          for (const method of ["GET", "HEAD"] as const)
            for (const range of [undefined, "bytes=0-3"]) {
              const before = storageReads;
              const response = await app.inject({
                method,
                url: shape.url,
                headers: {
                  ...principal.headers,
                  ...(shape.host ? { host: shape.host } : {}),
                  ...(range ? { range } : {}),
                  origin: "https://untrusted.example",
                },
              });
              const expected =
                principal.status === 200
                  ? shape.status === 200 && range && !shape.url.includes("sig=")
                    ? 206
                    : shape.status
                  : principal.status;
              assert.equal(
                response.statusCode,
                expected,
                `${principal.name} ${method} ${shape.url} ${range}: ${response.body}`,
              );
              privateHeaders(response);
              if (principal.status !== 200) {
                assert.equal(
                  storageReads,
                  before,
                  "denied requests never read originals or variants",
                );
                assert.equal(response.headers.location, undefined);
                assert.equal(response.headers.etag, undefined);
                assert.equal(
                  response.headers["content-disposition"],
                  undefined,
                );
                assert.equal(response.body.includes(privateKey), false);
                assert.equal(response.body.includes(versionId), false);
              }
              if (method === "HEAD") assert.equal(response.body, "");
            }
    },
  );
  await t.test(
    "custom root key, unverified hosts, signed custom variants, and public cache compatibility",
    async () => {
      await sql("UPDATE asset SET key='secret.svg' WHERE id=$1", [privateId]);
      for (const headers of [{}, keyHeaders.read!]) {
        const response = await app.inject({
          url: "/w/secret.svg",
          headers: { host: "cdn.example.test", ...headers },
        });
        assert.equal(response.statusCode, "x-api-key" in headers ? 302 : 401);
        privateHeaders(response);
      }
      await sql("UPDATE asset SET key=$1 WHERE id=$2", [privateKey, privateId]);
      const customSigned = signed.replace("/w/demo/__v/", "/w/__v/");
      assert.equal(
        (
          await app.inject({
            url: customSigned,
            headers: { host: "cdn.example.test" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: customSigned,
            headers: { host: "cdn.example.test", ...keyHeaders.read },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            url: customSigned,
            headers: { host: "unverified.example.test", ...keyHeaders.read },
          })
        ).statusCode,
        404,
      );
      const tampered = await app.inject({
        url: signed.replace("w=8", "w=9"),
        headers: keyHeaders.read,
      });
      assert.equal(tampered.statusCode, 403);
      privateHeaders(tampered);
      for (const method of ["GET", "HEAD"] as const) {
        const response = await app.inject({
          method,
          url: `/w/demo/__v/${publicVersion}/old.png`,
        });
        assert.equal(response.statusCode, 200);
        assert.equal(
          response.headers["cache-control"],
          "public, max-age=31536000, immutable",
        );
        assert.equal(response.headers["access-control-allow-origin"], "*");
        assert.equal(
          response.headers["cross-origin-resource-policy"],
          "cross-origin",
        );
      }
      const stable = await app.inject({ url: "/w/demo/old.png" });
      assert.equal(stable.statusCode, 302);
      assert.match(String(stable.headers["cache-control"]), /^public/);
      const legacy = await app.inject({ url: "/assets/demo/old.png" });
      assert.equal(legacy.statusCode, 308);
      assert.equal(legacy.headers.location, "/w/demo/old.png");
    },
  );
  await t.test(
    "private image/video previews and transform links use app origin; public uses verified domain",
    async () => {
      for (const mime of ["image/svg+xml", "video/mp4"]) {
        await sql("UPDATE asset_version SET mime_type=$1 WHERE id=$2", [
          mime,
          versionId,
        ]);
        const detail = await app.inject({
          url: `/api/workspaces/ws/assets/${privateId}`,
          headers: { cookie: cookies.viewer! },
        });
        assert.equal(detail.statusCode, 200, detail.body);
        assert.equal(detail.json().isPublic, false);
        assert.match(detail.json().thumbnailUrl, /^\/w\/demo\//);
        const preview = await app.inject({
          url: detail.json().thumbnailUrl,
          headers: { cookie: cookies.viewer! },
        });
        assert.equal(preview.statusCode, mime.startsWith("video") ? 302 : 200);
        const content = mime.startsWith("video") ? await app.inject({
          url: preview.headers.location!,
          headers: { cookie: cookies.viewer! },
          ...(mime.startsWith("video") ? { method: "GET" as const } : {}),
        }) : preview;
        assert.equal(content.statusCode, 200);
        privateHeaders(content);
        if (mime.startsWith("video")) {
          assert.match(
            String(content.headers["content-security-policy"]),
            /sandbox allow-same-origin/,
          );
          const range = await app.inject({
            url: preview.headers.location!,
            headers: { cookie: cookies.viewer!, range: "bytes=0-3" },
          });
          assert.equal(range.statusCode, 206);
          privateHeaders(range);
        }
      }
      await sql(
        "UPDATE asset_version SET mime_type='image/svg+xml' WHERE id=$1",
        [versionId],
      );
      const generated = await app.inject({
        method: "POST",
        url: `/api/workspaces/ws/assets/${privateId}/transform-url`,
        payload: { w: 8 },
        headers: keyHeaders.read,
      });
      assert.match(generated.json().url, /^\/w\/demo\//);
      const publicDetail = await app.inject({
        url: `/api/workspaces/ws/assets/${oldId}`,
        headers: keyHeaders.read,
      });
      assert.match(
        publicDetail.json().thumbnailUrl,
        /^https:\/\/cdn.example.test\//,
      );
      const listing = await app.inject({
        url: "/api/workspaces/ws/assets?prefix=brand/",
        headers: keyHeaders.read,
      });
      assert.equal(listing.json().assets[0].isPublic, false);
      assert.match(listing.json().assets[0].thumbnailUrl, /^\/w\/demo\//);
    },
  );
  await t.test(
    "new API and CLI read keys and a migrated key download twelve private assets with finite rate limiting",
    async () => {
      for (const [name, endpoint, payload] of [
        ["api-default", "api-keys", { name: "default-bulk", access: "read" }],
        ["cli-default", "cli-keys", { label: "default-bulk", access: "read" }],
      ] as const) {
        const issued = await app.inject({
          method: "POST",
          url: `/api/workspaces/ws/${endpoint}`,
          headers: { cookie: cookies.owner! },
          payload,
        });
        assert.equal(issued.statusCode, 200, issued.body);
        const policy = (
          await sql(
            "SELECT rate_limit_enabled,rate_limit_max,rate_limit_time_window FROM apikey WHERE id=$1",
            [issued.json().id],
          )
        ).rows[0];
        assert.deepEqual(policy, {
          rate_limit_enabled: true,
          rate_limit_max: 10000,
          rate_limit_time_window: 60000,
        });
        bulkKeys.push({ name, key: issued.json().key });
      }
      const urls: string[] = [];
      for (let index = 0; index < 12; index++) {
        const id = randomUUID();
        const version = randomUUID();
        const key = `bulk-${index}.svg`;
        const storageKey = `bulk-${index}`;
        objects.set(storageKey, bytes);
        await sql(
          "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws',$2,'Bulk','fixture','fixture')",
          [id, key],
        );
        await sql(
          "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1,'ws',$2,1,'ready',$3,'bulk.svg','image/svg+xml',$4,$5,'fixture','fixture')",
          [version, id, storageKey, bytes.length, checksum],
        );
        await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
          version,
          id,
        ]);
        bulkAssets.push(id);
        urls.push(`/w/demo/__v/${version}/${key}`);
      }
      for (const key of bulkKeys) {
        const results = [];
        for (const url of urls)
          results.push(
            (await app.inject({ url, headers: { "x-api-key": key.key } }))
              .statusCode,
          );
        console.log(
          `${key.name} finite default allowance: twelve delivery statuses ${results.join(",")}`,
        );
        assert.deepEqual(results, Array(12).fill(200));
      }
    },
  );
  const visibilityPath = `/api/workspaces/ws/assets/${privateId}/visibility`;
  await t.test(
    "visibility is validated, publish-authorized, tenant-scoped, audited, and version/checksum stable",
    async () => {
      for (const payload of [
        { isPublic: "true" },
        {},
        { isPublic: true, ignored: true },
      ]) {
        assert.equal(
          (
            await app.inject({
              method: "PATCH",
              url: visibilityPath,
              payload,
              headers: keyHeaders.write,
            })
          ).statusCode,
          400,
        );
      }
      for (const principal of principals.filter(
        (p) => !["owner", "editor", "write", "insufficient"].includes(p.name),
      )) {
        const response = await app.inject({
          method: "PATCH",
          url: visibilityPath,
          payload: { isPublic: true },
          headers: principal.headers,
        });
        assert.ok(
          [401, 403].includes(response.statusCode),
          `${principal.name}: ${response.body}`,
        );
      }
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: visibilityPath.replace("/ws/", "/other-ws/"),
            payload: { isPublic: true },
            headers: { cookie: cookies.outsider! },
          })
        ).statusCode,
        404,
      );
      for (const [isPublic, headers] of [
        [true, { cookie: cookies.editor! }],
        [false, keyHeaders.write],
      ] as const) {
        const response = await app.inject({
          method: "PATCH",
          url: visibilityPath,
          payload: { isPublic },
          headers,
        });
        assert.equal(response.statusCode, 200, response.body);
        const listing = await app.inject({
          url: "/api/workspaces/ws/sync/assets",
          headers: keyHeaders.read,
        });
        assert.equal(listing.statusCode, 200);
        assert.equal(
          listing
            .json()
            .assets.find((item: { id: string }) => item.id === privateId)
            .isPublic,
          isPublic,
          "sync clients must receive the current visibility",
        );
        assert.equal(
          (await app.inject({ url: immutable })).statusCode,
          isPublic ? 200 : 401,
        );
        assert.equal(
          (await app.inject({ url: signed })).statusCode,
          isPublic ? 200 : 401,
        );
      }
      const events = (
        await sql(
          "SELECT * FROM audit_event WHERE target_id=$1 AND action='asset.visibility_updated' ORDER BY created_at",
          [privateId],
        )
      ).rows;
      assert.equal(events.length, 2);
      assert.deepEqual(
        events.map((e) => e.metadata),
        [
          { previousIsPublic: false, isPublic: true },
          { previousIsPublic: true, isPublic: false },
        ],
      );
      assert.deepEqual(
        events.map((e) => e.actor_type),
        ["user", "api_key"],
      );
      assert.ok(events.every((e) => e.workspace_id === "ws" && e.request_id));
      const unchanged = (
        await sql(
          "SELECT a.current_version_id,v.checksum FROM asset a JOIN asset_version v ON v.id=a.current_version_id WHERE a.id=$1",
          [privateId],
        )
      ).rows[0];
      assert.deepEqual(unchanged, { current_version_id: versionId, checksum });
    },
  );
  await t.test(
    "previously valid keys are checked again after revocation and unready versions stay unavailable",
    async () => {
      const issued = await app.inject({
        method: "POST",
        url: "/api/workspaces/ws/api-keys",
        headers: { cookie: cookies.owner! },
        payload: { name: "revocation", access: "read" },
      });
      assert.equal(issued.statusCode, 200);
      const headers = { "x-api-key": issued.json().key };
      assert.equal(
        (await app.inject({ url: signed, headers })).statusCode,
        200,
      );
      await sql("UPDATE apikey SET enabled=false WHERE id=$1", [
        issued.json().id,
      ]);
      const reads = storageReads;
      const denied = await app.inject({ url: signed, headers });
      assert.equal(denied.statusCode, 401);
      assert.equal(storageReads, reads);
      privateHeaders(denied);
      await sql("UPDATE asset_version SET status='processing' WHERE id=$1", [
        historicalVersion,
      ]);
      const unready = await app.inject({
        url: immutable.replace(versionId, historicalVersion),
        headers: keyHeaders.read,
      });
      assert.equal(unready.statusCode, 404);
      assert.equal(storageReads, reads);
      privateHeaders(unready);
    },
  );
  await t.test(
    "creation and bucket import are private even when callers supply isPublic",
    async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces/ws/assets",
        headers: keyHeaders.write,
        payload: { key: "new.png", displayName: "New", isPublic: true },
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(
        (
          await sql("SELECT is_public FROM asset WHERE id=$1", [
            created.json().id,
          ])
        ).rows[0].is_public,
        false,
      );
      const imported = await app.inject({
        method: "POST",
        url: "/api/workspaces/ws/imports",
        headers: keyHeaders.write,
        payload: { source: "incoming/" },
      });
      assert.equal(imported.statusCode, 200, imported.body);
      assert.equal(imported.json().imported, 1);
      assert.equal(
        (await sql("SELECT is_public FROM asset WHERE key='import.png'"))
          .rows[0].is_public,
        false,
      );
    },
  );
  const vardId = randomUUID();
  await sql(
    "INSERT INTO vard(id,workspace_id,name,is_public,created_by,updated_by) VALUES ($1,'ws','Mixed',true,'fixture','fixture')",
    [vardId],
  );
  for (const [assetId, path] of [
    [oldId, "assets/public.svg"],
    [privateId, "assets/secret.svg"],
  ]) {
    await sql(
      "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) VALUES ('ws',$1,$2,$3,'fixture','fixture')",
      [vardId, assetId, path],
    );
  }
  await t.test(
    "mixed public Vard fails entirely closed anonymously, authenticated manifests remain usable and no-store",
    async () => {
      for (const headers of [
        {},
        { cookie: cookies.outsider! },
        keyHeaders.other!,
        keyHeaders.revoked!,
        keyHeaders.insufficient!,
      ]) {
        const response = await app.inject({ url: `/v/${vardId}`, headers });
        assert.equal(response.statusCode, 404, response.body);
        assert.deepEqual(response.json(), { error: "Vard not found" });
        assert.equal(response.headers["cache-control"], "private, no-store");
      }
      for (const url of [
        `/v/${vardId}`,
        `/api/workspaces/ws/vards/${vardId}`,
        `/api/workspaces/ws/vards/${vardId}/manifest`,
      ]) {
        const response = await app.inject({ url, headers: keyHeaders.read });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().items.length, 2);
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.equal(
          response.json().items.find((item: any) => item.assetId === privateId)
            .downloadUrl,
          immutable,
        );
      }
      await app.inject({
        method: "PATCH",
        url: visibilityPath,
        payload: { isPublic: true },
        headers: keyHeaders.write,
      });
      const publicManifest = await app.inject({ url: `/v/${vardId}` });
      assert.equal(publicManifest.statusCode, 200);
      assert.equal(publicManifest.json().items.length, 2);
      assert.equal(
        publicManifest.headers["cache-control"],
        "private, no-store",
      );
      await app.inject({
        method: "PATCH",
        url: visibilityPath,
        payload: { isPublic: false },
        headers: keyHeaders.write,
      });
      assert.equal((await app.inject({ url: `/v/${vardId}` })).statusCode, 404);
    },
  );
  await t.test(
    "storage errors and validation failures never become public cache entries",
    async () => {
      storageFailure = true;
      try {
        for (const url of [immutable, `/w/demo/__v/${publicVersion}/old.png`]) {
          const response = await app.inject({ url, headers: keyHeaders.read });
          assert.equal(response.statusCode, 502);
          privateHeaders(response);
        }
      } finally {
        storageFailure = false;
      }
      const response = await app.inject({
        url: "/w/demo/__v/not-a-uuid/secret",
      });
      assert.equal(response.statusCode, 400);
      privateHeaders(response);
    },
  );
  // Folder scenarios share the real authorization, RLS and storage fixture above.
  const folderBase = "/api/workspaces/ws/vards";
  async function folderAsset(
    key: string,
    options: {
      workspace?: string;
      isPublic?: boolean;
      status?: string;
      bytes?: Buffer;
    } = {},
  ) {
    const id = randomUUID();
    const version = randomUUID();
    const space = options.workspace ?? "ws";
    const content = options.bytes ?? bytes;
    objects.set(version, content);
    await sql(
      "INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) VALUES ($1,$2,$3,'Folder fixture',$4,'fixture','fixture')",
      [id, space, key, options.isPublic ?? true],
    );
    await sql(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1::uuid,$2,$3,1,$4,$1::text,'folder.svg','image/svg+xml',$5,$6,'fixture','fixture')",
      [
        version,
        space,
        id,
        options.status ?? "ready",
        content.length,
        createHash("sha256").update(content).digest("hex"),
      ],
    );
    await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
      version,
      id,
    ]);
    return { id, version, key };
  }
  async function createFolderVard(
    name: string,
    folderRules: Array<{ sourcePrefix: string; outputPrefix: string }>,
    isPublic = true,
  ) {
    const response = await app.inject({
      method: "POST",
      url: folderBase,
      headers: keyHeaders.write,
      payload: { name, isPublic, folderRules },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json().folderRules, folderRules);
    return response.json().id as string;
  }
  const folderGet = (id: string, manifest = false) =>
    app.inject({
      url: `${folderBase}/${id}${manifest ? "/manifest" : ""}`,
      headers: keyHeaders.read,
    });
  await t.test("folder originals infer suffixes for extensionless keys and retain legacy suffixes", async (subtest) => {
    const assets: string[] = [];
    subtest.after(async () => {
      await sql("DELETE FROM asset WHERE workspace_id='ws' AND id=ANY($1::uuid[])", [assets]);
    });
    assets.push((await folderAsset("stem-outputs/logo.v2")).id);
    assets.push((await folderAsset("stem-outputs/nested/icon")).id);
    assets.push((await folderAsset("stem-outputs/legacy.svg")).id);
    const id = await createFolderVard("Stem outputs", [{ sourcePrefix: "stem-outputs/", outputPrefix: "images/" }]);
    const manifest = await folderGet(id, true);
    assert.equal(manifest.statusCode, 200, manifest.body);
    assert.deepEqual(manifest.json().items.map((item: { outputPath: string }) => item.outputPath).sort(),
      ["images/legacy.svg", "images/logo.v2.svg", "images/nested/icon.svg"]);
    assert.ok(manifest.json().items.every((item: { sourceMimeType: string }) => item.sourceMimeType === "image/svg+xml"));
    assets.push((await folderAsset("stem-outputs/logo.v2.svg")).id);
    const collision = await folderGet(id, true);
    assert.equal(collision.statusCode, 409, collision.body);
  });

  async function setRules(
    id: string,
    folderRules: Array<{ sourcePrefix: string; outputPrefix: string }>,
  ) {
    const response = await app.inject({
      method: "PATCH",
      url: `${folderBase}/${id}`,
      headers: keyHeaders.write,
      payload: { folderRules },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response;
  }
  await t.test(
    "folder configuration validates create/PATCH, preserves omitted fields/manual IDs and audits authorized updates",
    async () => {
      const rules = [{ sourcePrefix: "future/", outputPrefix: "assets/" }];
      const id = await createFolderVard("Folder config", rules);
      const defaults = await app.inject({
        method: "POST",
        url: folderBase,
        headers: keyHeaders.write,
        payload: { name: "Folder defaults" },
      });
      assert.equal(defaults.statusCode, 201);
      assert.deepEqual(defaults.json().folderRules, []);
      assert.equal(defaults.json().isPublic, false);
      const put = await app.inject({
        method: "PUT",
        url: `${folderBase}/${id}/items`,
        headers: keyHeaders.write,
        payload: {
          items: [
            { assetId: oldId, outputPath: "manual.svg", writable: true },
            {
              assetId: privateId,
              versionId,
              outputPath: "pinned.png",
              transformation: { w: 8, format: "png" },
            },
          ],
        },
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.deepEqual(put.json().folderRules, rules);
      const manual = put.json().items;
      for (const payload of [
        { name: "Renamed folder config" },
        { folderRules: rules },
        { isPublic: true },
      ]) {
        const response = await app.inject({
          method: "PATCH",
          url: `${folderBase}/${id}`,
          headers: keyHeaders.write,
          payload,
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().isPublic, true);
        assert.deepEqual(response.json().folderRules, rules);
      }
      const config = await folderGet(id);
      assert.deepEqual(config.json().items, manual);
      assert.equal(manual[0].writable, true);
      assert.equal(manual[1].pinned, true);
      assert.deepEqual(manual[1].transformation, { w: 8, format: "png" });
      for (const headers of [
        keyHeaders.read!,
        keyHeaders.other!,
        { cookie: cookies.viewer! },
        { cookie: cookies.outsider! },
        {},
      ]) {
        for (const [method, url, payload] of [
          ["PATCH", `${folderBase}/${id}`, { folderRules: [] }],
          ["POST", folderBase, { name: "Denied", folderRules: [] }],
        ] as const) {
          const denied = await app.inject({ method, url, headers, payload });
          assert.ok([401, 403].includes(denied.statusCode), denied.body);
        }
      }
      assert.deepEqual((await folderGet(id)).json().folderRules, rules);
      for (const payload of [
        {},
        { folderRules: null },
        { folderRules: [{ sourcePrefix: "future", outputPrefix: "" }] },
        { folderRules: Array.from({ length: 65 }, () => rules[0]) },
        { folderRules: [{ ...rules[0], transformation: {} }] },
      ]) {
        const invalid = await app.inject({
          method: "PATCH",
          url: `${folderBase}/${id}`,
          headers: keyHeaders.write,
          payload,
        });
        assert.equal(invalid.statusCode, 400, invalid.body);
      }
      const audit = (
        await sql(
          "SELECT action,metadata FROM audit_event WHERE target_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows;
      assert.deepEqual(audit[0].metadata.folderRules, rules);
      assert.deepEqual(
        audit.find(
          (row) => row.action === "vard.updated" && row.metadata.folderRules,
        )?.metadata.folderRules,
        rules,
      );
      const renamed = audit.find(
        (row) => row.metadata.name === "Renamed folder config",
      );
      assert.deepEqual(
        renamed.metadata,
        { name: "Renamed folder config" },
        "PATCH audit must not contain default resets",
      );
    },
  );

  await t.test(
    "literal recursive/root/empty inclusion is workspace-bound and ready-current only; generated IDs survive rule reorder and version/sibling changes",
    async () => {
      const first = await folderAsset("folder_one/a.svg");
      const nested = await folderAsset("folder_one/nested/b.svg");
      await folderAsset("folderxone/no.svg");
      await folderAsset("folder_one-other/no.svg");
      await folderAsset("folder_one/foreign.svg", { workspace: "other-ws" });
      const pending = await folderAsset("folder_one/pending.svg", {
        status: "pending",
        isPublic: false,
      });
      const processing = await folderAsset("folder_one/processing.svg", {
        status: "processing",
      });
      await folderAsset("folder_one/failed.svg", { status: "failed" });
      await sql("UPDATE asset SET current_version_id=null WHERE id=$1", [
        processing.id,
      ]);
      const rules = [
        { sourcePrefix: "folder_one/", outputPrefix: "assets/" },
        { sourcePrefix: "absent/", outputPrefix: "" },
      ];
      const id = await createFolderVard("Literal folders", rules);
      const manifest = (await folderGet(id, true)).json();
      assert.deepEqual(
        manifest.items.map((item: any) => item.outputPath),
        ["assets/a.svg", "assets/nested/b.svg"],
      );
      assert.equal(manifest.schema, 1);
      assert.equal(manifest.folderRules, undefined);
      assert.deepEqual((await folderGet(id)).json().items, []);
      assert.equal(
        (await app.inject({ url: `/v/${id}` })).statusCode,
        200,
        "unready private files are not resolved members",
      );
      for (const item of manifest.items) {
        assert.match(item.id, /^folder:[a-f0-9]{64}$/);
        assert.equal(item.writable, false);
        assert.equal(item.pinned, false);
        assert.equal(item.transformation, null);
        assert.ok(!item.downloadUrl.includes("?"));
      }
      await setRules(id, [...rules].reverse());
      assert.deepEqual(
        (await folderGet(id, true)).json().items,
        manifest.items,
      );
      const sibling = await folderAsset("folder_one/0.svg");
      const next = randomUUID();
      await sql(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) SELECT $1::uuid,workspace_id,asset_id,2,'ready',$1::text,filename,mime_type,size,checksum,created_by,updated_by FROM asset_version WHERE id=$2",
        [next, first.version],
      );
      objects.set(next, bytes);
      await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
        next,
        first.id,
      ]);
      const updated = (await folderGet(id, true)).json().items;
      assert.equal(updated.length, 3);
      for (const item of manifest.items)
        assert.equal(
          updated.find((row: any) => row.assetId === item.assetId).id,
          item.id,
        );
      assert.equal(
        updated.find((row: any) => row.assetId === first.id).versionId,
        next,
      );
      assert.ok(!updated.some((row: any) => row.assetId === pending.id));
      const sync = await app.inject({
        url: "/api/workspaces/ws/sync/assets?prefix=folder_one/",
        headers: keyHeaders.read,
      });
      assert.deepEqual(
        new Set(sync.json().assets.map((row: any) => row.id)),
        new Set([first.id, nested.id, sibling.id]),
      );
      await setRules(id, [
        { sourcePrefix: "folder_one/nested/", outputPrefix: "assets/nested/" },
      ]);
      assert.equal(
        (await folderGet(id, true)).json().items[0].id,
        manifest.items.find((row: any) => row.assetId === nested.id).id,
        "equivalent mapping from a narrower source keeps identity",
      );
      await setRules(id, [{ sourcePrefix: "", outputPrefix: "root/" }]);
      const rootItems = (await folderGet(id, true)).json().items;
      assert.ok(
        rootItems.some(
          (row: any) => row.outputPath === "root/folder_one/nested/b.svg",
        ),
      );
      assert.ok(
        !rootItems.some((row: any) => row.key === "folder_one/foreign.svg"),
      );
      await setRules(id, [
        { sourcePrefix: "folder_one/nested/", outputPrefix: "" },
      ]);
      assert.deepEqual(
        (await folderGet(id, true))
          .json()
          .items.map((row: any) => row.outputPath),
        ["b.svg"],
      );
      await folderAsset("brand/included.svg");
      await folderAsset("branding/excluded.svg");
      await setRules(id, [{ sourcePrefix: "brand/", outputPrefix: "" }]);
      assert.ok(
        !(await folderGet(id, true))
          .json()
          .items.some((row: any) => row.key.startsWith("branding/")),
      );
      await setRules(id, []);
      assert.deepEqual((await folderGet(id, true)).json().items, []);
    },
  );

  await t.test(
    "future folder collisions and unsafe outputs fail boundedly while configuration and manual PUT remain readable/repairable",
    async () => {
      await folderAsset("collision/a.svg");
      const rules = [{ sourcePrefix: "collision/", outputPrefix: "assets/" }];
      const id = await createFolderVard("Collisions", rules);
      const put = await app.inject({
        method: "PUT",
        url: `${folderBase}/${id}/items`,
        headers: keyHeaders.write,
        payload: { items: [{ assetId: oldId, outputPath: "ASSETS/a.svg" }] },
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.equal(
        put.json().items.length,
        1,
        "generated rows must not become editable",
      );
      const rejected = await folderGet(id, true);
      assert.equal(rejected.statusCode, 409, rejected.body);
      assert.match(rejected.body, /collide/);
      assert.equal((await folderGet(id)).statusCode, 200);
      await app.inject({
        method: "PUT",
        url: `${folderBase}/${id}/items`,
        headers: keyHeaders.write,
        payload: { items: [] },
      });
      assert.equal((await folderGet(id, true)).statusCode, 200);
      for (const conflictRules of [
        [...rules, ...rules],
        [
          ...rules,
          { sourcePrefix: "collision/", outputPrefix: "assets/a.svg/" },
        ],
        [
          { sourcePrefix: "collision/", outputPrefix: "café/" },
          { sourcePrefix: "collision/", outputPrefix: "cafe\u0301/" },
        ],
      ]) {
        await setRules(id, conflictRules);
        const response = await folderGet(id, true);
        assert.equal(response.statusCode, 409, response.body);
        assert.ok(response.body.length < 300);
        assert.equal((await folderGet(id)).statusCode, 200);
      }
      await setRules(id, rules);
      await folderAsset("collision/a.svg/nested.svg");
      assert.match((await folderGet(id, true)).body, /overlap/);
      await setRules(id, [{ sourcePrefix: "unsafe/", outputPrefix: "" }]);
      assert.equal(
        (await folderGet(id, true)).statusCode,
        200,
        "empty folders are valid",
      );
      await folderAsset("unsafe/vardum.json");
      const unsafe = await folderGet(id, true);
      assert.equal(unsafe.statusCode, 409);
      assert.match(unsafe.body, /unsafe/);
      assert.equal((await folderGet(id)).statusCode, 200);
      await setRules(id, []);
      assert.equal((await folderGet(id, true)).statusCode, 200);
    },
  );

  await t.test(
    "1000 total outputs is inclusive, overflow is not truncated, private dynamic membership hides all conflict/limit details",
    async () => {
      // Bulk SQL keeps the fixture small while exercising the real bounded database query.
      await sql(
        "INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) SELECT gen_random_uuid(),'ws','limits/'||lpad(n::text,4,'0')||'.svg','Limit',true,'fixture','fixture' FROM generate_series(1,1000) n",
      );
      await sql(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) SELECT gen_random_uuid(),'ws',id,1,'ready',id::text,'limit.svg','image/svg+xml',1,$1,'fixture','fixture' FROM asset WHERE starts_with(key,'limits/')",
        [checksum],
      );
      await sql(
        "UPDATE asset a SET current_version_id=v.id FROM asset_version v WHERE a.id=v.asset_id AND starts_with(a.key,'limits/')",
      );
      const rules = [{ sourcePrefix: "limits/", outputPrefix: "assets/" }];
      const id = await createFolderVard("Limits", rules);
      assert.equal((await folderGet(id, true)).json().items.length, 1000);
      const put = await app.inject({
        method: "PUT",
        url: `${folderBase}/${id}/items`,
        headers: keyHeaders.write,
        payload: { items: [{ assetId: oldId, outputPath: "manual.svg" }] },
      });
      assert.equal(put.statusCode, 200);
      assert.deepEqual(put.json().folderRules, rules);
      assert.equal((await folderGet(id, true)).statusCode, 409);
      assert.match((await folderGet(id, true)).body, /more than 1000/);
      assert.equal((await folderGet(id)).statusCode, 200);
      await app.inject({
        method: "PUT",
        url: `${folderBase}/${id}/items`,
        headers: keyHeaders.write,
        payload: { items: [] },
      });
      assert.equal((await folderGet(id, true)).statusCode, 200);
      await folderAsset("limits/1001.svg");
      assert.equal((await folderGet(id, true)).statusCode, 409);
      await folderAsset("limits/zz-private.svg", { isPublic: false });
      for (const headers of [
        {},
        keyHeaders.other!,
        { cookie: cookies.outsider! },
      ]) {
        const response = await app.inject({ url: `/v/${id}`, headers });
        assert.equal(response.statusCode, 404, response.body);
        assert.deepEqual(response.json(), { error: "Vard not found" });
        assert.equal(response.headers["cache-control"], "private, no-store");
      }
      await setRules(id, [{ sourcePrefix: "dynamic/", outputPrefix: "" }]);
      assert.equal((await app.inject({ url: `/v/${id}` })).statusCode, 200);
      const member = await folderAsset("dynamic/secret.svg", {
        isPublic: false,
      });
      assert.equal((await app.inject({ url: `/v/${id}` })).statusCode, 404);
      const authorized = await app.inject({
        url: `/v/${id}`,
        headers: keyHeaders.read,
      });
      assert.equal(authorized.statusCode, 200);
      assert.equal(authorized.json().items[0].assetId, member.id);
      await setRules(id, [
        { sourcePrefix: "dynamic/", outputPrefix: "" },
        { sourcePrefix: "dynamic/", outputPrefix: "" },
      ]);
      assert.equal(
        (await app.inject({ url: `/v/${id}` })).statusCode,
        404,
        "privacy precedes collisions",
      );
      assert.equal((await folderGet(id, true)).statusCode, 409);
      await setRules(id, []);
      assert.equal((await folderGet(id, true)).statusCode, 200);
    },
  );
  await t.test(
    "real normal/frozen CLI restores 15 originals and signed variants with API, CLI and migrated default read keys",
    async (cliTest) => {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const home = join(root, "home");
      await mkdir(join(home, "vardum"), { recursive: true });
      await writeFile(
        join(home, "vardum/version-check.json"),
        JSON.stringify({ latest: "0.0.0", at: Date.now() }),
      );
      for (const [index, assetId] of bulkAssets.entries()) {
        await sql(
          "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) VALUES ('ws',$1,$2,$3,'fixture','fixture')",
          [vardId, assetId, `assets/bulk-${index}.svg`],
        );
      }
      await sql(
        "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,transformation,created_by,updated_by) VALUES ('ws',$1,$2,'assets/secret-small.png',$3,'fixture','fixture')",
        [vardId, privateId, JSON.stringify({ w: 8, format: "png" })],
      );
      const projects: Array<{
        path: string;
        key: string;
        locked: string;
        name: string;
        variant: Buffer;
      }> = [];
      const cli = fileURLToPath(
        new URL("../../cli/src/index.ts", import.meta.url),
      );
      const run = (project: { path: string; key: string }, ...args: string[]) =>
        execFile(
          process.execPath,
          ["--import", import.meta.resolve("tsx"), cli, ...args, "--json"],
          {
            cwd: project.path,
            timeout: 20_000,
            env: {
              PATH: cleanEnv.PATH,
              HOME: home,
              XDG_CONFIG_HOME: home,
              VARDUM_API_KEY: project.key,
            },
          },
        );
      for (const key of bulkKeys) {
        const project = { path: join(root, key.name), key: key.key };
        await mkdir(project.path);
        await writeFile(
          join(project.path, "vardum.json"),
          JSON.stringify({
            schema: 1,
            server: origin,
            workspace: "ws",
            vard: vardId,
          }),
        );
        const pulled = await run(project, "pull");
        assert.equal(JSON.parse(pulled.stdout).changed, 15);
        const locked = await readFile(
          join(project.path, ".vardum.lock"),
          "utf8",
        );
        assert.ok(locked.includes(immutable));
        assert.ok(locked.includes(signed));
        const variant = await readFile(
          join(project.path, "assets/secret-small.png"),
        );
        assert.equal(variant.subarray(1, 4).toString(), "PNG");
        projects.push({ ...project, locked, name: key.name, variant });
      }
      await sql("DELETE FROM vard WHERE id=$1", [vardId]);
      for (const project of projects) {
        await rm(join(project.path, "assets"), { recursive: true });
        const result = await run(project, "pull", "--frozen");
        assert.equal(JSON.parse(result.stdout).changed, 15);
        for (const path of [
          "secret.svg",
          ...bulkAssets.map((_, index) => `bulk-${index}.svg`),
        ]) {
          assert.equal(
            (await readFile(join(project.path, "assets", path))).equals(bytes),
            true,
          );
        }
        assert.equal(
          await readFile(join(project.path, ".vardum.lock"), "utf8"),
          project.locked,
        );
        assert.deepEqual(
          await readFile(join(project.path, "assets/secret-small.png")),
          project.variant,
        );
        console.log(
          `${project.name}: normal pull and manifest-less frozen pull each restored 15 originals/variants with rate limiting enabled`,
        );
      }
      await cliTest.test(
        "folder CLI normal/frozen updates, new/removed/moved members, rule deletion and explicit stale deletion",
        async () => {
          const first = await folderAsset("cli-folders/a.svg", {
            isPublic: false,
          });
          const removed = await folderAsset("cli-folders/nested/b.svg", {
            isPublic: false,
          });
          const id = await createFolderVard(
            "Folder CLI lifecycle",
            [{ sourcePrefix: "cli-folders/", outputPrefix: "assets/" }],
            false,
          );
          const manual = await app.inject({
            method: "PUT",
            url: `${folderBase}/${id}/items`,
            headers: keyHeaders.write,
            payload: {
              items: [
                {
                  assetId: privateId,
                  outputPath: "manual/secret.svg",
                  versionId,
                },
              ],
            },
          });
          assert.equal(manual.statusCode, 200, manual.body);
          const projects = [];
          for (const name of [
            "folder-delete",
            "folder-keep",
            "folder-frozen",
          ]) {
            const project = {
              path: join(root, name),
              key: bulkKeys.find((row) => row.name === "cli-default")!.key,
            };
            await mkdir(project.path);
            await writeFile(
              join(project.path, "vardum.json"),
              JSON.stringify({
                schema: 1,
                server: origin,
                workspace: "ws",
                vard: id,
              }),
            );
            assert.equal(
              JSON.parse((await run(project, "pull")).stdout).changed,
              3,
            );
            projects.push(project);
          }
          const [deleting, keeping, frozen] = projects as [
            (typeof projects)[number],
            (typeof projects)[number],
            (typeof projects)[number],
          ];
          const oldLock = await readFile(
            join(frozen.path, ".vardum.lock"),
            "utf8",
          );
          const oldSnapshot = JSON.parse(oldLock);
          assert.equal(
            Object.keys(oldSnapshot.items).filter((key) =>
              key.startsWith("folder:"),
            ).length,
            2,
          );
          const replacement = Buffer.from(
            bytes.toString().replace("red", "blue"),
          );
          const nextVersion = randomUUID();
          objects.set(nextVersion, replacement);
          await sql(
            "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1::uuid,'ws',$2,2,'ready',$1::text,'a.svg','image/svg+xml',$3,$4,'fixture','fixture')",
            [
              nextVersion,
              first.id,
              replacement.length,
              createHash("sha256").update(replacement).digest("hex"),
            ],
          );
          await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
            nextVersion,
            first.id,
          ]);
          await folderAsset("cli-folders/c.svg", { isPublic: false });
          // Remove membership through rules, retaining every old asset/version/key for frozen delivery.
          await setRules(id, [
            { sourcePrefix: "cli-folders/", outputPrefix: "assets/" },
            { sourcePrefix: "never/", outputPrefix: "" },
          ]);
          const updatedManifest = (await folderGet(id, true)).json();
          const aItem = updatedManifest.items.find(
            (item: any) => item.assetId === first.id,
          );
          assert.ok(
            oldSnapshot.items[aItem.id],
            "version updates retain generated identity",
          );
          for (const project of [deleting, keeping]) {
            await run(project, "pull");
            assert.deepEqual(
              await readFile(join(project.path, "assets/a.svg")),
              replacement,
            );
            assert.deepEqual(
              await readFile(join(project.path, "assets/c.svg")),
              bytes,
            );
          }
          // Rule deletion updates membership, but an old commit still restores exact old bytes/files.
          await setRules(id, []);
          await rm(join(frozen.path, "assets"), { recursive: true });
          await rm(join(frozen.path, "manual"), { recursive: true });
          const frozenPull = await run(frozen, "pull", "--frozen");
          assert.equal(JSON.parse(frozenPull.stdout).changed, 3);
          assert.deepEqual(
            await readFile(join(frozen.path, "assets/a.svg")),
            bytes,
          );
          assert.deepEqual(
            await readFile(join(frozen.path, "assets/nested/b.svg")),
            bytes,
          );
          await assert.rejects(
            readFile(join(frozen.path, "assets/c.svg")),
            /ENOENT/,
          );
          assert.equal(
            await readFile(join(frozen.path, ".vardum.lock"), "utf8"),
            oldLock,
          );
          await run(deleting, "pull", "--delete");
          await run(keeping, "pull");
          for (const path of [
            "assets/a.svg",
            "assets/nested/b.svg",
            "assets/c.svg",
          ]) {
            await assert.rejects(readFile(join(deleting.path, path)), /ENOENT/);
            assert.ok((await readFile(join(keeping.path, path))).length > 0);
          }
          assert.equal(
            Object.keys(
              JSON.parse(
                await readFile(join(keeping.path, ".vardum.lock"), "utf8"),
              ).items,
            ).length,
            1,
          );
          await run(keeping, "pull", "--delete");
          assert.ok(
            (await readFile(join(keeping.path, "assets/a.svg"))).length > 0,
            "existing limitation: later --delete cannot recover stale entries omitted by an earlier normal pull",
          );
          // Re-add rules, then move one source within the folder and another out of it.
          await setRules(id, [
            { sourcePrefix: "cli-folders/", outputPrefix: "assets/" },
          ]);
          await run(deleting, "pull");
          await sql(
            "UPDATE asset SET key='cli-folders/moved/a.svg' WHERE id=$1",
            [first.id],
          );
          await sql("UPDATE asset SET key='outside-cli/b.svg' WHERE id=$1", [
            removed.id,
          ]);
          await run(deleting, "pull", "--delete");
          assert.deepEqual(
            await readFile(join(deleting.path, "assets/moved/a.svg")),
            replacement,
          );
          await assert.rejects(
            readFile(join(deleting.path, "assets/a.svg")),
            /ENOENT/,
          );
          await assert.rejects(
            readFile(join(deleting.path, "assets/nested/b.svg")),
            /ENOENT/,
          );
          // Expansion failure reaches the CLI before any writes, leaving its snapshot intact.
          const beforeFailure = await readFile(
            join(deleting.path, ".vardum.lock"),
            "utf8",
          );
          await setRules(id, [
            { sourcePrefix: "cli-folders/", outputPrefix: "assets/" },
            { sourcePrefix: "cli-folders/", outputPrefix: "assets/" },
          ]);
          await assert.rejects(run(deleting, "pull", "--delete"), /collide/);
          assert.equal(
            await readFile(join(deleting.path, ".vardum.lock"), "utf8"),
            beforeFailure,
          );
          assert.deepEqual(
            await readFile(join(deleting.path, "assets/moved/a.svg")),
            replacement,
          );
          await setRules(id, []);
          await run(deleting, "pull", "--delete");
          await assert.rejects(
            readFile(join(deleting.path, "assets/moved/a.svg")),
            /ENOENT/,
          );
          assert.deepEqual(
            await readFile(join(deleting.path, "manual/secret.svg")),
            bytes,
          );
          // No live Vard exists now: frozen cannot fetch a manifest and still restores old membership.
          await sql("UPDATE asset SET key=$1 WHERE id=$2", [
            first.key,
            first.id,
          ]);
          await sql("UPDATE asset SET key=$1 WHERE id=$2", [
            removed.key,
            removed.id,
          ]);
          await sql("DELETE FROM vard WHERE id=$1", [id]);
          await rm(join(frozen.path, "assets"), { recursive: true });
          await run(frozen, "pull", "--frozen");
          assert.deepEqual(
            await readFile(join(frozen.path, "assets/a.svg")),
            bytes,
          );
          assert.equal(
            await readFile(join(frozen.path, ".vardum.lock"), "utf8"),
            oldLock,
          );
          console.log(
            "Folder lifecycle: updating --delete removes stale files; no-delete retains files but drops stale lock entries (later --delete cannot clean them). Frozen restored retained old versions with no Vard/manifest.",
          );
        },
      );
    },
  );
  await t.test("upload resume and planned checksum under the production database role", async (resumeTest) => {
    const { checkUploadResume } = await import("./upload-resume.fixture.js");
    await checkUploadResume(resumeTest, { admin: admin!, app, objects, keyHeaders, cookies });
  });
  await t.test("VARD additive import under the production database role", async (importTest) => {
    const { checkVardImport } = await import("./vard-import.fixture.js");
    await checkVardImport(importTest, { admin: admin!, app, objects, keyHeaders, cookies,
      setReadHook: (hook) => { beforeObjectRead = hook; },
    });
  });
  await t.test("VARD guarded editor under the production database role", async (editorTest) => {
    const { checkVardEditor } = await import("./vard-editor.fixture.js");
    await checkVardEditor(editorTest, { admin: admin!, app, objects, keyHeaders, cookies,
      setCopyHook: (hook) => { beforeObjectCopy = hook; },
    });
  });
  await t.test("VARD import through the real CLI, uploads, worker and pull", async (importCliTest) => {
    const { checkVardImportCli } = await import("./vard-import-cli.fixture.js");
    await checkVardImportCli(importCliTest, {
      admin: admin!, app, objects, keyHeaders, root, cliPath: vardImportCliPath,
    });
  });
  await t.test("ingest recovery and retry under the production database role", async (recoveryTest) => {
    const { checkIngestRecovery } = await import("./ingest-recovery.fixture.js");
    await checkIngestRecovery(recoveryTest, {
      admin: admin!, app, objects, keyHeaders, cookies,
      setStorageFailure: (value) => { storageFailure = value; },
      setReadHook: (hook) => { beforeObjectRead = hook; },
    });
  });
  await t.test("resource budgets and upload expiry under the production role", async (resourceTest) => {
    const { checkResourceBudgets } = await import("./resource-budget.fixture.js");
    await checkResourceBudgets(resourceTest, { admin: admin!, app, objects, keyHeaders,
      setDeleteFailure: value => { deleteFailure = value; },
      setReadHook: hook => { beforeObjectRead = hook; },
    });
  });

});
