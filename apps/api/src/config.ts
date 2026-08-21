import { z } from "zod";

const developmentSecret = "development-only-secret-change-in-production";

const schema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z
      .url()
      .default("postgres://varda:varda@localhost:5432/varda"),
    BETTER_AUTH_SECRET: z.string().min(32).default(developmentSecret),
    TRANSFORM_SECRET: z.string().min(32).default(developmentSecret),
    BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
    WEB_URL: z.url().default("http://localhost:5173"),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().min(3).default("varda"),
    S3_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .refine(
    ({ NODE_ENV, BETTER_AUTH_SECRET }) =>
      NODE_ENV !== "production" || BETTER_AUTH_SECRET !== developmentSecret,
    {
      message: "BETTER_AUTH_SECRET must be set in production",
      path: ["BETTER_AUTH_SECRET"],
    },
  )
  .refine(
    ({ NODE_ENV, TRANSFORM_SECRET }) =>
      NODE_ENV !== "production" || TRANSFORM_SECRET !== developmentSecret,
    {
      message: "TRANSFORM_SECRET must be set in production",
      path: ["TRANSFORM_SECRET"],
    },
  )
  .refine(
    ({ S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY }) =>
      Boolean(S3_ACCESS_KEY_ID) === Boolean(S3_SECRET_ACCESS_KEY),
    {
      message: "S3 access key and secret must be provided together",
      path: ["S3_ACCESS_KEY_ID"],
    },
  );

export const parseConfig = (environment: NodeJS.ProcessEnv) =>
  schema.parse(environment);
export const config = parseConfig(process.env);
