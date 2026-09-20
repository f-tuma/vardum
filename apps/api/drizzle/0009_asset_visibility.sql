ALTER TABLE "asset" ADD COLUMN "is_public" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "is_public" SET DEFAULT false;
--> statement-breakpoint
UPDATE "apikey"
SET "rate_limit_max" = 10000, "rate_limit_time_window" = 60000
WHERE "config_id" = 'workspace'
  AND "enabled" = true
  AND "rate_limit_enabled" = true
  AND "rate_limit_max" = 10
  AND "rate_limit_time_window" = 86400000;
