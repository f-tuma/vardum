import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { seedKnownUsageFixture } from "./known-usages.fixture.js";
import type {
  Destination,
  Evidence,
  Source,
  StoredBinding,
} from "../src/known-usage-model.js";
const execFile = promisify(execFileCallback);
type Binding = StoredBinding & {
  current: {
    resolved: boolean;
    reason: string | null;
    source: Source | null;
    scopeToken: string;
  };
  latestEvidence: Evidence | null;
  status: string;
};
type Consumer = {
  id: string;
  name: string;
  kind: "first_party" | "selected_external";
  revision: number;
  destinations: Destination[];
  bindings: Binding[];
};

// No .env, deployed database, object store, SMTP, or registered destination access.
test(
  "known usage: disposable PostgreSQL with actual restricted role, auth and RLS",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "vardum-known-usage-test-"));
    const data = join(root, "data"),
      pgBin = process.env.PG_BINDIR ?? "/usr/bin";
    const cleanEnv = { PATH: process.env.PATH, LANG: "C" };
    const connection = (user: string) =>
      `postgresql://${user}@localhost/postgres?host=${encodeURIComponent(root)}`;
    let started = false,
      admin: Pool | undefined;
    let closeApp: (() => Promise<unknown>) | undefined,
      closeDatabase: (() => Promise<void>) | undefined,
      destroyStorage: (() => void) | undefined,
      stopQueue: (() => Promise<void>) | undefined;
    t.after(async () => {
      await closeApp?.();
      await stopQueue?.();
      destroyStorage?.();
      await closeDatabase?.();
      await admin?.end();
      if (started)
        await execFile(
          join(pgBin, "pg_ctl"),
          ["-D", data, "-m", "fast", "-w", "stop"],
          { env: cleanEnv },
        );
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
    admin = new Pool({ connectionString: connection("postgres") });
    process.env = {
      ...cleanEnv,
      NODE_ENV: "test",
      DATABASE_URL: connection("varda_app"),
      BETTER_AUTH_URL: "http://localhost:3000",
      WEB_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "isolated-known-usage-auth-secret-32-characters",
      TRANSFORM_SECRET: "isolated-known-usage-transform-secret-32-characters",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_BUCKET: "fixture",
      S3_ACCESS_KEY_ID: "fixture",
      S3_SECRET_ACCESS_KEY: "fixture",
      AWS_EC2_METADATA_DISABLED: "true",
    };
    const migrationsFolder = fileURLToPath(
      new URL("../drizzle", import.meta.url),
    );
    await migrate(drizzle(admin), { migrationsFolder });
    const { migrateQueue } = await import("../src/queue-migrate.js");
    await migrateQueue(connection("postgres"));
    const { provisionRuntimeRole, assertRuntimeDatabaseRole } =
      await import("../src/db/runtime-role.js");
    await provisionRuntimeRole(admin, "isolated-known-usage-runtime-password");
    const database = await import("../src/db/index.js");
    closeDatabase = database.closeDatabase;
    await assertRuntimeDatabaseRole(database.pool);
    const { buildApp } = await import("../src/app.js");
    const { storage } = await import("../src/storage.js");
    destroyStorage = () => storage.destroy();
    const app = await buildApp();
    closeApp = () => app.close();
    const queue = await import("../src/queue.js");
    await queue.startQueue();
    stopQueue = queue.stopQueue;
    const f = await seedKnownUsageFixture(app, admin);
    const sql = (text: string, values: unknown[] = []) =>
      admin!.query(text, values);
    const headers = { cookie: f.cookies.owner! };
    const base = "/api/workspaces/usage-ws/known-usages";
    const create = (payload: unknown = f.input, customHeaders = headers) =>
      app.inject({
        method: "POST",
        url: base,
        headers: customHeaders,
        payload,
      });
    const get = async (id: string) => {
      const response = await app.inject({
        method: "GET",
        url: `${base}/${id}`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Consumer>();
    };
    const fields = (row: Consumer) => ({
      name: row.name,
      kind: row.kind,
      destinations: row.destinations,
      bindings: row.bindings.map(({ id, destinationId, mode, target }) => ({
        id,
        destinationId,
        mode,
        target,
      })),
    });
    const replace = (row: Consumer, changes: Record<string, unknown> = {}) =>
      app.inject({
        method: "PUT",
        url: `${base}/${row.id}`,
        headers,
        payload: { expectedRevision: row.revision, ...fields(row), ...changes },
      });
    const report = (
      row: Consumer,
      index = 0,
      changes: Record<string, unknown> = {},
    ) =>
      app.inject({
        method: "POST",
        url: `${base}/${row.id}/bindings/${row.bindings[index]!.id}/checks`,
        headers,
        payload: {
          expectedRevision: row.revision,
          expectedScopeToken: row.bindings[index]!.current.scopeToken,
          checkedAt: "2026-01-02T03:04:05Z",
          reportedVersionId: row.bindings[index]!.current.source!.versionId,
          ...changes,
        },
      });
    let consumer: Consumer;
    await t.test(
      "CRUD declares first-party/external destinations and specific original/manual/generated sources without checks",
      async () => {
        const response = await create();
        assert.equal(response.statusCode, 201, response.body);
        consumer = response.json<Consumer>();
        assert.equal(consumer.revision, 1);
        assert.equal(consumer.bindings.length, 3);
        for (const binding of consumer.bindings) {
          assert.equal(binding.status, "unknown");
          assert.equal(binding.latestEvidence, null);
          assert.equal(binding.current.resolved, true);
        }
        assert.match(consumer.bindings[1]!.current.source!.fingerprint, /w=64/);
        assert.equal(
          consumer.bindings[2]!.current.source!.assetId,
          f.folder.id,
        );
        const edited = await replace(consumer, {
          name: "External launch website",
          kind: "selected_external",
        });
        assert.equal(edited.statusCode, 200, edited.body);
        consumer = edited.json();
        assert.equal(consumer.revision, 2);
        assert.equal(consumer.kind, "selected_external");
        assert.equal(
          (await sql("SELECT * FROM known_usage_check")).rowCount,
          0,
          "create/edit must not imply a check",
        );
        const noVersion = await create({
          ...f.input,
          bindings: [
            {
              ...f.input.bindings[0],
              id: randomUUID(),
              target: { kind: "asset", assetId: f.empty.id },
            },
          ],
        });
        assert.equal(noVersion.statusCode, 201, noVersion.body);
        assert.equal(noVersion.json().bindings[0].status, "unresolved");
        assert.equal(noVersion.json().bindings[0].latestEvidence, null);
      },
    );
    await t.test(
      "real auth rejects viewer/API-read writes, outsider/cross-workspace reads and anonymous inventory despite public Vard",
      async () => {
        const readonly = await app.inject({
          method: "POST",
          url: "/api/workspaces/usage-ws/api-keys",
          headers,
          payload: { name: "Usage read only", access: "read" },
        });
        assert.equal(readonly.statusCode, 200, readonly.body);
        for (const [customHeaders, expected] of [
          [{}, 401],
          [{ cookie: f.cookies.viewer! }, 403],
          [{ cookie: f.cookies.outsider! }, 403],
          [{ "x-api-key": readonly.json().key }, 401],
        ] as const) {
          assert.equal(
            (await create(f.input, customHeaders)).statusCode,
            expected,
          );
          for (const [method, url, payload] of [
            [
              "PUT",
              `${base}/${consumer.id}`,
              { expectedRevision: consumer.revision, ...fields(consumer) },
            ],
            [
              "DELETE",
              `${base}/${consumer.id}`,
              { expectedRevision: consumer.revision },
            ],
            [
              "POST",
              `${base}/${consumer.id}/bindings/${consumer.bindings[0]!.id}/checks`,
              {
                expectedRevision: consumer.revision,
                expectedScopeToken: consumer.bindings[0]!.current.scopeToken,
                checkedAt: "2026-01-02T03:04:05Z",
                reportedVersionId: f.logo.versionId,
              },
            ],
          ] as const)
            assert.equal(
              (
                await app.inject({
                  method,
                  url,
                  payload,
                  headers: customHeaders,
                })
              ).statusCode,
              expected,
            );
        }
        for (const customHeaders of [
          { cookie: f.cookies.viewer! },
          { "x-api-key": readonly.json().key },
        ])
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: base,
                headers: customHeaders,
              })
            ).statusCode,
            200,
          );
        assert.equal(
          (await app.inject({ method: "GET", url: base })).statusCode,
          401,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `${base}/${consumer.id}`,
              headers: { cookie: f.cookies.outsider! },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/api/workspaces/other-ws/known-usages/${consumer.id}`,
              headers: { cookie: f.cookies.outsider! },
            })
          ).statusCode,
          404,
        );
        const publicVard = await app.inject({
          method: "GET",
          url: `/v/${f.vardId}`,
        });
        assert.equal(publicVard.statusCode, 200, publicVard.body);
        assert.doesNotMatch(
          publicVard.body,
          /knownUsage|known_usage|destinations|private-destination|Consumer website/,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `${base}/${consumer.id}`,
              headers,
            })
          ).headers["cache-control"],
          "private, no-store",
        );
      },
    );
    await t.test(
      "missing, foreign, rebound and unsafe declarations cannot be registered/relinked",
      async () => {
        for (const target of [
          { kind: "asset", assetId: randomUUID() },
          { kind: "asset", assetId: f.foreign.id },
          {
            kind: "vard_output",
            vardId: f.foreignVardId,
            outputPath: "images/foreign.png",
            assetId: f.foreign.id,
          },
          {
            kind: "vard_output",
            vardId: f.vardId,
            outputPath: "images/missing.png",
            assetId: f.logo.id,
          },
          {
            kind: "vard_output",
            vardId: f.vardId,
            outputPath: "images/logo.png",
            assetId: f.folder.id,
          },
        ])
          assert.equal(
            (
              await create({
                ...f.input,
                bindings: [{ ...f.input.bindings[0], target }],
              })
            ).statusCode,
            404,
          );
        const foreignRelink = await replace(consumer, {
          bindings: [
            {
              ...f.input.bindings[0],
              target: { kind: "asset", assetId: f.foreign.id },
            },
          ],
        });
        assert.equal(foreignRelink.statusCode, 404);
        for (const url of [
          "file:///tmp/private",
          "relative/page",
          "https://secret:password@example.test",
          "https://example.test/" + "x".repeat(2048),
        ])
          assert.equal(
            (
              await create({
                ...f.input,
                destinations: [{ ...f.input.destinations[0], url }],
              })
            ).statusCode,
            400,
          );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `${base}?limit=51`,
              headers,
            })
          ).statusCode,
          400,
        );
      },
    );
    await t.test(
      "explicit reports preserve actor/scope/source/version/time and reject stale/missing/foreign reports",
      async () => {
        for (const changes of [
          { checkedAt: undefined },
          { checkedAt: "2026-02-30T00:00:00Z" },
          { checkedAt: new Date(Date.now() + 600_000).toISOString() },
        ])
          assert.equal((await report(consumer, 0, changes)).statusCode, 400);
        for (const reportedVersionId of [randomUUID(), f.foreign.versionId])
          assert.equal(
            (await report(consumer, 0, { reportedVersionId })).statusCode,
            404,
          );
        const response = await report(consumer, 0, {
          commitRef: "abc123",
          releaseRef: "release-4",
          note: "Manually checked the declared website.",
        });
        assert.equal(response.statusCode, 200, response.body);
        consumer = response.json();
        const evidence = consumer.bindings[0]!.latestEvidence!;
        assert.equal(consumer.bindings[0]!.status, "recorded_match");
        assert.equal(evidence.actor, `user:${f.users.owner}`);
        assert.equal(
          evidence.checkedAt as unknown as string,
          "2026-01-02T03:04:05.000Z",
        );
        assert.equal(evidence.source.versionId, f.logo.versionId);
        assert.equal(
          evidence.scope.destination.url,
          f.input.destinations[0]!.url,
        );
        assert.equal(evidence.commitRef, "abc123");
        assert.equal(
          (
            await report(consumer, 0, {
              expectedRevision: consumer.revision - 1,
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (await report(consumer, 0, { expectedScopeToken: "0".repeat(64) }))
            .statusCode,
          409,
        );
        const history = await app.inject({
          method: "GET",
          url: `${base}/${consumer.id}/bindings/${consumer.bindings[0]!.id}/checks`,
          headers,
        });
        assert.equal(history.statusCode, 200);
        assert.equal(history.json().checks.length, 1);
        await assert.rejects(
          database.pool.query("UPDATE known_usage_check SET actor='forged'"),
          (error: unknown) => (error as { code: string }).code === "42501",
        );
        await assert.rejects(
          database.pool.query("DELETE FROM known_usage_check"),
          (error: unknown) => (error as { code: string }).code === "42501",
        );
      },
    );
    await t.test(
      "check history is newest recorded first across UUID cursors and microsecond timestamps",
      async () => {
        const created = await create({
          ...f.input,
          bindings: [f.input.bindings[0]],
        });
        assert.equal(created.statusCode, 201, created.body);
        const checked = await report(created.json());
        assert.equal(checked.statusCode, 200, checked.body);
        const row = checked.json<Consumer>();
        const seed = row.bindings[0]!.latestEvidence!;
        const ids = Array.from(
          { length: 25 },
          (_, index) =>
            `ffffffff-ffff-4fff-8fff-${(index + 1).toString(16).padStart(12, "0")}`,
        );
        for (const [index, id] of ids.entries())
          await sql(
            "INSERT INTO known_usage_check(id,workspace_id,consumer_id,binding_id,checked_at,recorded_at,actor,source,scope) SELECT $1::uuid,workspace_id,consumer_id,binding_id,checked_at,now()+$2::int*interval '1 microsecond',actor,source,scope FROM known_usage_check WHERE id=$3::uuid",
            [id, index + 1, seed.id],
          );
        // Use one common timestamp base, with a true sub-millisecond boundary.
        for (const [index, id] of ids.entries())
          await sql(
            "UPDATE known_usage_check SET recorded_at='2026-10-11 00:00:00.123000+00'::timestamptz + $2::int*interval '1 microsecond' WHERE id=$1",
            [id, index + 1],
          );
        await sql(
          "UPDATE known_usage_check SET recorded_at='2026-10-10 00:00:00+00' WHERE id=$1",
          [seed.id],
        );
        const endpoint = `${base}/${row.id}/bindings/${row.bindings[0]!.id}/checks`;
        const first = await app.inject({
          method: "GET",
          url: endpoint,
          headers,
        });
        assert.equal(first.statusCode, 200, first.body);
        assert.deepEqual(
          first.json().checks.map((item: Evidence) => item.id),
          ids.slice(5).reverse(),
        );
        assert.equal(first.json().nextCursor, ids[5]);
        const second = await app.inject({
          method: "GET",
          url: `${endpoint}?after=${first.json().nextCursor}`,
          headers,
        });
        assert.equal(second.statusCode, 200, second.body);
        assert.deepEqual(
          second.json().checks.map((item: Evidence) => item.id),
          [...ids.slice(0, 5).reverse(), seed.id],
        );
        assert.equal(second.json().nextCursor, null);
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `${endpoint}?after=${randomUUID()}`,
              headers,
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `${endpoint}?after=${consumer.bindings[0]!.latestEvidence!.id}`,
              headers,
            })
          ).statusCode,
          404,
        );
        const deleted = await app.inject({
          method: "DELETE",
          url: `${base}/${row.id}`,
          headers,
          payload: { expectedRevision: row.revision },
        });
        assert.equal(deleted.statusCode, 204, deleted.body);
      },
    );
    await t.test(
      "historical source versions page past recent failed versions while retaining tenant isolation",
      async () => {
        const old = await f.insertAsset("historical.png");
        await sql(
          "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,created_by,updated_by) SELECT gen_random_uuid(),'usage-ws',$1,n,'failed','fixture-historical-'||n,'historical.png','image/png',4,'fixture','fixture' FROM generate_series(2,101) n",
          [old.id],
        );
        const endpoint = `/api/workspaces/usage-ws/assets/${old.id}/versions`;
        const page = async (suffix = "") => {
          const response = await app.inject({
            method: "GET",
            url: endpoint + suffix,
            headers,
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().currentVersionId, old.versionId);
          return response.json();
        };
        const first = await page();
        assert.equal(first.versions.length, 50);
        assert.equal(first.nextCursor, 52);
        assert.ok(
          first.versions.every(
            (item: { status: string }) => item.status === "failed",
          ),
        );
        const second = await page(`?before=${first.nextCursor}`);
        assert.equal(second.versions.length, 50);
        assert.equal(second.nextCursor, 2);
        const third = await page(`?before=${second.nextCursor}`);
        assert.equal(third.versions.length, 1);
        assert.equal(third.nextCursor, null);
        assert.equal(third.versions[0].id, old.versionId);
        assert.equal(third.versions[0].current, true);
        assert.equal(
          new Set(
            [...first.versions, ...second.versions, ...third.versions].map(
              (item: { id: string }) => item.id,
            ),
          ).size,
          101,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: endpoint + "?before=0",
              headers,
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: endpoint + "?before=2147483648",
              headers,
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: endpoint + "?before=2",
              headers: { cookie: f.cookies.outsider! },
            })
          ).statusCode,
          403,
        );
      },
    );
    await t.test(
      "new current sources do not auto-check; historical manually reported versions show source changed",
      async () => {
        const version2 = randomUUID();
        await sql(
          "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1::uuid,'usage-ws',$2,2,'ready',$1::text,'logo-v2.png','image/png',4,$3,'fixture','fixture')",
          [version2, f.logo.id, "b".repeat(64)],
        );
        await sql("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
          version2,
          f.logo.id,
        ]);
        consumer = await get(consumer.id);
        assert.equal(consumer.bindings[0]!.status, "source_changed");
        assert.equal(
          consumer.bindings[0]!.latestEvidence!.source.versionId,
          f.logo.versionId,
        );
        assert.equal(
          (await sql("SELECT count(*)::int AS count FROM known_usage_check"))
            .rows[0].count,
          1,
        );
        const historical = await report(consumer, 0, {
          reportedVersionId: f.logo.versionId,
        });
        assert.equal(historical.statusCode, 200, historical.body);
        consumer = historical.json();
        assert.equal(consumer.bindings[0]!.status, "source_changed");
        const current = await report(consumer);
        assert.equal(current.statusCode, 200, current.body);
        consumer = current.json();
        assert.equal(consumer.bindings[0]!.status, "recorded_match");
      },
    );
    await t.test(
      "changed destination/mode/output parameters invalidate scope and retain recognizable old reports",
      async () => {
        const before = consumer.bindings[0]!.latestEvidence!;
        const response = await replace(consumer, {
          destinations: [
            {
              ...consumer.destinations[0],
              url: "https://new-destination.usage.test",
            },
          ],
        });
        assert.equal(response.statusCode, 200, response.body);
        consumer = response.json();
        assert.equal(consumer.bindings[0]!.status, "scope_changed");
        assert.deepEqual(consumer.bindings[0]!.latestEvidence, before);
        const reported = await report(consumer, 1);
        assert.equal(reported.statusCode, 200, reported.body);
        consumer = reported.json();
        const oldScope = consumer.bindings[1]!.current.scopeToken;
        const updateOutput = await app.inject({
          method: "PUT",
          url: `/api/workspaces/usage-ws/vards/${f.vardId}/items`,
          headers,
          payload: {
            items: [
              {
                assetId: f.logo.id,
                outputPath: "images/logo.png",
                transformation: { w: 128 },
              },
            ],
          },
        });
        assert.equal(updateOutput.statusCode, 200, updateOutput.body);
        assert.equal((await report(consumer, 1)).statusCode, 409);
        consumer = await get(consumer.id);
        assert.notEqual(consumer.bindings[1]!.current.scopeToken, oldScope);
        assert.equal(consumer.bindings[1]!.status, "scope_changed");
        const editedBindings = fields(consumer).bindings.map(
          (binding, index) =>
            index === 1 ? { ...binding, mode: "live_url" } : binding,
        );
        const changedMode = await replace(consumer, {
          bindings: editedBindings,
        });
        assert.equal(changedMode.statusCode, 200, changedMode.body);
        consumer = changedMode.json();
        assert.equal(consumer.bindings[1]!.status, "scope_changed");
        assert.equal(
          consumer.bindings[1]!.latestEvidence!.scope.mode,
          "opt_in_pr",
        );
      },
    );
    await t.test(
      "independent revisions prevent concurrent lost edits/checks/deletion",
      async () => {
        const results = await Promise.all(
          ["First", "Second"].map((name) => replace(consumer, { name })),
        );
        assert.deepEqual(
          results.map((result) => result.statusCode).sort(),
          [200, 409],
        );
        consumer = results.find((result) => result.statusCode === 200)!.json();
        const mixed = await Promise.all([
          replace(consumer, { name: "Concurrent edit" }),
          report(consumer),
        ]);
        assert.deepEqual(
          mixed.map((result) => result.statusCode).sort(),
          [200, 409],
        );
        consumer = mixed.find((result) => result.statusCode === 200)!.json();
        const staleDelete = await app.inject({
          method: "DELETE",
          url: `${base}/${consumer.id}`,
          headers,
          payload: { expectedRevision: consumer.revision - 1 },
        });
        assert.equal(staleDelete.statusCode, 409);
        assert.equal((await get(consumer.id)).revision, consumer.revision);
      },
    );
    await t.test(
      "asset/Vard deletion retains original identities and reports, permits editing/removing unresolved declarations",
      async () => {
        const originalLabel = consumer.bindings[1]!.targetLabel,
          evidence = consumer.bindings[1]!.latestEvidence!;
        const deletedVard = await app.inject({
          method: "DELETE",
          url: `/api/workspaces/usage-ws/vards/${f.vardId}`,
          headers,
        });
        assert.equal(deletedVard.statusCode, 204, deletedVard.body);
        const deletedAsset = await app.inject({
          method: "DELETE",
          url: `/api/workspaces/usage-ws/assets/${f.logo.id}`,
          headers,
        });
        assert.equal(deletedAsset.statusCode, 204, deletedAsset.body);
        consumer = await get(consumer.id);
        assert.equal(consumer.bindings[0]!.status, "unresolved");
        assert.equal(consumer.bindings[1]!.status, "unresolved");
        assert.equal(consumer.bindings[1]!.targetLabel, originalLabel);
        assert.deepEqual(consumer.bindings[1]!.latestEvidence, evidence);
        assert.equal(consumer.bindings[1]!.target.assetId, f.logo.id);
        const edit = await replace(consumer, {
          name: "Missing sources remain recognizable",
        });
        assert.equal(edit.statusCode, 200, edit.body);
        consumer = edit.json();
        const relink = await replace(consumer, {
          bindings: [
            {
              ...fields(consumer).bindings[0],
              target: { kind: "asset", assetId: f.folder.id },
            },
          ],
        });
        assert.equal(relink.statusCode, 200, relink.body);
        consumer = relink.json();
        assert.equal(consumer.bindings[0]!.status, "scope_changed");
        assert.equal(
          consumer.bindings[0]!.latestEvidence!.source.assetId,
          f.logo.id,
        );
        const remove = await replace(consumer, { bindings: [] });
        assert.equal(remove.statusCode, 200, remove.body);
        consumer = remove.json();
        assert.equal(consumer.bindings.length, 0);
      },
    );
    await t.test(
      "many unselected Vard outputs and repeated selections keep inventory resolution bounded to requested sources",
      async () => {
        const manyVardId = randomUUID();
        await sql(
          "INSERT INTO vard(id,workspace_id,name,created_by,updated_by) VALUES ($1,'usage-ws','Many outputs','fixture','fixture')",
          [manyVardId],
        );
        await sql(
          "CREATE TEMP TABLE many_usage_sources AS SELECT gen_random_uuid() AS asset_id,gen_random_uuid() AS version_id,n FROM generate_series(1,999) AS n",
        );
        await sql(
          "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) SELECT asset_id,'usage-ws','many/'||n::text||'.png','Extra '||n::text,'fixture','fixture' FROM many_usage_sources",
        );
        await sql(
          "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,created_by,updated_by) SELECT version_id,'usage-ws',asset_id,1,'ready',version_id::text,n::text||'.png','image/png',4,'fixture','fixture' FROM many_usage_sources",
        );
        await sql(
          "UPDATE asset SET current_version_id=s.version_id FROM many_usage_sources s WHERE asset.id=s.asset_id",
        );
        await sql(
          "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) SELECT 'usage-ws',$1,asset_id,'extra/'||n::text||'.png','fixture','fixture' FROM many_usage_sources",
          [manyVardId],
        );
        await sql(
          "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) VALUES ('usage-ws',$1,$2,'selected/banner.png','fixture','fixture')",
          [manyVardId, f.folder.id],
        );
        const input = {
          ...f.input,
          bindings: Array.from({ length: 100 }, () => ({
            id: randomUUID(),
            destinationId: f.input.destinations[0]!.id,
            mode: "live_url",
            target: {
              kind: "vard_output",
              vardId: manyVardId,
              outputPath: "selected/banner.png",
              assetId: f.folder.id,
            },
          })),
        };
        const response = await create(input);
        assert.equal(response.statusCode, 201, response.body);
        const row = await get(response.json().id);
        assert.equal(row.bindings.length, 100);
        assert.ok(
          row.bindings.every(
            (binding) => binding.current.source?.assetId === f.folder.id,
          ),
        );
        assert.doesNotMatch(JSON.stringify(row), /Extra [0-9]|extra\/[0-9]/);
        const defaultManifest = await app.inject({
          method: "GET",
          url: `/api/workspaces/usage-ws/vards/${manyVardId}/manifest`,
          headers,
        });
        assert.equal(defaultManifest.statusCode, 200, defaultManifest.body);
        assert.equal(defaultManifest.json().items.length, 1000);
        await sql(
          "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) VALUES ('usage-ws',$1,$2,'unselected-overflow.png','fixture','fixture')",
          [manyVardId, f.folder.id],
        );
        assert.ok(
          (await get(row.id)).bindings.every(
            (binding) => binding.current.reason === "vard_outputs_invalid",
          ),
        );
        await sql(
          "DELETE FROM vard_item WHERE vard_id=$1 AND output_path='unselected-overflow.png'",
          [manyVardId],
        );
        await sql(
          "UPDATE vard_item SET output_path='EXTRA/2.PNG' WHERE vard_id=$1 AND output_path='extra/1.png'",
          [manyVardId],
        );
        assert.ok(
          (await get(row.id)).bindings.every(
            (binding) => binding.current.reason === "vard_outputs_invalid",
          ),
        );
        const deleted = await app.inject({
          method: "DELETE",
          url: `${base}/${row.id}`,
          headers,
          payload: { expectedRevision: row.revision },
        });
        assert.equal(deleted.statusCode, 204);
        await sql("DROP TABLE many_usage_sources");
      },
    );
    await t.test(
      "high-cardinality inventory pages cap 100 distinct Vards and preserve every consumer across budget cursors",
      async () => {
        await sql(
          "INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ('budget-ws','usage-org','Budget fixture','budget-fixture','fixture','fixture')",
        );
        const source = await f.insertAsset("budget.png", "budget-ws");
        const vardIds = Array.from({ length: 200 }, () => randomUUID());
        await sql(
          "INSERT INTO vard(id,workspace_id,name,created_by,updated_by) SELECT id,'budget-ws','Budget '||id::text,'fixture','fixture' FROM unnest($1::uuid[]) id",
          [vardIds],
        );
        await sql(
          "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,created_by,updated_by) SELECT 'budget-ws',id,$2,'selected.png','fixture','fixture' FROM unnest($1::uuid[]) id",
          [vardIds, source.id],
        );
        const ids = [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003",
        ];
        for (const [index, id] of ids.entries()) {
          const destination = {
            id: randomUUID(),
            label: "Budget website",
            url: "https://budget.usage.test",
          };
          const bindings = vardIds
            .slice(index * 100, (index + 1) * 100)
            .map((vardId) => ({
              id: randomUUID(),
              destinationId: destination.id,
              mode: "live_url",
              target: {
                kind: "vard_output",
                vardId,
                outputPath: "selected.png",
                assetId: source.id,
              },
              targetLabel: "Budget output",
            }));
          await sql(
            "INSERT INTO known_usage(id,workspace_id,name,kind,destinations,bindings,created_by,updated_by) VALUES ($1,'budget-ws',$2,'first_party',$3,$4,'fixture','fixture')",
            [
              id,
              `Budget ${index}`,
              JSON.stringify([destination]),
              JSON.stringify(bindings),
            ],
          );
        }
        const budgetEndpoint =
          "/api/workspaces/budget-ws/known-usages?limit=50";
        const first = await app.inject({
          method: "GET",
          url: budgetEndpoint,
          headers,
        });
        assert.equal(first.statusCode, 200, first.body);
        assert.deepEqual(
          first.json().consumers.map((item: Consumer) => item.id),
          [ids[0]],
        );
        assert.equal(first.json().nextCursor, ids[0]);
        assert.equal(first.json().consumers[0].bindings.length, 100);
        assert.ok(
          first
            .json()
            .consumers[0].bindings.every(
              (item: Binding) => item.current.resolved,
            ),
        );
        const second = await app.inject({
          method: "GET",
          url: `${budgetEndpoint}&after=${first.json().nextCursor}`,
          headers,
        });
        assert.equal(second.statusCode, 200, second.body);
        assert.deepEqual(
          second.json().consumers.map((item: Consumer) => item.id),
          ids.slice(1),
        );
        assert.equal(second.json().nextCursor, null);
        assert.equal(second.json().consumers[0].bindings.length, 100);
        assert.equal(
          new Set(
            [...first.json().consumers, ...second.json().consumers].map(
              (item: Consumer) => item.id,
            ),
          ).size,
          3,
        );
        await sql("DELETE FROM workspace WHERE id='budget-ws'");
      },
    );
    await t.test(
      "unknown check binding returns 404 while removed bindings retain readable history",
      async () => {
        const missing = await app.inject({
          method: "GET",
          url: `${base}/${consumer.id}/bindings/${randomUUID()}/checks`,
          headers,
        });
        assert.equal(missing.statusCode, 404, missing.body);
        const removed = f.input.bindings[0]!.id;
        const history = await app.inject({
          method: "GET",
          url: `${base}/${consumer.id}/bindings/${removed}/checks`,
          headers,
        });
        assert.equal(history.statusCode, 200, history.body);
        assert.ok(history.json().checks.length > 0);
      },
    );
    await t.test(
      "source registration and deletion share the content guard; accepted declarations remain recognizable",
      async () => {
        const raceAsset = await f.insertAsset("race.png");
        const input = {
          ...f.input,
          bindings: [
            {
              ...f.input.bindings[0],
              target: { kind: "asset", assetId: raceAsset.id },
            },
          ],
        };
        const [registered, deleted] = await Promise.all([
          create(input),
          app.inject({
            method: "DELETE",
            url: `/api/workspaces/usage-ws/assets/${raceAsset.id}`,
            headers,
          }),
        ]);
        assert.equal(deleted.statusCode, 204, deleted.body);
        assert.ok([201, 404].includes(registered.statusCode), registered.body);
        if (registered.statusCode === 201) {
          const row = await get(registered.json().id);
          assert.equal(row.bindings[0]!.status, "unresolved");
          assert.equal(row.bindings[0]!.targetLabel, "race.png");
        }
      },
    );
    await t.test(
      "database RLS is private even public assets/Vards; runtime deletion cascades and migration reruns retain data",
      async () => {
        for (const table of ["known_usage", "known_usage_check"])
          assert.equal(
            (await database.pool.query(`SELECT * FROM ${table}`)).rowCount,
            0,
          );
        const runtime = await database.pool.connect();
        try {
          await runtime.query("BEGIN");
          await runtime.query(
            "SELECT set_config('app.workspace_id','other-ws',true)",
          );
          assert.equal(
            (await runtime.query("SELECT * FROM known_usage")).rowCount,
            0,
          );
          assert.equal(
            (await runtime.query("SELECT * FROM known_usage_check")).rowCount,
            0,
          );
          await assert.rejects(
            runtime.query(
              "INSERT INTO known_usage(workspace_id,name,kind,destinations,bindings,created_by,updated_by) VALUES ('usage-ws','Wrong','first_party','[{}]','[]','fixture','fixture')",
            ),
            (error: unknown) => (error as { code: string }).code === "42501",
          );
          await runtime.query("ROLLBACK");
        } finally {
          runtime.release();
        }
        await migrate(drizzle(admin!), { migrationsFolder });
        await provisionRuntimeRole(
          admin!,
          "isolated-known-usage-runtime-password",
        );
        await assertRuntimeDatabaseRole(database.pool);
        assert.ok((await sql("SELECT * FROM known_usage_check")).rowCount! > 0);
        const deleted = await app.inject({
          method: "DELETE",
          url: `${base}/${consumer.id}`,
          headers,
          payload: { expectedRevision: consumer.revision },
        });
        assert.equal(deleted.statusCode, 204, deleted.body);
        assert.equal(
          (
            await sql("SELECT * FROM known_usage_check WHERE consumer_id=$1", [
              consumer.id,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `${base}/${consumer.id}`,
              headers,
            })
          ).statusCode,
          404,
        );
        assert.deepEqual(
          (
            await sql(
              "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('known_usage','known_usage_check') ORDER BY relname",
            )
          ).rows.map((row) => [row.relrowsecurity, row.relforcerowsecurity]),
          [
            [true, true],
            [true, true],
          ],
        );
      },
    );
    await t.test(
      "consumer/report/page limits bound inventory growth including rotating binding IDs",
      async () => {
        const input = {
          ...f.input,
          bindings: [
            {
              ...f.input.bindings[0],
              target: { kind: "asset", assetId: f.folder.id },
            },
          ],
        };
        const created = await create(input);
        assert.equal(created.statusCode, 201, created.body);
        const row = created.json<Consumer>();
        await sql(
          "INSERT INTO known_usage_check(workspace_id,consumer_id,binding_id,checked_at,actor,source,scope) SELECT 'usage-ws',$1,$2,now(),'fixture','{}','{}' FROM generate_series(1,1000)",
          [row.id, row.bindings[0]!.id],
        );
        // Rotating a binding identity cannot evade the total immutable history cap.
        const rotated = await replace(row, {
          bindings: [{ ...input.bindings[0], id: randomUUID() }],
        });
        assert.equal(rotated.statusCode, 200, rotated.body);
        const limited = await report(rotated.json());
        assert.equal(limited.statusCode, 409, limited.body);
        assert.match(limited.body, /report limit/);
        const count = (
          await sql(
            "SELECT count(*)::int AS count FROM known_usage WHERE workspace_id='usage-ws'",
          )
        ).rows[0].count as number;
        await sql(
          "INSERT INTO known_usage(workspace_id,name,kind,destinations,bindings,created_by,updated_by) SELECT 'usage-ws','Limit consumer','first_party',$1,'[]','fixture','fixture' FROM generate_series(1,$2)",
          [JSON.stringify(f.input.destinations), 200 - count],
        );
        assert.equal(
          (await create({ ...f.input, bindings: [] })).statusCode,
          409,
        );
        const first = await app.inject({
          method: "GET",
          url: `${base}?limit=50`,
          headers,
        });
        assert.equal(first.statusCode, 200, first.body);
        assert.equal(first.json().consumers.length, 50);
        assert.ok(first.json().nextCursor);
        const second = await app.inject({
          method: "GET",
          url: `${base}?limit=50&after=${first.json().nextCursor}`,
          headers,
        });
        assert.equal(second.statusCode, 200, second.body);
        assert.equal(second.json().consumers.length, 50);
        assert.equal(
          new Set(
            [...first.json().consumers, ...second.json().consumers].map(
              (item: Consumer) => item.id,
            ),
          ).size,
          100,
        );
        // Workspace cascade exercises revoked evidence DELETE grants via actual API.
        const cascade = await app.inject({
          method: "DELETE",
          url: "/api/workspaces/usage-ws",
          headers,
          payload: { confirmation: "usage-fixture" },
        });
        assert.equal(cascade.statusCode, 204, cascade.body);
        assert.equal(
          (await sql("SELECT * FROM known_usage_check")).rowCount,
          0,
        );
      },
    );
  },
);
