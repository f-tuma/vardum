ALTER TABLE "asset_version" ADD COLUMN "ingest_job_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_version" ADD COLUMN "ingest_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_version" ADD COLUMN "retryable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "asset_version_processing_idx" ON "asset_version" USING btree ("workspace_id","id") WHERE "asset_version"."status" = 'processing';