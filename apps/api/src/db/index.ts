import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as appSchema from "./app-schema.js";
import * as authSchema from "./auth-schema.js";

export const schema = { ...authSchema, ...appSchema };
export const pool = new Pool({ connectionString: config.DATABASE_URL });
// pg removes failed idle clients itself, but an unhandled pool error would
// terminate the process before health probes can report a database outage.
pool.on("error", () => {
  console.warn(JSON.stringify({ event: "database.connection_lost" }));
});
export const db = drizzle(pool, { schema });
let closing: Promise<void> | undefined;

export function closeDatabase() {
  closing ??= pool.end();
  return closing;
}
