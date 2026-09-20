import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const execFile = promisify(execFileCallback);

// Never reads .env or connects to an existing database. Run as an unprivileged
// user with PostgreSQL binaries in PG_BINDIR (or /usr/bin).
test(
  "organization allowlist requires verified ownership with and without SMTP",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "vardum-organization-test-"));
    const data = join(root, "data");
    const pgBin = process.env.PG_BINDIR ?? "/usr/bin";
    const cleanEnv = { PATH: process.env.PATH, LANG: "C" };
    let started = false;
    let admin: Pool | undefined;
    t.after(async () => {
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
    const connection = (user: string) =>
      `postgresql://${user}@localhost/postgres?host=${encodeURIComponent(root)}`;
    admin = new Pool({ connectionString: connection("postgres") });
    await migrate(drizzle(admin), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    await admin.query(
      "CREATE ROLE fixture_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE",
    );
    await admin.query("GRANT USAGE ON SCHEMA public TO fixture_auth");
    await admin.query(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO fixture_auth",
    );
    await admin.query(
      "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO fixture_auth",
    );

    for (const smtp of ["enabled", "disabled"]) {
      await t.test(
        `real signup, policy and verification flow: SMTP ${smtp}`,
        async () => {
          // A new process avoids leaking auth configuration between the two cases.
          const result = await execFile(
            process.execPath,
            [
              "--import",
              "tsx",
              fileURLToPath(
                new URL(
                  "./organization-verification.fixture.ts",
                  import.meta.url,
                ),
              ),
            ],
            {
              cwd: fileURLToPath(new URL("../../../", import.meta.url)),
              env: {
                ...cleanEnv,
                NODE_ENV: "test",
                DATABASE_URL: connection("fixture_auth"),
                BETTER_AUTH_URL: "http://localhost:3000",
                WEB_URL: "http://localhost:3000",
                BETTER_AUTH_SECRET:
                  "isolated-organization-auth-secret-at-least-32-characters",
                TRANSFORM_SECRET:
                  "isolated-organization-transform-secret-at-least-32-characters",
                ORGANIZATION_CREATION: "allowlist",
                ORGANIZATION_CREATOR_EMAILS: `owner-${smtp}@example.com`,
                ...(smtp === "enabled"
                  ? {
                      SMTP_HOST: "fixture.invalid",
                      SMTP_FROM: "test@example.com",
                    }
                  : {}),
                VARDUM_TEST_SMTP: smtp,
                AWS_EC2_METADATA_DISABLED: "true",
              },
              timeout: 30_000,
            },
          );
          assert.match(
            result.stdout,
            /Organization verification checks passed/,
          );
        },
      );
    }
  },
);
