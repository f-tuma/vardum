import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, db, pool } from "./db/index.js";
import { config } from "./config.js";
import { provisionRuntimeRole } from "./db/runtime-role.js";
import { migrateQueue } from "./queue-migrate.js";

try {
  const password = process.env.POSTGRES_APP_PASSWORD;
  if (!password)
    throw new Error(
      "POSTGRES_APP_PASSWORD is required to provision the runtime database role",
    );
  if (password === decodeURIComponent(new URL(config.DATABASE_URL).password)) {
    throw new Error(
      "POSTGRES_APP_PASSWORD must differ from the migration database password",
    );
  }
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await migrateQueue(config.DATABASE_URL);
  await provisionRuntimeRole(pool, password);
} finally {
  await closeDatabase();
}
