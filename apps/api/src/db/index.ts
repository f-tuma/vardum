import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as appSchema from "./app-schema.js";
import * as authSchema from "./auth-schema.js";

export const schema = { ...authSchema, ...appSchema };
const pool = new Pool({ connectionString: config.DATABASE_URL });
export const db = drizzle(pool, { schema });
