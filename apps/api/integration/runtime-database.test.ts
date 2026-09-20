import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";
import {
  assertRuntimeDatabaseRole,
  provisionRuntimeRole,
} from "../src/db/runtime-role.js";

const execFile = promisify(execFileCallback);

// Dedicated cluster only: no .env, deployed DB, object store or SMTP access.
test(
  "production runtime role, migrations, RLS and worker maintenance",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "vardum-runtime-test-"));
    const data = join(root, "data");
    const pgBin = process.env.PG_BINDIR ?? "/usr/bin";
    const cleanEnv = { PATH: process.env.PATH, LANG: "C" };
    const connection = (user: string) =>
      `postgresql://${user}@localhost/postgres?host=${encodeURIComponent(root)}`;
    let started = false;
    let admin: Pool | undefined;
    let runtime: Pool | undefined;
    let closeDatabase: (() => Promise<void>) | undefined;
    let stopQueue: (() => Promise<void>) | undefined;
    t.after(async () => {
      await stopQueue?.();
      await closeDatabase?.();
      await runtime?.end();
      await admin?.end();
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
    const appPassword = "isolated-runtime-test-password-32-characters";
    const env = {
      ...cleanEnv,
      NODE_ENV: "production",
      DATABASE_URL: connection("varda_app"),
      BETTER_AUTH_URL: "http://localhost:3000",
      WEB_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "isolated-runtime-test-auth-secret-32-characters",
      TRANSFORM_SECRET: "isolated-runtime-transform-secret-32-characters",
      AWS_EC2_METADATA_DISABLED: "true",
    };
    const migrate = () =>
      execFile(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/migrate.ts", import.meta.url)),
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: {
            ...env,
            DATABASE_URL: connection("postgres"),
            POSTGRES_APP_PASSWORD: appPassword,
          },
          timeout: 30_000,
        },
      );
    await t.test(
      "real deployment migrator creates a dedicated limited role and both schemas",
      async () => {
        await migrate();
        runtime = new Pool({
          connectionString: connection("varda_app"),
          max: 1,
        });
        await assertRuntimeDatabaseRole(runtime);
        await assert.rejects(
          assertRuntimeDatabaseRole(admin!),
          /Unsafe runtime database role/,
        );
        const role = (
          await admin!.query(
            "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='varda_app'",
          )
        ).rows[0];
        assert.deepEqual(Object.values(role), [
          false,
          false,
          false,
          false,
          false,
        ]);
        assert.equal(
          (await runtime.query("SELECT * FROM pgboss.version")).rowCount,
          1,
        );
        for (const sql of [
          "CREATE TABLE public.forbidden(id int)",
          "CREATE SCHEMA forbidden",
          "ALTER TABLE asset DISABLE ROW LEVEL SECURITY",
          "TRUNCATE asset",
          "SET ROLE postgres",
          "SELECT * FROM drizzle.__drizzle_migrations",
          "UPDATE pgboss.version SET version=1",
          "INSERT INTO pgboss.bam(name,version,command) VALUES ('bad',1,'SELECT 1')",
          "SELECT pgboss.job_table_run_async('bad',1,'SELECT 1')",
        ]) {
          await assert.rejects(
            runtime.query(sql),
            (error: unknown) => (error as { code: string }).code === "42501",
            sql,
          );
        }
      },
    );
    assert.ok(runtime);
    const tenantAssets = new Map<
      string,
      { assetId: string; versionId: string }
    >();
    await admin.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',now())",
    );
    for (const id of ["ws-a", "ws-b"]) {
      const assetId = randomUUID(),
        versionId = randomUUID();
      tenantAssets.set(id, { assetId, versionId });
      await admin.query(
        "INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ($1,'org',$1,$1,'test','test')",
        [id],
      );
      await admin.query(
        "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,$2,'logo','Logo','test','test')",
        [assetId, id],
      );
      await admin.query(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,created_by,updated_by) VALUES ($1,$2,$3,1,'ready',$2||'/logo','logo.png','image/png',4,'test','test')",
        [versionId, id, assetId],
      );
      await admin.query(
        "INSERT INTO delivery_event(workspace_id,asset_id,version_id,transformed,mime_type,bytes,created_at) VALUES ($1,$2,$3,false,'image/png',4,now()-interval '100 days'),($1,$2,$3,false,'image/png',4,now())",
        [id, assetId, versionId],
      );
    }
    await t.test(
      "RLS hides unscoped and other-workspace rows and rejects cross-workspace writes",
      async () => {
        assert.equal((await runtime!.query("SELECT * FROM asset")).rowCount, 0);
        await runtime!.query("BEGIN");
        try {
          await runtime!.query(
            "SELECT set_config('app.workspace_id','ws-a',true)",
          );
          assert.deepEqual(
            (await runtime!.query("SELECT workspace_id FROM asset")).rows,
            [{ workspace_id: "ws-a" }],
          );
          assert.equal(
            (
              await runtime!.query(
                "UPDATE asset SET display_name='Wrong' WHERE workspace_id='ws-b'",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await runtime!.query(
                "DELETE FROM asset WHERE workspace_id='ws-b'",
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            runtime!.query(
              "INSERT INTO asset(workspace_id,key,display_name,created_by,updated_by) VALUES ('ws-b','bad','Bad','test','test')",
            ),
            (error: unknown) => (error as { code: string }).code === "42501",
          );
        } finally {
          await runtime!.query("ROLLBACK");
        }
        // Pool size 1 guarantees this is the same physical connection after rollback.
        assert.equal((await runtime!.query("SELECT * FROM asset")).rowCount, 0);
        await runtime!.query("BEGIN");
        await runtime!.query(
          "SELECT set_config('app.workspace_id','ws-b',true)",
        );
        assert.equal(
          (
            await runtime!.query(
              "UPDATE asset SET display_name='Updated' WHERE workspace_id='ws-b'",
            )
          ).rowCount,
          1,
        );
        await runtime!.query("COMMIT");
        assert.equal(
          (await runtime!.query("SELECT * FROM asset")).rowCount,
          0,
          "tenant context must not leak after commit",
        );
        await runtime!.query("SET row_security=off");
        try {
          await assert.rejects(
            runtime!.query("SELECT * FROM asset"),
            /row-level security/,
          );
        } finally {
          await runtime!.query("SET row_security=on");
        }
      },
    );
    // Load the same production configuration used by the deployed API and worker.
    process.env = env;
    const database = await import("../src/db/index.js");
    closeDatabase = database.closeDatabase;
    const queue = await import("../src/queue.js");
    stopQueue = queue.stopQueue;
    await t.test(
      "runtime queue can send, schedule, fetch, complete and maintain jobs without DDL",
      async () => {
        const errors: Error[] = [];
        queue.boss.on("error", (error) => errors.push(error));
        await queue.startQueue();
        await queue.boss.schedule(
          queue.deliveryRetentionQueue,
          "0 3 * * *",
          null,
          { tz: "UTC" },
        );
        const jobId = await queue.boss.send(queue.assetDeleteQueue, {
          versionIds: [],
          storageKeys: [],
        });
        assert.ok(jobId);
        const jobs = await queue.boss.fetch(queue.assetDeleteQueue);
        assert.equal(jobs[0]?.id, jobId);
        await queue.boss.complete(queue.assetDeleteQueue, jobId);
        await queue.boss.supervise();
        assert.deepEqual(errors, []);
      },
    );
    await t.test(
      "retention visits each workspace under RLS and preserves recent delivery events",
      async () => {
        const { deleteExpiredDeliveryEvents } =
          await import("../src/delivery-analytics.js");
        await deleteExpiredDeliveryEvents();
        assert.deepEqual(
          (
            await admin!.query(
              "SELECT workspace_id,count(*)::int AS count FROM delivery_event GROUP BY workspace_id ORDER BY workspace_id",
            )
          ).rows,
          [
            { workspace_id: "ws-a", count: 1 },
            { workspace_id: "ws-b", count: 1 },
          ],
        );
        assert.equal(
          (await database.pool.query("SELECT * FROM delivery_event")).rowCount,
          0,
        );
      },
    );
    await t.test(
      "migration reruns preserve existing data and queued jobs",
      async () => {
        const pending = await queue.boss.send(queue.assetDeleteQueue, {
          versionIds: [],
          storageKeys: [],
        });
        await migrate();
        await migrate();
        assert.equal((await admin!.query("SELECT * FROM asset")).rowCount, 2);
        assert.equal(
          (
            await runtime!.query("SELECT * FROM pgboss.job WHERE id=$1", [
              pending,
            ])
          ).rowCount,
          1,
        );
        await assertRuntimeDatabaseRole(runtime!);
      },
    );
    await t.test(
      "startup guard rejects ownership, elevated flags, inherited roles and truncate grants",
      async () => {
        for (const [grant, revoke] of [
          [
            "ALTER ROLE varda_app BYPASSRLS",
            "ALTER ROLE varda_app NOBYPASSRLS",
          ],
          [
            "GRANT TRUNCATE ON asset TO varda_app",
            "REVOKE TRUNCATE ON asset FROM varda_app",
          ],
          [
            "GRANT CREATE ON SCHEMA public TO varda_app",
            "REVOKE CREATE ON SCHEMA public FROM varda_app",
          ],
          [
            "CREATE ROLE inherited_role; GRANT inherited_role TO varda_app",
            "REVOKE inherited_role FROM varda_app; DROP ROLE inherited_role",
          ],
          [
            "CREATE TABLE public.owner_check(id int); ALTER TABLE public.owner_check OWNER TO varda_app",
            "DROP TABLE public.owner_check",
          ],
        ]) {
          await admin!.query(grant!);
          try {
            await assert.rejects(
              assertRuntimeDatabaseRole(runtime!),
              /Unsafe runtime database role/,
            );
          } finally {
            await admin!.query(revoke!);
          }
        }
        await assertRuntimeDatabaseRole(runtime!);
        await admin!.query("ALTER ROLE varda_app BYPASSRLS");
        try {
          await assert.rejects(
            provisionRuntimeRole(admin!, appPassword),
            /Existing varda_app role/,
          );
        } finally {
          await admin!.query("ALTER ROLE varda_app NOBYPASSRLS");
        }
      },
    );
    await t.test(
      "API and worker entrypoints refuse to boot with administrator credentials",
      async () => {
        for (const entry of ["server.ts", "worker.ts"]) {
          await assert.rejects(
            execFile(
              process.execPath,
              [
                "--import",
                "tsx",
                fileURLToPath(new URL(`../src/${entry}`, import.meta.url)),
              ],
              {
                cwd: fileURLToPath(new URL("../../../", import.meta.url)),
                env: { ...env, DATABASE_URL: connection("postgres") },
                timeout: 10_000,
              },
            ),
            (error: unknown) => {
              const result = error as {
                code: number;
                stdout: string;
                stderr: string;
              };
              return (
                result.code === 1 &&
                /Unsafe runtime database role/.test(
                  result.stdout + result.stderr,
                )
              );
            },
          );
        }
      },
    );
  },
);
