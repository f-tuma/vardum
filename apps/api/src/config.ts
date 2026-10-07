import { z } from "zod";

const developmentSecret = "development-only-secret-change-in-production";
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
// Compose emits optional environment keys as empty strings. AWS uses the SDK's
// regional endpoint when these are unset; keep rejecting malformed nonempty URLs.
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional(),
);

const schema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    WORKER_HEALTH_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(3001),
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
    MONITORING_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .min(32)
        .max(256)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    ),
    CUSTOM_DOMAIN_TARGET: optionalString,
    ORGANIZATION_CREATION: z
      .enum(["open", "allowlist", "disabled"])
      .default("disabled"),
    ORGANIZATION_CREATOR_EMAILS: z.string().default(""),
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    SMTP_FROM: optionalString.refine(
      (value) => !value || !/[\r\n]/.test(value),
      {
        message: "SMTP_FROM cannot contain line breaks",
      },
    ),
    // Per-kind upload ceilings, in MiB. Files are the future generic kind:
    // anything that is neither an image nor a video falls under it.
    UPLOAD_MAX_IMAGE_MB: z.coerce.number().int().min(1).default(25),
    UPLOAD_MAX_VIDEO_MB: z.coerce.number().int().min(1).default(200),
    UPLOAD_MAX_FILE_MB: z.coerce.number().int().min(1).default(100),
    WORKSPACE_STORAGE_MB: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000_000)
      .default(10_240),
    WORKSPACE_PENDING_UPLOADS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(100),
    UPLOAD_PENDING_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    API_MAX_INFLIGHT: z.coerce.number().int().min(1).max(10_000).default(128),
    DELIVERY_MAX_INFLIGHT: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(64),
    DELIVERY_REQUESTS_PER_SECOND: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(100),
    TRANSFORM_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    TRANSFORM_QUEUE_LIMIT: z.coerce.number().int().min(0).max(128).default(8),
    TRANSFORM_MAX_OUTPUT_PIXELS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .default(16_000_000),
    TRANSFORM_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(120)
      .default(15),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().min(3).default("varda"),
    S3_ENDPOINT: optionalUrl,
    S3_PUBLIC_ENDPOINT: optionalUrl,
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
    ({ SMTP_USER, SMTP_PASSWORD }) =>
      Boolean(SMTP_USER) === Boolean(SMTP_PASSWORD),
    {
      message: "SMTP user and password must be provided together",
      path: ["SMTP_USER"],
    },
  )
  .refine(({ SMTP_HOST, SMTP_FROM }) => !SMTP_HOST || Boolean(SMTP_FROM), {
    message: "SMTP_FROM is required when SMTP_HOST is set",
    path: ["SMTP_FROM"],
  })
  .refine(({ SMTP_PORT, SMTP_SECURE }) => SMTP_PORT !== 465 || SMTP_SECURE, {
    message:
      "Port 465 speaks TLS from the first byte — set SMTP_SECURE=true (or use 587)",
    path: ["SMTP_SECURE"],
  })
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
