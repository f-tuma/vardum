import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function migrateQueue(connectionString: string) {
  // The CLI performs synchronous migrations, including concurrent index builds,
  // without starting a privileged worker that could execute stored BAM commands.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("pg-boss/dist/cli.js")),
      "migrate",
      "--schema",
      "pgboss",
    ],
    {
      env: { ...process.env, PGBOSS_DATABASE_URL: connectionString },
    },
  );
  process.stdout.write(stdout);
}
