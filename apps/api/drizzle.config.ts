import { defineConfig } from "drizzle-kit";

// drizzle-kit is not launched through `node --env-file`, the way the dev server
// is, so the root .env has to be read here or DATABASE_URL stays unset and the
// fallback below points at the wrong port. An ambient DATABASE_URL still wins,
// which is what production and CI pass in.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile("../../.env");
  } catch {
    // No .env next to the repo root — use the ambient environment.
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/auth-schema.ts", "./src/db/app-schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? "postgres://varda:varda@localhost:5432/varda",
  },
});
