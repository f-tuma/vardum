import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool } from "pg";

const execFile = promisify(execFileCallback);
const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
type Page = {
  folders: Array<{ name: string; prefix: string }>;
  assets: Array<{
    id: string;
    key: string;
    displayName: string;
    isPublic: boolean;
    currentVersionId: string | null;
    latestVersionId: string | null;
    status: string | null;
    error: string | null;
    mimeType: string | null;
    size: number | null;
    width: number | null;
    height: number | null;
    customDomain: string | null;
    thumbnailUrl: string | null;
  }>;
  nextCursor: string | null;
};

// Explicit integration command only: no .env, ambient database, queue or storage.
// Uses the same disposable native PostgreSQL pattern as private-delivery.test.ts.
test(
  "asset browser pagination: disposable PostgreSQL, real auth and tenant RLS",
  {
    timeout: 120_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "varda-pagination-test-"));
    const data = join(root, "data");
    const pgBin = process.env.PG_BINDIR ?? "/usr/bin";
    const fullExplain = process.env.PAGINATION_EXPLAIN_FULL === "true";
    const cleanEnv = { PATH: process.env.PATH, LANG: "C" };
    let started = false;
    let admin: Pool | undefined;
    let closeApp: (() => Promise<unknown>) | undefined;
    let closeDatabase: (() => Promise<void>) | undefined;
    let destroyStorage: (() => void) | undefined;
    t.after(async () => {
      await closeApp?.();
      destroyStorage?.();
      await closeDatabase?.();
      await admin?.end();
      // Pool.end() can resolve before clients finish disconnecting. Smart
      // shutdown waits for their physical close instead of force-killing sockets.
      if (started) {
        await execFile(
          join(pgBin, "pg_ctl"),
          ["-D", data, "-m", "smart", "-w", "-t", "10", "stop"],
          {
            env: cleanEnv,
          },
        );
      }
      await rm(root, { recursive: true, force: true });
    });
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
    process.env = {
      ...cleanEnv,
      NODE_ENV: "test",
      DATABASE_URL: connection("varda_app"),
      BETTER_AUTH_URL: "http://localhost:3000",
      WEB_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET:
        "isolated-pagination-auth-secret-at-least-32-characters",
      TRANSFORM_SECRET:
        "isolated-pagination-transform-secret-at-least-32-characters",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_BUCKET: "fixture",
      S3_ACCESS_KEY_ID: "fixture",
      S3_SECRET_ACCESS_KEY: "fixture",
      AWS_EC2_METADATA_DISABLED: "true",
    };
    await migrate(drizzle(admin), { migrationsFolder: migrations });
    const { migrateQueue } = await import("../src/queue-migrate.js");
    await migrateQueue(connection("postgres"));
    const { provisionRuntimeRole, assertRuntimeDatabaseRole } =
      await import("../src/db/runtime-role.js");
    await provisionRuntimeRole(admin, "isolated-pagination-runtime-password");
    const database = await import("../src/db/index.js");
    closeDatabase = database.closeDatabase;
    await assertRuntimeDatabaseRole(database.pool);
    const { buildApp } = await import("../src/app.js");
    const { storage } = await import("../src/storage.js");
    destroyStorage = () => storage.destroy();
    const app = await buildApp();
    closeApp = () => app.close();
    const sql = (text: string, values: unknown[] = []) =>
      admin!.query(text, values);
    await sql(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('paging-org','Paging','paging',now()),('other-org','Other','other',now())",
    );
    await sql(
      "INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ('paging-ws','paging-org','Paging','paging','fixture','fixture'),('other-ws','other-org','Other','other','fixture','fixture')",
    );
    await sql(
      "INSERT INTO workspace_settings(workspace_id,custom_domain,custom_domain_verified_at,created_by,updated_by) VALUES ('paging-ws','assets.pagination.test',now(),'fixture','fixture')",
    );
    const cookies: Record<string, string> = {};
    const users: Record<string, string> = {};
    for (const role of ["owner", "viewer", "outsider"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: {
          name: role,
          email: `${role}@pagination.test`,
          password: "disposable-password-123",
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      users[role] = response.json().user.id;
      cookies[role] = response.cookies
        .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
        .join("; ");
      await sql(
        "INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ($1,$2,$3,$4,now())",
        [
          randomUUID(),
          role === "outsider" ? "other-org" : "paging-org",
          users[role],
          role === "viewer" ? "viewer" : "owner",
        ],
      );
    }
    const keyResponse = await app.inject({
      method: "POST",
      url: "/api/workspaces/paging-ws/api-keys",
      headers: { cookie: cookies.owner! },
      payload: { name: "pagination read", access: "read" },
    });
    assert.equal(keyResponse.statusCode, 200, keyResponse.body);
    const keyId = keyResponse.json().id;
    const keyHeaders = { "x-api-key": keyResponse.json().key as string };
    await sql("UPDATE apikey SET rate_limit_enabled=false WHERE id=$1", [
      keyId,
    ]);

    const insertAsset = async (
      key: string,
      displayName = key,
      space = "paging-ws",
      isPublic = false,
    ) => {
      const id = randomUUID();
      await sql(
        "INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,'fixture','fixture')",
        [id, space, key, displayName, isPublic],
      );
      return id;
    };
    const insertFolder = async (prefix: string, space = "paging-ws") => {
      await sql(
        "INSERT INTO asset_folder(workspace_id,prefix,created_by) VALUES ($1,$2,'fixture') ON CONFLICT DO NOTHING",
        [space, prefix],
      );
    };
    const requestPage = async (
      query: Record<string, string | number> = {},
      headers: Record<string, string> = keyHeaders,
      space = "paging-ws",
    ) => {
      const params = new URLSearchParams({ pagination: "cursor" });
      for (const [key, value] of Object.entries(query))
        params.set(key, String(value));
      return app.inject({
        method: "GET",
        url: `/api/workspaces/${space}/assets?${params}`,
        headers,
      });
    };
    const getPage = async (query: Record<string, string | number> = {}) => {
      const response = await requestPage(query);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Page>();
    };
    const walk = async (query: Record<string, string | number>) => {
      const pages: Page[] = [];
      let cursor: string | null = null;
      do {
        const page = await getPage({ ...query, ...(cursor ? { cursor } : {}) });
        assert.ok(
          page.folders.length + page.assets.length <= Number(query.limit ?? 50),
        );
        pages.push(page);
        cursor = page.nextCursor;
        assert.ok(pages.length < 100, "traversal must terminate");
      } while (cursor);
      return pages;
    };

    const folderPaths: string[] = [];
    const directKeys: string[] = [];
    const bulkIds: string[] = [];
    for (let index = 0; index < 135; index++) {
      const number = String(index).padStart(3, "0");
      const prefix = `bulk/f${number}/`;
      folderPaths.push(prefix);
      await insertFolder(prefix);
      await insertAsset(`${prefix}nested/item.png`);
      const key = `bulk/asset-${number}.png`;
      directKeys.push(key);
      bulkIds.push(
        await insertAsset(key, `Asset ${number}`, "paging-ws", index === 0),
      );
    }
    await insertFolder("bulk/f010/empty/nested/");
    await insertFolder("bulk/f001/");
    await insertAsset("bulk/asset_z.png");
    directKeys.push("bulk/asset_z.png");
    await insertAsset("bulk/asset.z.png");
    directKeys.push("bulk/asset.z.png");
    await insertAsset("bulk/foreign.png", "Foreign", "other-ws");
    await insertFolder("bulk/foreign-folder/", "other-ws");

    await t.test(
      "more than 100 folders/assets, complete deduplication and shared page limit",
      async () => {
        const first = await getPage({ prefix: "bulk/" });
        assert.equal(first.folders.length, 50);
        assert.equal(first.assets.length, 0);
        assert.ok(first.nextCursor);
        const pages = await walk({ prefix: "bulk/", limit: 100 });
        assert.equal(pages[0]!.folders.length, 100);
        assert.equal(pages[1]!.folders.length, 35);
        assert.equal(pages[1]!.assets.length, 65);
        assert.equal(pages.at(-1)!.nextCursor, null);
        assert.deepEqual(
          pages.flatMap((page) => page.folders.map((folder) => folder.prefix)),
          folderPaths,
        );
        const keys = pages.flatMap((page) =>
          page.assets.map((asset) => asset.key),
        );
        const expected = [...directKeys].sort((left, right) =>
          Buffer.compare(Buffer.from(left), Buffer.from(right)),
        );
        assert.deepEqual(keys, expected);
        assert.equal(new Set(keys).size, directKeys.length);
        const searched = await walk({
          prefix: "bulk/",
          search: "asset",
          limit: 100,
        });
        assert.deepEqual(
          searched.flatMap((page) => page.assets.map((asset) => asset.key)),
          expected,
        );
        assert.equal(searched.flatMap((page) => page.folders).length, 0);
        const retry = await getPage({
          prefix: "bulk/",
          cursor: first.nextCursor!,
        });
        assert.deepEqual(
          await getPage({ prefix: "bulk/", cursor: first.nextCursor! }),
          retry,
        );
        const browse = await getPage({ prefix: "bulk/f010/" });
        assert.deepEqual(
          browse.folders.map((folder) => folder.prefix),
          ["bulk/f010/empty/", "bulk/f010/nested/"],
        );
        assert.equal(browse.assets.length, 0);
        const whitespace = await getPage({ prefix: "bulk/", search: "   " });
        assert.deepEqual(whitespace, first);
      },
    );

    await t.test(
      "limit plus one probes continuation and retains legacy/sync contracts",
      async () => {
        await insertAsset("terminal/a.png");
        await insertAsset("terminal/b.png");
        const exact = await getPage({ prefix: "terminal/", limit: 2 });
        assert.equal(exact.assets.length, 2);
        assert.equal(exact.nextCursor, null);
        await insertAsset("terminal/c.png");
        const more = await getPage({ prefix: "terminal/", limit: 2 });
        assert.ok(more.nextCursor);
        const last = await getPage({
          prefix: "terminal/",
          limit: 2,
          cursor: more.nextCursor!,
        });
        assert.deepEqual(
          last.assets.map((asset) => asset.key),
          ["terminal/c.png"],
        );
        assert.equal(last.nextCursor, null);
        const legacy = await app.inject({
          method: "GET",
          url: "/api/workspaces/paging-ws/assets?prefix=terminal/&limit=1",
          headers: keyHeaders,
        });
        assert.equal(legacy.statusCode, 200, legacy.body);
        assert.deepEqual(Object.keys(legacy.json()).sort(), [
          "assets",
          "folders",
        ]);
        assert.equal(legacy.json().assets.length, 1);
        const sync = await app.inject({
          method: "GET",
          url: "/api/workspaces/paging-ws/sync/assets?prefix=terminal/",
          headers: keyHeaders,
        });
        assert.equal(sync.statusCode, 200, sync.body);
        assert.deepEqual(sync.json(), {
          workspaceSlug: "paging",
          assets: [],
          nextCursor: null,
        });
        assert.equal((await requestPage({ limit: 101 })).statusCode, 400);
        assert.equal((await requestPage({ limit: 0 })).statusCode, 400);
      },
    );

    await t.test(
      "search finds nested empty folders and implied ancestors with literal escaping",
      async () => {
        await insertFolder("search/parent/empty-match/deep/");
        await insertAsset("search/implied-match/deep/file.png", "Unrelated");
        await insertAsset("search/literal.png", "100%_\\needle");
        await insertAsset("search/plain.png", "100percent needle");
        await insertAsset("search/under_score.png");
        await insertAsset("search/under-score.png");
        await insertAsset("search2/implied-match.png");
        await insertFolder("search2/empty-match/");
        const folders = await walk({
          prefix: "search/",
          search: "match",
          limit: 1,
        });
        assert.deepEqual(
          folders.flatMap((page) =>
            page.folders.map((folder) => folder.prefix),
          ),
          [
            "search/implied-match/",
            "search/implied-match/deep/",
            "search/parent/empty-match/",
            "search/parent/empty-match/deep/",
          ],
        );
        assert.deepEqual(
          folders.flatMap((page) => page.assets.map((asset) => asset.key)),
          ["search/implied-match/deep/file.png"],
        );
        for (const search of ["%", "\\", "100%_\\needle"]) {
          const page = await getPage({ prefix: "search/", search });
          assert.deepEqual(
            page.assets.map((asset) => asset.key),
            ["search/literal.png"],
          );
        }
        const underscore = await getPage({ prefix: "search/", search: "_" });
        assert.deepEqual(
          underscore.assets.map((asset) => asset.key),
          ["search/literal.png", "search/under_score.png"],
        );
        const padded = await getPage({
          prefix: "search/",
          search: "  match  ",
          limit: 1,
        });
        assert.deepEqual(
          await getPage({ prefix: "search/", search: "match", limit: 1 }),
          padded,
        );
        assert.ok(padded.nextCursor);
        assert.equal(
          (
            await requestPage({
              prefix: "search/",
              search: "match",
              limit: 1,
              cursor: padded.nextCursor!,
            })
          ).statusCode,
          200,
        );
        await insertAsset("scope_/asset.png", "Scope");
        await insertAsset("scope_2/asset.png", "Scope");
        assert.deepEqual(
          (await getPage({ prefix: "scope_/", search: "Scope" })).assets.map(
            (asset) => asset.key,
          ),
          ["scope_/asset.png"],
        );
      },
    );

    await t.test(
      "current/latest metadata and domain/thumbnail behavior match existing listings",
      async () => {
        const current = randomUUID();
        const latest = randomUUID();
        const privateVersion = randomUUID();
        const videoId = await insertAsset(
          "hydration/video.mp4",
          "Video",
          "paging-ws",
          true,
        );
        const videoVersion = randomUUID();
        for (const [id, assetId, number, mimeType, status, error] of [
          [current, bulkIds[0], 1, "image/png", "ready", null],
          [latest, bulkIds[0], 2, "image/png", "failed", "Fixture failure"],
          [privateVersion, bulkIds[1], 1, "image/png", "ready", null],
          [videoVersion, videoId, 1, "video/mp4", "ready", null],
        ]) {
          await sql(
            "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,width,height,error,created_by,updated_by) VALUES ($1::uuid,'paging-ws',$2,$3,$4,$1::text,$1::text,$5,4,16,10,$6,'fixture','fixture')",
            [id, assetId, number, status, mimeType, error],
          );
        }
        await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
          current,
          bulkIds[0],
        ]);
        await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
          privateVersion,
          bulkIds[1],
        ]);
        await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
          videoVersion,
          videoId,
        ]);
        const listed = (await getPage({ prefix: "bulk/", search: "Asset 000" }))
          .assets[0]!;
        assert.equal(listed.currentVersionId, current);
        assert.equal(listed.latestVersionId, latest);
        assert.equal(listed.status, "failed");
        assert.equal(listed.error, "Fixture failure");
        assert.equal(listed.mimeType, "image/png");
        assert.equal(listed.size, 4);
        assert.equal(listed.width, 16);
        assert.equal(listed.height, 10);
        assert.equal(listed.customDomain, "assets.pagination.test");
        assert.match(
          listed.thumbnailUrl!,
          /^https:\/\/assets\.pagination\.test\/w\/__v\/[^/]+\/bulk\/asset-000\.png\?/,
        );
        const thumbnailQuery = new URL(listed.thumbnailUrl!).searchParams;
        assert.equal(thumbnailQuery.get("w"), "16");
        assert.equal(thumbnailQuery.get("h"), "10");
        assert.equal(thumbnailQuery.get("fit"), "inside");
        const legacy = await app.inject({
          method: "GET",
          url: "/api/workspaces/paging-ws/assets?prefix=bulk/&search=Asset%20000",
          headers: keyHeaders,
        });
        assert.equal(legacy.statusCode, 200, legacy.body);
        assert.deepEqual(listed, legacy.json().assets[0]);
        const privateImage = (
          await getPage({ prefix: "bulk/", search: "Asset 001" })
        ).assets[0]!;
        assert.equal(privateImage.isPublic, false);
        assert.match(
          privateImage.thumbnailUrl!,
          /^\/w\/paging\/__v\/[^/]+\/bulk\/asset-001\.png\?/,
        );
        const video = (await getPage({ prefix: "hydration/" })).assets[0]!;
        assert.equal(
          video.thumbnailUrl,
          "https://assets.pagination.test/w/hydration/video.mp4",
        );
        const noVersion = (await getPage({ prefix: "terminal/", limit: 1 }))
          .assets[0]!;
        assert.equal(noVersion.thumbnailUrl, null);
        assert.equal(noVersion.currentVersionId, null);
        assert.equal(noVersion.latestVersionId, null);
        await sql(
          "UPDATE workspace_settings SET custom_domain_verified_at=NULL WHERE workspace_id='paging-ws'",
        );
        const unverified = (await getPage({ prefix: "hydration/" })).assets[0]!;
        assert.equal(unverified.customDomain, null);
        assert.equal(unverified.thumbnailUrl, "/w/paging/hydration/video.mp4");
        await sql(
          "UPDATE workspace_settings SET custom_domain_verified_at=now() WHERE workspace_id='paging-ws'",
        );
      },
    );

    await t.test(
      "malformed, tampered and cross-scope cursors fail while auth is rechecked",
      async () => {
        const cursor = (await getPage({ prefix: "bulk/", limit: 1 }))
          .nextCursor!;
        const invalidQueries: Array<Record<string, string | number>> = [
          { prefix: "bulk/", limit: 1, cursor: "malformed" },
          {
            prefix: "bulk/",
            limit: 1,
            cursor: cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A"),
          },
          { prefix: "bulk/", limit: 2, cursor },
          { prefix: "terminal/", limit: 1, cursor },
          { prefix: "bulk/", search: "logo", limit: 1, cursor },
        ];
        for (const query of invalidQueries) {
          assert.equal((await requestPage(query)).statusCode, 400);
        }
        assert.equal(
          (await requestPage({ cursor: "A".repeat(4097) })).statusCode,
          400,
        );
        assert.equal(
          (await requestPage({ pagination: "offset" })).statusCode,
          400,
        );
        const otherCursor = await requestPage(
          { prefix: "bulk/", limit: 1, cursor },
          { cookie: cookies.outsider! },
          "other-ws",
        );
        assert.equal(otherCursor.statusCode, 400);
        const withoutMode = await app.inject({
          method: "GET",
          url: `/api/workspaces/paging-ws/assets?cursor=${encodeURIComponent(cursor)}`,
          headers: keyHeaders,
        });
        assert.equal(withoutMode.statusCode, 400);
        assert.equal(
          (await requestPage({ prefix: "bulk/", limit: 1, cursor }, {}))
            .statusCode,
          401,
        );
        assert.equal(
          (
            await requestPage(
              { prefix: "bulk/", limit: 1, cursor },
              { cookie: cookies.outsider! },
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await requestPage(
              { prefix: "bulk/", limit: 1, cursor },
              { cookie: cookies.viewer! },
            )
          ).statusCode,
          200,
        );
        await sql(
          "DELETE FROM member WHERE user_id=$1 AND organization_id='paging-org'",
          [users.viewer],
        );
        assert.equal(
          (
            await requestPage(
              { prefix: "bulk/", limit: 1, cursor },
              { cookie: cookies.viewer! },
            )
          ).statusCode,
          403,
        );
        await sql("UPDATE apikey SET enabled=false WHERE id=$1", [keyId]);
        assert.equal(
          (await requestPage({ prefix: "bulk/", limit: 1, cursor })).statusCode,
          401,
        );
        await sql("UPDATE apikey SET enabled=true WHERE id=$1", [keyId]);
        const { inWorkspace } = await import("../src/db/tenant.js");
        const { assetPageSql } = await import("../src/asset-pagination.js");
        assert.equal(
          (await database.pool.query("SELECT * FROM asset")).rowCount,
          0,
        );
        const forbidden = await inWorkspace("other-ws", (tx) =>
          tx.execute(
            assetPageSql(
              { workspaceId: "paging-ws", prefix: "bulk/", limit: 100 },
              null,
            ),
          ),
        );
        assert.equal(
          forbidden.rows.length,
          0,
          "pagination SQL must retain tenant RLS even with a mismatched explicit scope",
        );
      },
    );

    await t.test("asset rename preserves identity, versions, mappings and URL keys with auth and concurrency guards", async () => {
      const id = await insertAsset("rename/favicon.png", "favicon.png");
      const versionId = randomUUID();
      const vardId = randomUUID();
      await sql("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1,'paging-ws',$2,1,'ready',$3,'favicon.png','image/png',4,'fixture','fixture','fixture')", [versionId, id, `rename/${versionId}`]);
      await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, id]);
      await sql("INSERT INTO vard(id,workspace_id,name,created_by,updated_by) VALUES ($1,'paging-ws','Rename fixture','fixture','fixture')", [vardId]);
      await sql("INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) VALUES ('paging-ws',$1,$2,'images/favicon.png','fixture','fixture')", [vardId, id]);
      const url = `/api/workspaces/paging-ws/assets/${id}`;
      const snapshot = async () => ({
        asset: (await sql("SELECT * FROM asset WHERE id=$1", [id])).rows,
        versions: (await sql("SELECT * FROM asset_version WHERE asset_id=$1", [id])).rows,
        mappings: (await sql("SELECT * FROM vard_item WHERE vard_id=$1", [vardId])).rows,
        audit: (await sql("SELECT * FROM audit_event WHERE target_id=$1", [id])).rows,
      });
      const before = await snapshot();
      const readonlyKey = await app.inject({ method: "POST", url: "/api/workspaces/paging-ws/api-keys", headers: { cookie: cookies.owner! }, payload: { name: "rename read only", access: "read" } });
      assert.equal(readonlyKey.statusCode, 200, readonlyKey.body);
      for (const [headers, status] of [[{}, 401], [{ cookie: cookies.viewer! }, 403], [{ "x-api-key": readonlyKey.json().key as string }, 401], [{ cookie: cookies.outsider! }, 403]] as const) {
        const response = await app.inject({ method: "PATCH", url, headers, payload: { displayName: "favicon" } });
        assert.equal(response.statusCode, status, response.body);
      }
      for (const payload of [{}, { displayName: " " }, { displayName: "x".repeat(256) }, { displayName: "favicon", key: "other" }, { displayName: "favicon", currentVersionId: randomUUID() }, { displayName: "favicon", isPublic: true }]) {
        assert.equal((await app.inject({ method: "PATCH", url, headers: { cookie: cookies.owner! }, payload })).statusCode, 400);
      }
      assert.deepEqual(await snapshot(), before);
      const result = await app.inject({ method: "PATCH", url, headers: { cookie: cookies.owner! }, payload: { displayName: " favicon ", expectedDisplayName: "favicon.png" } });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json(), { id, displayName: "favicon" });
      const after = await snapshot();
      assert.deepEqual(after.versions, before.versions);
      assert.deepEqual(after.mappings, before.mappings);
      assert.deepEqual({ ...after.asset[0], display_name: before.asset[0].display_name, updated_at: before.asset[0].updated_at, updated_by: before.asset[0].updated_by }, before.asset[0]);
      assert.equal(after.audit.length, 1);
      assert.equal(after.audit[0].action, "asset.renamed");
      assert.deepEqual(after.audit[0].metadata, { previousDisplayName: "favicon.png", displayName: "favicon" });
      // Repeating after a lost response is idempotent, even with the old expected name.
      const repeat = await app.inject({ method: "PATCH", url, headers: { cookie: cookies.owner! }, payload: { displayName: "favicon", expectedDisplayName: "favicon.png" } });
      assert.equal(repeat.statusCode, 200, repeat.body);
      assert.deepEqual(await snapshot(), after);
      const stale = await app.inject({ method: "PATCH", url, headers: { cookie: cookies.owner! }, payload: { displayName: "different", expectedDisplayName: "favicon.png" } });
      assert.equal(stale.statusCode, 409, stale.body);
      assert.deepEqual(await snapshot(), after);
      const competing = await Promise.all(["first", "second"].map((displayName) => app.inject({ method: "PATCH", url, headers: { cookie: cookies.owner! }, payload: { displayName, expectedDisplayName: "favicon" } })));
      assert.deepEqual(competing.map((response) => response.statusCode).sort(), [200, 409]);
      const missing = await app.inject({ method: "PATCH", url: `/api/workspaces/paging-ws/assets/${randomUUID()}`, headers: { cookie: cookies.owner! }, payload: { displayName: "missing" } });
      assert.equal(missing.statusCode, 404);
      const foreign = await insertAsset("rename/foreign", "Foreign", "other-ws");
      assert.equal((await app.inject({ method: "PATCH", url: `/api/workspaces/paging-ws/assets/${foreign}`, headers: { cookie: cookies.owner! }, payload: { displayName: "hijacked" } })).statusCode, 404);
      assert.equal((await sql("SELECT display_name FROM asset WHERE id=$1", [foreign])).rows[0].display_name, "Foreign");
    });

    await t.test(
      "live traversal supports inserts, deleting a cursor row and renames in both directions",
      async () => {
        for (const key of ["live/b.png", "live/d.png", "live/f.png"])
          await insertAsset(key);
        const first = await getPage({ prefix: "live/", limit: 1 });
        assert.equal(first.assets[0]!.key, "live/b.png");
        const b = first.assets[0]!.id;
        await insertAsset("live/a.png"); // Behind the consumed tuple: not revisited.
        await insertAsset("live/c.png"); // Ahead of it: appears on continuation.
        await sql("DELETE FROM asset WHERE id=$1", [b]);
        const second = await getPage({
          prefix: "live/",
          limit: 1,
          cursor: first.nextCursor!,
        });
        assert.equal(second.assets[0]!.key, "live/c.png");
        const c = second.assets[0]!.id;
        await sql("UPDATE asset SET key='live/e.png' WHERE id=$1", [c]);
        await sql(
          "UPDATE asset SET key='live/aa.png' WHERE key='live/d.png' AND workspace_id='paging-ws'",
        );
        const third = await getPage({
          prefix: "live/",
          limit: 1,
          cursor: second.nextCursor!,
        });
        assert.equal(third.assets[0]!.key, "live/e.png");
        assert.equal(
          third.assets[0]!.id,
          c,
          "forward rename can appear again in a live traversal",
        );
        const fourth = await getPage({
          prefix: "live/",
          limit: 1,
          cursor: third.nextCursor!,
        });
        assert.equal(fourth.assets[0]!.key, "live/f.png");
        assert.equal(fourth.nextCursor, null);
        await insertFolder("live-folders/b/");
        await insertFolder("live-folders/d/");
        const folderPage = await getPage({ prefix: "live-folders/", limit: 1 });
        await sql(
          "DELETE FROM asset_folder WHERE workspace_id='paging-ws' AND prefix='live-folders/b/'",
        );
        assert.deepEqual(
          (
            await getPage({
              prefix: "live-folders/",
              limit: 1,
              cursor: folderPage.nextCursor!,
            })
          ).folders.map((folder) => folder.prefix),
          ["live-folders/d/"],
        );
      },
    );

    await t.test(
      "EXPLAIN ANALYZE records bounded page hydration and asset-phase folder skipping",
      async () => {
        const { inWorkspace } = await import("../src/db/tenant.js");
        const { assetPageSql } = await import("../src/asset-pagination.js");
        const { sql: drizzleSql } = await import("drizzle-orm");
        const dialect = new PgDialect();
        for (const [name, scope, position] of [
          [
            "browse first page",
            { workspaceId: "paging-ws", prefix: "bulk/", limit: 50 },
            null,
          ],
          [
            "search first page",
            {
              workspaceId: "paging-ws",
              prefix: "bulk/",
              search: "asset",
              limit: 50,
            },
            null,
          ],
          [
            "asset continuation",
            { workspaceId: "paging-ws", prefix: "bulk/", limit: 50 },
            {
              kindRank: 1 as const,
              path: "bulk/asset-100.png",
              stableIdentity: bulkIds[100]!,
            },
          ],
        ] as const) {
          const query = assetPageSql(scope, position);
          const plan = await inWorkspace("paging-ws", (tx) =>
            tx.execute(
              drizzleSql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
            ),
          );
          const document = plan.rows[0]! as {
            "QUERY PLAN": Array<{ Plan: Record<string, unknown> }>;
          };
          const nodes: Record<string, unknown>[] = [];
          const visit = (node: Record<string, unknown>) => {
            nodes.push(node);
            for (const child of (node.Plans ?? []) as Record<string, unknown>[])
              visit(child);
          };
          visit(document["QUERY PLAN"][0]!.Plan);
          if (fullExplain) {
            t.diagnostic(`${name}: ${JSON.stringify(document["QUERY PLAN"])}`);
          }
          const pageNode = nodes.find(
            (node) => node["Subplan Name"] === "CTE candidate_page",
          );
          assert.ok(
            pageNode,
            `${name}: materialized candidate page is visible in plan`,
          );
          assert.ok(Number(pageNode["Actual Rows"]) <= 51);
          const consumedNode = nodes.find(
            (node) => node["Subplan Name"] === "CTE consumed_page",
          );
          assert.ok(consumedNode);
          assert.ok(Number(consumedNode["Actual Rows"]) <= 50);
          const inputNode = nodes.find(
            (node) => node["Subplan Name"] === "CTE page_asset_inputs",
          );
          assert.ok(inputNode, "hydration inputs are a bounded materialized page");
          assert.ok(Number(inputNode["Actual Rows"]) <= 50);
          const hydrationNode = nodes.find(
            (node) => node["Subplan Name"] === "CTE page_assets",
          );
          assert.ok(hydrationNode, "hydration result is materialized once");
          assert.ok(Number(hydrationNode["Actual Loops"]) <= 1);
          assert.ok(
            Number(hydrationNode["Actual Rows"]) <= Number(inputNode["Actual Rows"]),
          );
          const containsLatestScan = (node: Record<string, unknown>): boolean =>
            node["Alias"] === "v" ||
            ((node.Plans ?? []) as Record<string, unknown>[]).some(
              containsLatestScan,
            );
          const latest = nodes.filter(
            (node) => node["Node Type"] === "Limit" && containsLatestScan(node),
          );
          t.diagnostic(
            `${name}: candidate rows=${pageNode["Actual Rows"]}, consumed rows=${consumedNode["Actual Rows"]}, latest lookup loops=${latest[0]?.["Actual Loops"]}, folder relations=${nodes.filter((node) => node["Relation Name"] === "asset_folder").length}`,
          );
          assert.equal(
            latest.length,
            1,
            "latest-version lookup has a bounded lateral limit",
          );
          for (const node of latest)
            assert.ok(
              Number(node["Actual Loops"]) <= Number(inputNode["Actual Rows"]),
              "latest versions only hydrate page assets",
            );
          if (name === "asset continuation") {
            assert.doesNotMatch(dialect.sqlToQuery(query).sql, /asset_folder/);
            assert.equal(
              nodes.some((node) => node["Relation Name"] === "asset_folder"),
              false,
            );
          }
        }
      },
    );
  },
);
