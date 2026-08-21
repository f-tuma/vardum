import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { config } from "./config.js";
import { db, schema } from "./db/index.js";
import { access, roles } from "./permissions.js";

export const auth = betterAuth({
  appName: "Vardum",
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [
    config.WEB_URL,
    ...(config.NODE_ENV === "development" ? ["https://vite.f-tuma.dev"] : []),
  ],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  plugins: [
    organization({
      ac: access,
      roles,
      creatorRole: "owner",
    }),
    apiKey([
      {
        configId: "workspace",
        defaultPrefix: "varda_",
        references: "organization",
      },
    ]),
  ],
});
